import { describe, expect, it, vi } from 'vitest';
import type { PushStreamEvent } from './provider-contract.js';
import {
  isCommittedResponsesEvent,
  streamResponsesWithChatFallback,
} from './responses-chat-fallback.js';

async function* from(events: PushStreamEvent[]): AsyncIterable<PushStreamEvent> {
  for (const e of events) yield e;
}

async function* throwsAfter(
  events: PushStreamEvent[],
  error: unknown,
): AsyncIterable<PushStreamEvent> {
  for (const e of events) yield e;
  throw error;
}

async function collect(stream: AsyncIterable<PushStreamEvent>): Promise<PushStreamEvent[]> {
  const out: PushStreamEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

const DONE: PushStreamEvent = { type: 'done', finishReason: 'stop' };

describe('isCommittedResponsesEvent', () => {
  it('treats visible/actionable output as committed, terminal/noise as not', () => {
    expect(isCommittedResponsesEvent({ type: 'text_delta', text: 'hi' })).toBe(true);
    expect(isCommittedResponsesEvent({ type: 'reasoning_delta', text: 'x' })).toBe(true);
    expect(
      isCommittedResponsesEvent({ type: 'native_tool_call', call: { name: 'f', args: {} } }),
    ).toBe(true);
    // Tool-argument fragments are internal progress markers. Until the assembled
    // `native_tool_call` appears, the consumer has nothing visible or actionable.
    expect(isCommittedResponsesEvent({ type: 'tool_call_delta' })).toBe(false);
    expect(
      isCommittedResponsesEvent({
        type: 'responses_reasoning_item',
        item: { type: 'reasoning', encrypted_content: 'ciphertext' },
      }),
    ).toBe(true);
    // `done` must NOT commit — an empty success is not a transport failure to retry.
    expect(isCommittedResponsesEvent(DONE)).toBe(false);
    expect(isCommittedResponsesEvent({ type: 'ephemeral', text: 'status' })).toBe(false);
  });
});

describe('streamResponsesWithChatFallback', () => {
  it('passes the responses stream through untouched on success (chat never built)', async () => {
    const chat = vi.fn(() => from([{ type: 'text_delta', text: 'CHAT' }]));
    const out = await collect(
      streamResponsesWithChatFallback({
        responses: () => from([{ type: 'text_delta', text: 'hello' }, DONE]),
        chat,
      }),
    );
    expect(out).toEqual([{ type: 'text_delta', text: 'hello' }, DONE]);
    expect(chat).not.toHaveBeenCalled();
  });

  it('falls back to chat when responses fails BEFORE any output', async () => {
    const onFallback = vi.fn();
    const out = await collect(
      streamResponsesWithChatFallback({
        responses: () => throwsAfter([], new Error('400 provider returned error')),
        chat: () => from([{ type: 'text_delta', text: 'from chat' }, DONE]),
        onFallback,
      }),
    );
    // Only the chat events reach the consumer — the failed responses attempt is invisible.
    expect(out).toEqual([{ type: 'text_delta', text: 'from chat' }, DONE]);
    expect(onFallback).toHaveBeenCalledOnce();
  });

  it('falls back after an internal tool fragment but before an assembled call', async () => {
    const out = await collect(
      streamResponsesWithChatFallback({
        responses: () =>
          throwsAfter([{ type: 'tool_call_delta' }], new Error('tool stream interrupted')),
        chat: () => from([{ type: 'text_delta', text: 'recovered' }, DONE]),
      }),
    );

    expect(out).toEqual([
      { type: 'tool_call_delta' },
      { type: 'text_delta', text: 'recovered' },
      DONE,
    ]);
  });

  it('does NOT fall back once output has started — the error propagates', async () => {
    const chat = vi.fn(() => from([{ type: 'text_delta', text: 'CHAT' }]));
    const stream = streamResponsesWithChatFallback({
      responses: () =>
        throwsAfter([{ type: 'text_delta', text: 'partial' }], new Error('mid-stream')),
      chat,
    });
    const seen: PushStreamEvent[] = [];
    await expect(async () => {
      for await (const e of stream) seen.push(e);
    }).rejects.toThrow('mid-stream');
    // The partial output was delivered; chat was never invoked (can't un-send).
    expect(seen).toEqual([{ type: 'text_delta', text: 'partial' }]);
    expect(chat).not.toHaveBeenCalled();
  });

  it('respects shouldFallback=false and propagates even a pre-output error', async () => {
    const chat = vi.fn(() => from([{ type: 'text_delta', text: 'CHAT' }]));
    const stream = streamResponsesWithChatFallback({
      responses: () => throwsAfter([], new Error('401 unauthorized')),
      chat,
      shouldFallback: () => false, // auth error — chat would reject it too
    });
    await expect(collect(stream)).rejects.toThrow('401 unauthorized');
    expect(chat).not.toHaveBeenCalled();
  });

  it('does not fall back on an empty-but-successful response (done only)', async () => {
    const chat = vi.fn(() => from([{ type: 'text_delta', text: 'CHAT' }]));
    const out = await collect(
      streamResponsesWithChatFallback({ responses: () => from([DONE]), chat }),
    );
    expect(out).toEqual([DONE]);
    expect(chat).not.toHaveBeenCalled();
  });
});
