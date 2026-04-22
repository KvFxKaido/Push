import { describe, it, expect, vi } from 'vitest';
import type {
  LlmMessage,
  PushStream,
  PushStreamEvent,
  StreamUsage,
  AIProviderType,
} from './provider-contract.js';
import { createProviderStreamAdapter } from './provider-contract.js';

describe('createProviderStreamAdapter', () => {
  const messages: LlmMessage[] = [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }];
  const provider: AIProviderType = 'openrouter';
  const testOptions = { defaultModel: 'test-model' };

  it('maps text_delta events to onToken', async () => {
    const events: PushStreamEvent[] = [
      { type: 'text_delta', text: 'hello' },
      { type: 'text_delta', text: ' world' },
    ];
    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      for (const e of events) yield e;
    });

    const adapted = createProviderStreamAdapter(stream, provider, testOptions);
    const tokens: string[] = [];
    await adapted(
      messages,
      (t) => tokens.push(t),
      () => {},
      () => {},
    );
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

    const adapted = createProviderStreamAdapter(stream, provider, testOptions);
    const thoughts: (string | null)[] = [];
    await adapted(
      messages,
      () => {},
      () => {},
      () => {},
      (t) => thoughts.push(t),
    );
    expect(thoughts).toEqual(['thinking...', ' still thinking']);
  });

  it('maps reasoning_end events to onThinkingToken(null)', async () => {
    const events: PushStreamEvent[] = [
      { type: 'reasoning_delta', text: 'thinking' },
      { type: 'reasoning_end' },
      { type: 'text_delta', text: 'answer' },
      { type: 'done', finishReason: 'stop' },
    ];
    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      for (const e of events) yield e;
    });

    const adapted = createProviderStreamAdapter(stream, provider, testOptions);
    const thoughts: (string | null)[] = [];
    const tokens: string[] = [];
    await adapted(
      messages,
      (t) => tokens.push(t),
      () => {},
      () => {},
      (t) => thoughts.push(t),
    );
    // The end-of-reasoning signal is `null`, matching the legacy callback contract.
    expect(thoughts).toEqual(['thinking', null]);
    expect(tokens).toEqual(['answer']);
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

    const adapted = createProviderStreamAdapter(stream, provider, testOptions);
    let receivedUsage: StreamUsage | undefined;
    await adapted(
      messages,
      () => {},
      (u) => {
        receivedUsage = u;
      },
      () => {},
    );
    expect(receivedUsage).toEqual(usage);
  });

  it('calls onError when the gateway stream throws', async () => {
    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      throw new Error('network failure');
    });

    const adapted = createProviderStreamAdapter(stream, provider, testOptions);
    let caught: Error | undefined;
    await adapted(
      messages,
      () => {},
      () => {},
      (e) => {
        caught = e;
      },
    );
    expect(caught?.message).toBe('network failure');
  });

  it('calls onError when neither modelOverride nor defaultModel is provided', async () => {
    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      yield { type: 'text_delta', text: 'should not run' };
    });

    const adapted = createProviderStreamAdapter(stream, provider);
    let caught: Error | undefined;
    await adapted(
      messages,
      () => {},
      () => {},
      (e) => {
        caught = e;
      },
    );
    expect(caught?.message).toMatch(/no model provided/i);
    expect(stream).not.toHaveBeenCalled();
  });

  it('returns early and calls onDone when signal is aborted before start', async () => {
    const controller = new AbortController();
    controller.abort();

    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      yield { type: 'text_delta', text: 'should not run' };
    });

    const adapted = createProviderStreamAdapter(stream, provider, testOptions);
    let caught: Error | undefined;
    const onDone = vi.fn();
    await adapted(
      messages,
      () => {},
      onDone,
      (e) => {
        caught = e;
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      controller.signal,
    );

    expect(caught).toBeUndefined();
    expect(onDone).toHaveBeenCalled();
    expect(stream).not.toHaveBeenCalled();
  });

  it('aborts mid-stream when signal fires and calls onDone', async () => {
    const controller = new AbortController();
    const tokens: string[] = [];
    let aborted = false;
    const onDone = vi.fn();
    const stream: PushStream = vi.fn().mockImplementation(async function* () {
      yield { type: 'text_delta', text: 'a' };
      controller.abort();
      aborted = true;
      yield { type: 'text_delta', text: 'b' };
      yield { type: 'text_delta', text: 'c' };
    });

    const adapted = createProviderStreamAdapter(stream, provider, testOptions);
    await adapted(
      messages,
      (t) => tokens.push(t),
      onDone,
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      controller.signal,
    );

    expect(tokens).toEqual(['a']);
    expect(aborted).toBe(true);
    expect(onDone).toHaveBeenCalled();
  });

  it('passes systemPromptOverride and scratchpadContent to gateway', async () => {
    let captured: any;
    const stream: PushStream = vi.fn().mockImplementation(async function* (req) {
      captured = req;
      yield { type: 'done', finishReason: 'stop' };
    });

    const adapted = createProviderStreamAdapter(stream, provider, testOptions);
    await adapted(
      messages,
      () => {},
      () => {},
      () => {},
      undefined,
      undefined,
      undefined,
      undefined,
      'system-override',
      'scratch-content',
    );

    expect(captured.systemPromptOverride).toBe('system-override');
    expect(captured.scratchpadContent).toBe('scratch-content');
  });

  it('uses defaultModel from options when no override is present', async () => {
    let capturedModel = '';
    const stream: PushStream = vi.fn().mockImplementation(async function* (req) {
      capturedModel = req.model;
      yield { type: 'done', finishReason: 'stop' };
    });

    const adapted = createProviderStreamAdapter(stream, provider, {
      defaultModel: 'fallback-model',
    });
    await adapted(
      messages,
      () => {},
      () => {},
      () => {},
    );

    expect(capturedModel).toBe('fallback-model');
  });

  it('prioritizes modelOverride over defaultModel', async () => {
    let capturedModel = '';
    const stream: PushStream = vi.fn().mockImplementation(async function* (req) {
      capturedModel = req.model;
      yield { type: 'done', finishReason: 'stop' };
    });

    const adapted = createProviderStreamAdapter(stream, provider, {
      defaultModel: 'fallback-model',
    });
    await adapted(
      messages,
      () => {},
      () => {},
      () => {},
      undefined,
      undefined,
      undefined,
      'primary-model',
    );

    expect(capturedModel).toBe('primary-model');
  });
});
