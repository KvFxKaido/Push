/**
 * CLI prompt-caching opt-in at `createProviderStream`.
 *
 * The provider contract reads `cacheBreakpointIndices: undefined` as "caller
 * did not opt in", and no CLI caller computes the indices, so the CLI never
 * cached until `createProviderStream` started opting in for every request.
 * These tests drive that real boundary per provider shape, plus the adapter
 * on its own to pin that it still honors the contract.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderStream, PROVIDER_CONFIGS } from '../provider.ts';
import { createCliAnthropicStream } from '../anthropic-stream.ts';

const ANTHROPIC_SSE = [
  `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } })}\n\n`,
  `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
].join('');
const OPENAI_SSE = [
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
  'data: [DONE]\n\n',
].join('');

function captureFetch(sse) {
  const calls = [];
  const handler = async (url, init) => {
    calls.push({ url, init });
    const encoder = new TextEncoder();
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode(sse));
          c.close();
        },
      }),
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      text: async () => sse,
    };
  };
  return { calls, handler };
}

async function drain(events) {
  for await (const _ of events) {
    // consume
  }
}

const conversation = [
  { id: '1', role: 'user', content: 'Hi', timestamp: 0 },
  { id: '2', role: 'assistant', content: 'Hello', timestamp: 0 },
  { id: '3', role: 'user', content: 'More', timestamp: 0 },
  { id: '4', role: 'assistant', content: 'Sure', timestamp: 0 },
  { id: '5', role: 'user', content: 'Again', timestamp: 0 },
];

const taggedFlags = (messages) =>
  messages.map((m) => Array.isArray(m.content) && m.content.some((p) => p.cache_control));

let originalFetch;
let originalTransport;
beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalTransport = process.env.PUSH_OPENROUTER_TRANSPORT;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalTransport === undefined) delete process.env.PUSH_OPENROUTER_TRANSPORT;
  else process.env.PUSH_OPENROUTER_TRANSPORT = originalTransport;
});

describe('createProviderStream prompt-caching opt-in', () => {
  for (const id of ['anthropic', 'deepseek']) {
    it(`tags the system prompt and rolling tail for ${id} when the caller supplies no indices`, async () => {
      // deepseek shares the Anthropic adapter (streamShape: 'anthropic'); its
      // endpoint accepts cache_control (verified live 2026-10-24).
      const { calls, handler } = captureFetch(ANTHROPIC_SSE);
      globalThis.fetch = handler;

      await drain(
        createProviderStream(
          PROVIDER_CONFIGS[id],
          'sk',
        )({
          provider: id,
          model: PROVIDER_CONFIGS[id].defaultModel,
          systemPromptOverride: 'Be terse.',
          messages: conversation,
        }),
      );

      const body = JSON.parse(calls[0].init.body);
      assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
      assert.deepEqual(taggedFlags(body.messages), [false, false, true, true, true]);
    });
  }

  it('tags OpenRouter chat requests, whose adapter was built to cache but never got indices', async () => {
    process.env.PUSH_OPENROUTER_TRANSPORT = 'chat';
    const { calls, handler } = captureFetch(OPENAI_SSE);
    globalThis.fetch = handler;

    await drain(
      createProviderStream(
        PROVIDER_CONFIGS.openrouter,
        'sk',
      )({
        provider: 'openrouter',
        model: 'anthropic/claude-haiku-4.5',
        systemPromptOverride: 'Be terse.',
        messages: conversation,
      }),
    );

    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.messages[0].role, 'system');
    assert.deepEqual(taggedFlags(body.messages), [true, false, false, true, true, true]);
  });

  it('passes an explicit empty array through as an opt-out', async () => {
    const { calls, handler } = captureFetch(ANTHROPIC_SSE);
    globalThis.fetch = handler;

    await drain(
      createProviderStream(
        PROVIDER_CONFIGS.anthropic,
        'sk',
      )({
        provider: 'anthropic',
        model: 'claude-haiku-5-5',
        systemPromptOverride: 'Be terse.',
        messages: conversation,
        cacheBreakpointIndices: [],
      }),
    );

    assert.equal(calls[0].init.body.includes('cache_control'), false);
  });

  it('leaves the adapter itself on the contract: undefined indices stay untagged', async () => {
    const { calls, handler } = captureFetch(ANTHROPIC_SSE);
    globalThis.fetch = handler;

    await drain(
      createCliAnthropicStream(
        PROVIDER_CONFIGS.anthropic,
        'sk',
      )({
        provider: 'anthropic',
        model: 'claude-haiku-5-5',
        systemPromptOverride: 'Be terse.',
        messages: conversation,
      }),
    );

    assert.equal(calls[0].init.body.includes('cache_control'), false);
  });
});
