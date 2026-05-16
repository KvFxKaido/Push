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

  it('forwards reasoning_blocks on assistant turns so signed thinking round-trips', async () => {
    const { calls, handler } = captureFetch();
    globalThis.fetch = handler;

    const stream = createCliAnthropicStream(ANTHROPIC_CONFIG, 'sk');
    await collect(
      stream({
        provider: 'anthropic',
        model: 'claude-opus-4-7',
        messages: [
          { id: '1', role: 'user', content: 'Why is the sky blue?', timestamp: 0 },
          {
            id: '2',
            role: 'assistant',
            content: 'Rayleigh scattering.',
            timestamp: 0,
            reasoningBlocks: [
              { type: 'thinking', text: 'Recall optics.', signature: 'sig-abc' },
              { type: 'redacted_thinking', data: 'enc-xyz' },
            ],
          },
          { id: '3', role: 'user', content: 'More', timestamp: 0 },
        ],
      }),
    );

    const body = JSON.parse(calls[0].init.body);
    // The bridge prepends reasoning blocks BEFORE text/tool_use entries
    // in the assistant content[]. Without this, Anthropic rejects the
    // turn with `invalid_request_error` when extended thinking + tool
    // use are combined.
    const assistantTurn = body.messages[1];
    assert.equal(assistantTurn.role, 'assistant');
    assert.ok(Array.isArray(assistantTurn.content));
    assert.deepEqual(assistantTurn.content[0], {
      type: 'thinking',
      thinking: 'Recall optics.',
      signature: 'sig-abc',
    });
    assert.deepEqual(assistantTurn.content[1], {
      type: 'redacted_thinking',
      data: 'enc-xyz',
    });
    // Text entry follows the reasoning blocks.
    assert.equal(assistantTurn.content[2].type, 'text');
    assert.equal(assistantTurn.content[2].text, 'Rayleigh scattering.');
  });

  it('omits the reasoning_blocks field entirely when none are present', async () => {
    const { calls, handler } = captureFetch();
    globalThis.fetch = handler;

    const stream = createCliAnthropicStream(ANTHROPIC_CONFIG, 'sk');
    await collect(
      stream({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        messages: [
          { id: '1', role: 'user', content: 'Hi', timestamp: 0 },
          { id: '2', role: 'assistant', content: 'Hello', timestamp: 0 },
        ],
      }),
    );

    const body = JSON.parse(calls[0].init.body);
    const assistantTurn = body.messages[1];
    // Plain text content, no thinking prefix — proves the empty array
    // isn't propagating through the bridge as an empty reasoning prefix
    // that would shift the indices.
    assert.equal(assistantTurn.content.length, 1);
    assert.equal(assistantTurn.content[0].type, 'text');
  });

  it('tags the system message with cache_control when cacheBreakpointIndices is set', async () => {
    const { calls, handler } = captureFetch();
    globalThis.fetch = handler;

    const stream = createCliAnthropicStream(ANTHROPIC_CONFIG, 'sk');
    await collect(
      stream({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        systemPromptOverride: 'Be terse.',
        messages: [
          { id: '1', role: 'user', content: 'Hi', timestamp: 0 },
          { id: '2', role: 'assistant', content: 'Hello', timestamp: 0 },
          { id: '3', role: 'user', content: 'More', timestamp: 0 },
        ],
        // Wire-side `system_and_3`: tag system + last user turn.
        cacheBreakpointIndices: [2],
      }),
    );

    const body = JSON.parse(calls[0].init.body);
    // System was hoisted into a block array by the bridge so the
    // cache_control marker had somewhere to ride. Confirm it survived.
    assert.ok(Array.isArray(body.system));
    assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
    // Tail-tagged user turn (request index 2 + systemPrependOffset 1 = wire index 3).
    const lastUser = body.messages[body.messages.length - 1];
    assert.equal(lastUser.role, 'user');
    assert.deepEqual(lastUser.content[0].cache_control, { type: 'ephemeral' });
  });

  it('caps cache_control tagging at MAX_ROLLING_CACHE_BREAKPOINTS when too many indices are supplied', async () => {
    const { calls, handler } = captureFetch();
    globalThis.fetch = handler;

    const stream = createCliAnthropicStream(ANTHROPIC_CONFIG, 'sk');
    // Build 6 user turns and ask for cache markers on all 6 — Anthropic's
    // per-request cap is 4 (system + 3), so the wire layer must drop the
    // oldest indices and keep the most recent 3 tail entries.
    const messages = [];
    for (let i = 0; i < 6; i++) {
      messages.push({ id: `${i}`, role: 'user', content: `q${i}`, timestamp: 0 });
    }
    await collect(
      stream({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        systemPromptOverride: 'sys',
        messages,
        cacheBreakpointIndices: [0, 1, 2, 3, 4, 5],
      }),
    );

    const body = JSON.parse(calls[0].init.body);
    // System always tagged + at most 3 message-level tags = 4 total markers.
    const messageTags = body.messages.filter(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.cache_control),
    );
    assert.equal(messageTags.length, 3);
    // The three tagged messages should be the LAST three (request indices
    // 3, 4, 5 → wire indices 4, 5, 6), not the first three.
    assert.equal(body.messages[body.messages.length - 1].content[0].text, 'q5');
    assert.deepEqual(body.messages[body.messages.length - 1].content[0].cache_control, {
      type: 'ephemeral',
    });
    assert.deepEqual(body.messages[body.messages.length - 2].content[0].cache_control, {
      type: 'ephemeral',
    });
    assert.deepEqual(body.messages[body.messages.length - 3].content[0].cache_control, {
      type: 'ephemeral',
    });
    // The fourth-from-last must NOT be tagged.
    const fourthFromLast = body.messages[body.messages.length - 4];
    if (Array.isArray(fourthFromLast.content)) {
      assert.equal(fourthFromLast.content[0].cache_control, undefined);
    }
  });

  it('does not tag any messages when cacheBreakpointIndices is empty or absent', async () => {
    const { calls, handler } = captureFetch();
    globalThis.fetch = handler;

    const stream = createCliAnthropicStream(ANTHROPIC_CONFIG, 'sk');
    await collect(
      stream({
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        systemPromptOverride: 'sys',
        messages: [{ id: '1', role: 'user', content: 'hi', timestamp: 0 }],
        cacheBreakpointIndices: [],
      }),
    );

    const body = JSON.parse(calls[0].init.body);
    // System hoisted as a plain string (no marker → flattened form).
    assert.equal(body.system, 'sys');
    // No cache_control on any message content.
    for (const m of body.messages) {
      if (Array.isArray(m.content)) {
        for (const part of m.content) {
          assert.equal(part.cache_control, undefined);
        }
      }
    }
  });
});
