import { describe, expect, it, vi } from 'vitest';
import type { PushStreamEvent } from './provider-contract.js';
import {
  OPENROUTER_FALLBACK_EVENTS,
  isCommittedResponsesEvent,
  isOpenRouterRoutingConstraintBody,
  isOpenRouterRoutingConstraintError,
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

// The verbatim body OpenRouter returns when `provider.require_parameters` cannot be
// satisfied — captured from a push-gate log of a real `anthropic/claude-sonnet-4` 404.
const OPENROUTER_404_BODY =
  '{"error":{"message":"No endpoints found that can handle the requested parameters. To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection","code":404}}';

// Each lane wraps that body differently. These are the exact shapes the production
// code constructs — a predicate that matches a hand-written string but not these
// would be dead code in every lane that actually throws.
const WEB_LANE_ERROR = `OpenRouter 404: ${JSON.parse(OPENROUTER_404_BODY).error.message}`;
const WORKER_LANE_ERROR = `Provider openrouter returned 404: ${OPENROUTER_404_BODY.slice(0, 200)}`;
const CLI_LANE_ERROR = `Provider error 404 [provider=openrouter model=anthropic/claude-sonnet-4 url=https://openrouter.ai/api/v1/responses]: ${OPENROUTER_404_BODY.slice(0, 400)}`;

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

  it('declines the fallback on a flagged routing-constraint error', async () => {
    const chat = vi.fn(() => from([{ type: 'text_delta', text: 'CHAT' }]));
    const flagged = Object.assign(new Error(WEB_LANE_ERROR), {
      openRouterRoutingConstraint: true,
    });
    const stream = streamResponsesWithChatFallback({
      responses: () => throwsAfter([], flagged),
      chat,
      shouldFallback: (error) => !isOpenRouterRoutingConstraintError(error),
    });
    await expect(collect(stream)).rejects.toThrow('No endpoints found');
    // Chat recomputes the identical constraint, so it is never built.
    expect(chat).not.toHaveBeenCalled();
  });

  it('STILL falls back when the same message arrives unflagged', async () => {
    // The regression this predicate must not cause: without `require_parameters`,
    // "no endpoints found" means the model has no /responses endpoint — exactly the
    // beta gap chat is meant to rescue. The Worker lane only ever produces this shape.
    const chat = vi.fn(() => from([{ type: 'text_delta', text: 'from chat' }, DONE]));
    const out = await collect(
      streamResponsesWithChatFallback({
        responses: () => throwsAfter([], new Error(WORKER_LANE_ERROR)),
        chat,
        shouldFallback: (error) => !isOpenRouterRoutingConstraintError(error),
      }),
    );
    expect(out).toEqual([{ type: 'text_delta', text: 'from chat' }, DONE]);
    expect(chat).toHaveBeenCalledOnce();
  });
});

describe('isOpenRouterRoutingConstraintBody', () => {
  it('matches the body each lane actually receives', () => {
    // web — `parseProviderError` extracts `error.message`, dropping the JSON envelope.
    expect(isOpenRouterRoutingConstraintBody(WEB_LANE_ERROR)).toBe(true);
    // worker — raw body truncated to 200 chars. The marker ends near char 81, so it
    // survives; this pins that boundary rather than assuming it.
    expect(isOpenRouterRoutingConstraintBody(WORKER_LANE_ERROR)).toBe(true);
    expect(WORKER_LANE_ERROR).toContain('requested parameters');
    // CLI — raw body truncated to 400 chars behind a longer prefix.
    expect(isOpenRouterRoutingConstraintBody(CLI_LANE_ERROR)).toBe(true);
    expect(isOpenRouterRoutingConstraintBody(OPENROUTER_404_BODY)).toBe(true);
    expect(
      isOpenRouterRoutingConstraintBody(
        'NO ENDPOINTS FOUND THAT CAN HANDLE THE REQUESTED PARAMETERS',
      ),
    ).toBe(true);
  });

  it('stays narrow', () => {
    // The chat leg's own 404 — a server-tool failure, not a routing-constraint claim.
    expect(isOpenRouterRoutingConstraintBody('Server tool request failed')).toBe(false);
    expect(isOpenRouterRoutingConstraintBody('rate limited')).toBe(false);
    expect(isOpenRouterRoutingConstraintBody('No endpoints found')).toBe(false);
  });
});

describe('isOpenRouterRoutingConstraintError', () => {
  it('reads the producer flag structurally, never the message', () => {
    expect(
      isOpenRouterRoutingConstraintError(
        Object.assign(new Error('anything at all'), { openRouterRoutingConstraint: true }),
      ),
    ).toBe(true);
    // Duck-typed: `lib/` must not need each lane's error class.
    expect(isOpenRouterRoutingConstraintError({ openRouterRoutingConstraint: true })).toBe(true);
  });

  it('does NOT decline on a matching message without the flag', () => {
    // The core regression guard. Every lane string below contains the marker phrase;
    // none carries the flag, because the request never pinned `require_parameters`.
    // Message-matching alone would strand recoverable turns.
    expect(isOpenRouterRoutingConstraintError(new Error(WEB_LANE_ERROR))).toBe(false);
    expect(isOpenRouterRoutingConstraintError(new Error(WORKER_LANE_ERROR))).toBe(false);
    expect(isOpenRouterRoutingConstraintError(new Error(CLI_LANE_ERROR))).toBe(false);
    expect(isOpenRouterRoutingConstraintError(OPENROUTER_404_BODY)).toBe(false);
  });

  it('treats an explicit false and a missing flag alike', () => {
    expect(
      isOpenRouterRoutingConstraintError(
        Object.assign(new Error(WEB_LANE_ERROR), { openRouterRoutingConstraint: false }),
      ),
    ).toBe(false);
    expect(isOpenRouterRoutingConstraintError(undefined)).toBe(false);
    expect(isOpenRouterRoutingConstraintError(null)).toBe(false);
    expect(isOpenRouterRoutingConstraintError('a bare string')).toBe(false);
  });
});

describe('OPENROUTER_FALLBACK_EVENTS', () => {
  it('pins the cross-surface event vocabulary', () => {
    // One canonical definition for web, Worker and CLI. Renaming a literal in a single
    // emitter can no longer leave that surface silently unmatched by log consumers.
    expect(OPENROUTER_FALLBACK_EVENTS).toEqual({
      fellBackToChat: 'openrouter_responses_fallback_to_chat',
      declined: 'openrouter_responses_fallback_declined',
    });
  });
});
