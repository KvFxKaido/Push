/**
 * Daemon provider-stream factory tests.
 *
 * The daemon uses `createDaemonProviderStream` to build the `PushStream`
 * that agent roles (explorer / coder / reviewer / auditor / planner)
 * consume. This file proves the factory dispatches by `streamShape` —
 * regression cover for the bug three reviewers caught on #584 where
 * `createDaemonProviderStream` was hardcoded to the OpenAI-compat adapter
 * and would have posted OpenAI Chat bodies to the Anthropic Messages
 * endpoint (and to the Gemini base URL) for non-OpenAI providers.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDaemonProviderStream } from '../daemon-provider-stream.ts';

const ANTHROPIC_TEST_KEY = 'ANTHROPIC_API_KEY';
const GOOGLE_TEST_KEY = 'GOOGLE_API_KEY';

function stringToStream(s) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(encoder.encode(s));
      c.close();
    },
  });
}

async function collect(iter) {
  const out = [];
  for await (const e of iter) out.push(e);
  return out;
}

function captureFetch(sse) {
  const calls = [];
  return {
    calls,
    handler: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        body: stringToStream(sse),
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        text: async () => sse,
      };
    },
  };
}

let originalFetch;
let originalAnthropicKey;
let originalGoogleKey;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalAnthropicKey = process.env[ANTHROPIC_TEST_KEY];
  originalGoogleKey = process.env[GOOGLE_TEST_KEY];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalAnthropicKey === undefined) delete process.env[ANTHROPIC_TEST_KEY];
  else process.env[ANTHROPIC_TEST_KEY] = originalAnthropicKey;
  if (originalGoogleKey === undefined) delete process.env[GOOGLE_TEST_KEY];
  else process.env[GOOGLE_TEST_KEY] = originalGoogleKey;
});

describe('createDaemonProviderStream', () => {
  it('throws synchronously for an unknown provider', () => {
    assert.throws(
      () => createDaemonProviderStream('not-a-real-provider'),
      /not configured in PROVIDER_CONFIGS/,
    );
  });

  it('routes anthropic through the native Messages-API adapter (x-api-key + translated body)', async () => {
    process.env[ANTHROPIC_TEST_KEY] = 'sk-ant-test';
    const sse = [
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ].join('');
    const { calls, handler } = captureFetch(sse);
    globalThis.fetch = handler;

    const stream = createDaemonProviderStream('anthropic');
    await collect(
      stream({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
      }),
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
    assert.equal(calls[0].init.headers['x-api-key'], 'sk-ant-test');
    assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01');
    // Body was translated — OpenAI's bare-string content is now a block array.
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'hi' }]);
  });

  it('routes google through the native Gemini adapter (model in URL + x-goog-api-key + translated body)', async () => {
    process.env[GOOGLE_TEST_KEY] = 'AIza-test';
    const sse = `data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    })}\n\n`;
    const { calls, handler } = captureFetch(sse);
    globalThis.fetch = handler;

    const stream = createDaemonProviderStream('google');
    await collect(
      stream({
        provider: 'google',
        model: 'gemini-3.1-pro-preview',
        messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
      }),
    );

    assert.equal(calls.length, 1);
    assert.match(
      calls[0].url,
      /generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.1-pro-preview:streamGenerateContent\?alt=sse$/,
    );
    assert.equal(calls[0].init.headers['x-goog-api-key'], 'AIza-test');
    // OpenAI-shaped `messages` MUST NOT appear; Gemini's `contents` MUST.
    const body = JSON.parse(calls[0].init.body);
    assert.equal('messages' in body, false);
    assert.ok(Array.isArray(body.contents));
    assert.equal(body.contents[0].role, 'user');
  });
});
