/**
 * CLI Google Gemini adapter tests.
 *
 * Pins URL construction (model in the path + ?alt=sse), auth header,
 * OpenAI→Gemini body translation, error surfacing, and the override
 * behavior when `config.url` is pre-baked to a full :streamGenerateContent
 * endpoint. The bridge itself is covered in `lib/openai-gemini-bridge.test.ts`.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildGeminiUpstreamUrl, createCliGeminiStream } from '../gemini-stream.ts';
import { CliProviderError } from '../openai-stream.ts';

const GEMINI_CONFIG = {
  id: 'google',
  url: 'https://generativelanguage.googleapis.com/v1beta',
  defaultModel: 'gemini-3.1-pro-preview',
  apiKeyEnv: ['GOOGLE_API_KEY'],
  requiresKey: true,
  streamShape: 'gemini',
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

function captureFetch() {
  const calls = [];
  const handler = async (url, init) => {
    calls.push({ url, init });
    const sse = `data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
    })}\n\n`;
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

describe('buildGeminiUpstreamUrl', () => {
  it('appends /models/{model}:streamGenerateContent?alt=sse onto the v1beta base', () => {
    const url = buildGeminiUpstreamUrl(
      'https://generativelanguage.googleapis.com/v1beta',
      'gemini-3.1-pro-preview',
    );
    assert.equal(
      url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse',
    );
  });

  it('URL-encodes the model id', () => {
    const url = buildGeminiUpstreamUrl(
      'https://generativelanguage.googleapis.com/v1beta',
      'gemini/with/slashes',
    );
    assert.match(url, /\/models\/gemini%2Fwith%2Fslashes:streamGenerateContent\?alt=sse$/);
  });

  it('trims a trailing slash off the base URL', () => {
    const url = buildGeminiUpstreamUrl(
      'https://generativelanguage.googleapis.com/v1beta/',
      'gemini-2.5-pro',
    );
    assert.equal(
      url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse',
    );
  });

  it('uses a pre-baked :streamGenerateContent URL untouched (override path)', () => {
    const baked =
      'https://regional-mirror.example/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse&extra=1';
    assert.equal(buildGeminiUpstreamUrl(baked, 'ignored'), baked);
  });
});

describe('createCliGeminiStream', () => {
  it('posts to the constructed streamGenerateContent URL with x-goog-api-key', async () => {
    const { calls, handler } = captureFetch();
    globalThis.fetch = handler;

    const stream = createCliGeminiStream(GEMINI_CONFIG, 'AIza-test');
    await collect(
      stream({
        provider: 'google',
        model: 'gemini-3.1-pro-preview',
        messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
      }),
    );

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse',
    );
    const headers = calls[0].init.headers;
    assert.equal(headers['x-goog-api-key'], 'AIza-test');
    assert.equal(headers['Content-Type'], 'application/json');
  });

  it('omits x-goog-api-key when apiKey is empty', async () => {
    const { calls, handler } = captureFetch();
    globalThis.fetch = handler;

    const stream = createCliGeminiStream(GEMINI_CONFIG, '');
    await collect(
      stream({
        provider: 'google',
        model: 'gemini-3.1-pro-preview',
        messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
      }),
    );

    assert.equal(calls[0].init.headers['x-goog-api-key'], undefined);
  });

  it('translates OpenAI-shaped messages into Gemini contents + systemInstruction', async () => {
    const { calls, handler } = captureFetch();
    globalThis.fetch = handler;

    const stream = createCliGeminiStream(GEMINI_CONFIG, 'AIza');
    await collect(
      stream({
        provider: 'google',
        model: 'gemini-3.1-pro-preview',
        systemPromptOverride: 'Be concise.',
        messages: [
          { id: '1', role: 'user', content: 'Hi', timestamp: 0 },
          { id: '2', role: 'assistant', content: 'Hello', timestamp: 0 },
          { id: '3', role: 'user', content: 'More', timestamp: 0 },
        ],
      }),
    );

    const body = JSON.parse(calls[0].init.body);
    // Gemini-specific wire shape:
    assert.deepEqual(body.systemInstruction, { parts: [{ text: 'Be concise.' }] });
    assert.ok(Array.isArray(body.contents));
    assert.equal(body.contents[0].role, 'user');
    assert.equal(body.contents[1].role, 'model'); // <-- assistant renamed
    assert.equal(body.contents[2].role, 'user');
    // OpenAI's `messages` / `system` / `model` fields MUST NOT leak through:
    assert.equal('messages' in body, false);
    assert.equal('system' in body, false);
    assert.equal('model' in body, false);
  });

  it('falls back to config.defaultModel when req.model is empty', async () => {
    const { calls, handler } = captureFetch();
    globalThis.fetch = handler;

    const stream = createCliGeminiStream(GEMINI_CONFIG, 'AIza');
    await collect(
      stream({
        provider: 'google',
        model: '',
        messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
      }),
    );

    // Model name should be in the URL path, not the body.
    assert.match(calls[0].url, /models\/gemini-3\.1-pro-preview:streamGenerateContent/);
  });

  it('throws CliProviderError with the upstream status on non-2xx', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      body: stringToStream(''),
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => '{"error":{"code":400,"message":"API key not valid"}}',
    });

    const stream = createCliGeminiStream(GEMINI_CONFIG, 'AIza');
    let caught;
    try {
      await collect(
        stream({
          provider: 'google',
          model: 'gemini-3.1-pro-preview',
          messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
        }),
      );
    } catch (e) {
      caught = e;
    }

    assert.ok(caught instanceof CliProviderError, 'expected CliProviderError');
    assert.equal(caught.status, 400);
    assert.match(caught.message, /provider=google/);
    assert.match(caught.message, /API key not valid/);
  });
});
