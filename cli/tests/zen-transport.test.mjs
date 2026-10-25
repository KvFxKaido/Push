// Standard Zen serves each model on exactly one endpoint and answers the others
// with `400 ModelProtocolUnsupported` (seen live 2026-10-25 for claude-haiku-5-5
// and gpt-6-luna on /chat/completions). Pins the shared table and drives the
// CLI's real stream boundary (`createProviderStream`) to check each model's
// request lands on its endpoint with its wire's auth.
import { strict as assert } from 'node:assert';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { getZenTransport } from '../../lib/zen-transport.ts';
import { createProviderStream, PROVIDER_CONFIGS } from '../provider.ts';

describe('getZenTransport', () => {
  it('maps standard-tier families to their documented endpoints', () => {
    assert.equal(getZenTransport('claude-sonnet-4-6'), 'anthropic');
    assert.equal(getZenTransport('claude-haiku-5-5'), 'anthropic');
    assert.equal(getZenTransport('qwen3.6-plus'), 'anthropic');
    assert.equal(getZenTransport('qwen3.8-max'), 'openai');
    assert.equal(getZenTransport('gpt-6-luna'), 'responses');
    assert.equal(getZenTransport('grok-4.7'), 'responses');
    assert.equal(getZenTransport('muse-spark-1.3'), 'responses');
    assert.equal(getZenTransport('deepseek-v4-pro'), 'openai');
    assert.equal(getZenTransport(''), 'openai');
  });

  it('defers to the Go table on the Go tier, where MiniMax is Messages', () => {
    assert.equal(getZenTransport('minimax-m3'), 'openai');
    assert.equal(getZenTransport('minimax-m3', { go: true }), 'anthropic');
    assert.equal(getZenTransport('claude-sonnet-4-6', { go: true }), 'openai');
  });
});

describe('CLI Zen stream routing', () => {
  let originalFetch;
  let calls;
  const originalUrl = process.env.PUSH_ZEN_URL;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    calls = [];
    // A 400 ends each stream immediately; only the request shape matters here.
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ error: { message: 'stop' } }), { status: 400 });
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.PUSH_ZEN_URL;
    else process.env.PUSH_ZEN_URL = originalUrl;
  });

  async function send(model) {
    const stream = createProviderStream(PROVIDER_CONFIGS.zen, 'zen-key');
    try {
      for await (const _ of stream({
        provider: 'zen',
        model,
        messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
      })) {
        // drain
      }
    } catch {
      // the stubbed 400
    }
    return calls.at(-1);
  }

  it('sends Claude to /messages with x-api-key', async () => {
    const call = await send('claude-sonnet-4-6');
    assert.equal(call.url, 'https://opencode.ai/zen/v1/messages');
    assert.equal(call.init.headers['x-api-key'], 'zen-key');
    assert.equal(JSON.parse(call.init.body).model, 'claude-sonnet-4-6');
  });

  it('sends GPT to /responses with a Responses body', async () => {
    const call = await send('gpt-6-luna');
    assert.equal(call.url, 'https://opencode.ai/zen/v1/responses');
    assert.ok(JSON.parse(call.init.body).input, 'expected a Responses `input` body');
  });

  it('keeps Chat Completions models on /chat/completions', async () => {
    const call = await send('deepseek-v4-pro');
    assert.equal(call.url, 'https://opencode.ai/zen/v1/chat/completions');
  });

  it('uses the Go table when PUSH_ZEN_URL points at the Go endpoint', async () => {
    process.env.PUSH_ZEN_URL = 'https://opencode.ai/zen/go/v1/chat/completions';
    const call = await send('minimax-m3');
    assert.equal(call.url, 'https://opencode.ai/zen/go/v1/messages');
  });
});
