/**
 * CLI Anthropic adapter tests.
 *
 * Pins the wire-level invariants: URL, auth headers, anthropic-version,
 * OpenAI→Anthropic body translation, and error surfacing. The bridge logic
 * itself is exercised in `lib/openai-anthropic-bridge.test.ts`; this suite
 * focuses on what the CLI adapter wraps around it.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createCliAnthropicStream } from '../anthropic-stream.ts';
import { CliProviderError } from '../openai-stream.ts';

const ANTHROPIC_CONFIG = {
  id: 'anthropic',
  url: 'https://api.anthropic.com/v1/messages',
  defaultModel: 'claude-sonnet-4-6',
  apiKeyEnv: ['ANTHROPIC_API_KEY'],
  requiresKey: true,
  streamShape: 'anthropic',
};

function stringToStream(s) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(s));
      controller.close();
    },
  });
}

/** Capture the request the adapter sent without actually hitting upstream. */
function captureFetch() {
  const calls = [];
  const handler = async (url, init) => {
    calls.push({ url, init });
    // Yield a single content_block_delta + message_stop so the translator
    // emits one text_delta and a `done`. Keeps the adapter from hanging.
    const sse = [
      `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ].join('');
    return {
      ok: true,
      status: 200,
      body: stringToStream(sse),
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      text: async () => sse,
    };
  };
  return { calls, handler };
}

async function collect(events) {
  const out = [];
  for await (const e of events) out.push(e);
  return out;
}

let originalFetch;
beforeEach(() => {
  originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('createCliAnthropicStream', () => {
  it('posts to api.anthropic.com/v1/messages with x-api-key + anthropic-version', async () => {
    const { calls, handler } = captureFetch();
    globalThis.fetch = handler;

    const stream = createCliAnthropicStream(ANTHROPIC_CONFIG, 'sk-ant-test');
    await collect(
      stream({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
      }),
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
    const headers = calls[0].init.headers;
    assert.equal(headers['x-api-key'], 'sk-ant-test');
    assert.equal(headers['anthropic-version'], '2023-06-01');
    assert.equal(headers['Content-Type'], 'application/json');
  });

  it('omits x-api-key when the apiKey is empty (keeps the request reproducible)', async () => {
    const { calls, handler } = captureFetch();
    globalThis.fetch = handler;

    const stream = createCliAnthropicStream(ANTHROPIC_CONFIG, '');
    await collect(
      stream({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
      }),
    );

    assert.equal(calls[0].init.headers['x-api-key'], undefined);
    assert.equal(calls[0].init.headers['anthropic-version'], '2023-06-01');
  });

  it('translates OpenAI-shaped messages into Anthropic body shape with model re-attached', async () => {
    const { calls, handler } = captureFetch();
    globalThis.fetch = handler;

    const stream = createCliAnthropicStream(ANTHROPIC_CONFIG, 'sk');
    await collect(
      stream({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        systemPromptOverride: 'Be terse.',
        messages: [
          { id: '1', role: 'user', content: 'Hi', timestamp: 0 },
          { id: '2', role: 'assistant', content: 'Hello', timestamp: 0 },
          { id: '3', role: 'user', content: 'More', timestamp: 0 },
        ],
      }),
    );

    const body = JSON.parse(calls[0].init.body);
    // Wire shape is Anthropic Messages API (not OpenAI Chat Completions).
    // Both shapes have top-level `messages` and `model`, so those alone
    // don't prove translation ran. The real translation markers:
    //   - `system` is hoisted to a top-level field (OpenAI keeps it as a
    //     `role: 'system'` entry inside messages[]).
    //   - String content is wrapped into `[{ type: 'text', text: ... }]`
    //     (OpenAI keeps it as a bare string).
    assert.equal(body.model, 'claude-opus-4-7');
    assert.equal(body.system, 'Be terse.');
    assert.ok(Array.isArray(body.messages));
    assert.equal(body.messages.length, 3);
    assert.equal(body.messages[0].role, 'user');
    assert.equal(body.messages[1].role, 'assistant');
    assert.equal(body.messages[2].role, 'user');
    // No `role: 'system'` entry inside messages — it MUST have been hoisted.
    assert.equal(
      body.messages.some((m) => m.role === 'system'),
      false,
    );
    // First user turn's content is the Anthropic block array, not a bare string.
    assert.deepEqual(body.messages[0].content, [{ type: 'text', text: 'Hi' }]);
  });

  it('falls back to config.defaultModel when req.model is empty', async () => {
    const { calls, handler } = captureFetch();
    globalThis.fetch = handler;

    const stream = createCliAnthropicStream(ANTHROPIC_CONFIG, 'sk');
    await collect(
      stream({
        provider: 'anthropic',
        model: '',
        messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
      }),
    );

    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, ANTHROPIC_CONFIG.defaultModel);
  });

  it('throws CliProviderError with the upstream status on non-2xx', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 401,
      body: stringToStream(''),
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => '{"error":{"type":"authentication_error","message":"invalid x-api-key"}}',
    });

    const stream = createCliAnthropicStream(ANTHROPIC_CONFIG, 'sk');
    let caught;
    try {
      await collect(
        stream({
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
        }),
      );
    } catch (e) {
      caught = e;
    }

    assert.ok(caught instanceof CliProviderError, 'expected CliProviderError');
    assert.equal(caught.status, 401);
    assert.match(caught.message, /provider=anthropic/);
    assert.match(caught.message, /invalid x-api-key/);
  });
});
