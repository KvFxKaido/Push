import { describe, it, expect, vi } from 'vitest';
import type { LlmMessage, PushStream, PushStreamEvent, StreamUsage, AIProviderType } from './provider-contract.js';
import { createProviderStreamAdapter } from './provider-contract.js';

describe('createProviderStreamAdapter', () => {
  const messages: LlmMessage[] = [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }];
  const provider: AIProviderType = 'openrouter';

  it('maps text_delta events to onToken', async () => {
    const events: PushStreamEvent[] = [
      { type: 'text_delta', text: 'hello' },
      { type: 'text_delta', text: ' world' },
    ];
    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      for (const e of events) yield e;
    });

    const adapted = createProviderStreamAdapter(stream, provider);
    const tokens: string[] = [];
    await adapted(messages, (t) => tokens.push(t), () => {}, () => {});
    expect(tokens).toEqual(['hello', ' world']);
  });

  it('maps reasoning_delta events to onThinkingToken', async () => {
    const events: PushStreamEvent[] = [
      { type: 'reasoning_delta', text: 'thinking...' },
      { type: 'reasoning_delta', text: ' still thinking' },
    ];
    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      for (const e of events) yield e;
    });

    const adapted = createProviderStreamAdapter(stream, provider);
    const thoughts: (string | null)[] = [];
    await adapted(messages, () => {}, () => {}, () => {}, (t) => thoughts.push(t));
    expect(thoughts).toEqual(['thinking...', ' still thinking']);
  });

  it('maps done event to onDone with usage', async () => {
    const usage: StreamUsage = { inputTokens: 10, outputTokens: 20, totalTokens: 30 };
    const events: PushStreamEvent[] = [
      { type: 'text_delta', text: 'ok' },
      { type: 'done', finishReason: 'stop', usage },
    ];
    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      for (const e of events) yield e;
    });

    const adapted = createProviderStreamAdapter(stream, provider);
    let receivedUsage: StreamUsage | undefined;
    await adapted(messages, () => {}, (u) => { receivedUsage = u; }, () => {});
    expect(receivedUsage).toEqual(usage);
  });

  it('calls onError when the gateway stream throws', async () => {
    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      throw new Error('network failure');
    });

    const adapted = createProviderStreamAdapter(stream, provider);
    let caught: Error | undefined;
    await adapted(messages, () => {}, () => {}, (e) => { caught = e; });
    expect(caught?.message).toBe('network failure');
  });

  it('returns early without onError when signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      throw new Error('should not be caught');
    });

    const adapted = createProviderStreamAdapter(stream, provider);
    let caught: Error | undefined;
    await adapted(messages, () => {}, () => {}, (e) => { caught = e; }, undefined, undefined, undefined, undefined, undefined, undefined, controller.signal);
    expect(caught).toBeUndefined();
  });

  it('aborts mid-stream when signal fires', async () => {
    const controller = new AbortController();
    const tokens: string[] = [];
    let aborted = false;
    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      yield { type: 'text_delta', text: 'a' };
      controller.abort();
      aborted = true;
      yield { type: 'text_delta', text: 'b' };
      yield { type: 'text_delta', text: 'c' };
    });

    const adapted = createProviderStreamAdapter(stream, provider);
    await adapted(messages, (t) => tokens.push(t), () => {}, () => {}, undefined, undefined, undefined, undefined, undefined, undefined, controller.signal);
    expect(tokens).toEqual(['a']);
    expect(aborted).toBe(true);
  });

  it('uses modelOverride as the model field', async () => {
    let receivedModel = '';
    const stream: PushStream = vi.fn().mockImplementation(async function* (req) {
      receivedModel = req.model;
    });

    const adapted = createProviderStreamAdapter(stream, provider);
    await adapted(messages, () => {}, () => {}, () => {}, undefined, undefined, undefined, 'gpt-4o', undefined, undefined);
    expect(receivedModel).toBe('gpt-4o');
  });
});
