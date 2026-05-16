import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveApiKey,
  getProviderList,
  streamCompletion,
  PROVIDER_CONFIGS,
  DEFAULT_TIMEOUT_MS,
  MAX_RETRIES,
} from '../provider.ts';
import { createCliProviderStream } from '../openai-stream.ts';

// ─── Env helper ─────────────────────────────────────────────────

/**
 * Temporarily set env vars, returns a restore function.
 * Pass `undefined` to delete a var.
 */
function withEnv(overrides) {
  const originals = {};
  for (const [key, value] of Object.entries(overrides)) {
    originals[key] = process.env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return function restore() {
    for (const [key] of Object.entries(overrides)) {
      if (originals[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originals[key];
      }
    }
  };
}

// ─── resolveApiKey ──────────────────────────────────────────────

describe('resolveApiKey', () => {
  it('returns first non-empty env var from apiKeyEnv list', () => {
    const restore = withEnv({
      TEST_KEY_A: '',
      TEST_KEY_B: 'secret-b',
      TEST_KEY_C: 'secret-c',
    });
    try {
      const config = {
        id: 'test',
        url: 'http://localhost',
        defaultModel: 'model',
        apiKeyEnv: ['TEST_KEY_A', 'TEST_KEY_B', 'TEST_KEY_C'],
        requiresKey: true,
      };
      assert.equal(resolveApiKey(config), 'secret-b');
    } finally {
      restore();
    }
  });

  it('trims whitespace from env var values', () => {
    const restore = withEnv({ TEST_KEY_WS: '  my-key  ' });
    try {
      const config = {
        id: 'test',
        url: 'http://localhost',
        defaultModel: 'model',
        apiKeyEnv: ['TEST_KEY_WS'],
        requiresKey: true,
      };
      assert.equal(resolveApiKey(config), 'my-key');
    } finally {
      restore();
    }
  });

  it('skips whitespace-only values', () => {
    const restore = withEnv({
      TEST_KEY_BLANK: '   ',
      TEST_KEY_REAL: 'actual-key',
    });
    try {
      const config = {
        id: 'test',
        url: 'http://localhost',
        defaultModel: 'model',
        apiKeyEnv: ['TEST_KEY_BLANK', 'TEST_KEY_REAL'],
        requiresKey: true,
      };
      assert.equal(resolveApiKey(config), 'actual-key');
    } finally {
      restore();
    }
  });

  it('throws when requiresKey is true and no key is found', () => {
    const restore = withEnv({
      TEST_KEY_MISSING_A: undefined,
      TEST_KEY_MISSING_B: undefined,
    });
    try {
      const config = {
        id: 'testprov',
        url: 'http://localhost',
        defaultModel: 'model',
        apiKeyEnv: ['TEST_KEY_MISSING_A', 'TEST_KEY_MISSING_B'],
        requiresKey: true,
      };
      assert.throws(
        () => resolveApiKey(config),
        (err) => {
          assert.ok(err.message.includes('Missing API key'));
          assert.ok(err.message.includes('testprov'));
          assert.ok(err.message.includes('TEST_KEY_MISSING_A'));
          return true;
        },
      );
    } finally {
      restore();
    }
  });

  it('returns empty string when requiresKey is false and no key found', () => {
    const restore = withEnv({
      TEST_KEY_OPT_A: undefined,
    });
    try {
      const config = {
        id: 'test',
        url: 'http://localhost',
        defaultModel: 'model',
        apiKeyEnv: ['TEST_KEY_OPT_A'],
        requiresKey: false,
      };
      assert.equal(resolveApiKey(config), '');
    } finally {
      restore();
    }
  });

  it('uses priority order (first env var wins)', () => {
    const restore = withEnv({
      TEST_KEY_FIRST: 'first',
      TEST_KEY_SECOND: 'second',
    });
    try {
      const config = {
        id: 'test',
        url: 'http://localhost',
        defaultModel: 'model',
        apiKeyEnv: ['TEST_KEY_FIRST', 'TEST_KEY_SECOND'],
        requiresKey: true,
      };
      assert.equal(resolveApiKey(config), 'first');
    } finally {
      restore();
    }
  });
});

// ─── getProviderList ────────────────────────────────────────────

describe('getProviderList', () => {
  it('returns an array with an entry for every PROVIDER_CONFIGS key', () => {
    const list = getProviderList();
    const configIds = Object.keys(PROVIDER_CONFIGS).sort();
    const listIds = list.map((e) => e.id).sort();
    assert.deepEqual(listIds, configIds);
  });

  it('each entry has the correct shape', () => {
    const list = getProviderList();
    for (const entry of list) {
      assert.equal(typeof entry.id, 'string');
      assert.equal(typeof entry.url, 'string');
      assert.equal(typeof entry.defaultModel, 'string');
      assert.equal(typeof entry.requiresKey, 'boolean');
      assert.equal(typeof entry.hasKey, 'boolean');
    }
  });

  it('hasKey is true when env var is set for a provider', () => {
    const cfg = PROVIDER_CONFIGS.ollama;
    const envKey = cfg.apiKeyEnv[0];
    const restore = withEnv({ [envKey]: 'test-key-for-list' });
    try {
      const list = getProviderList();
      const entry = list.find((e) => e.id === 'ollama');
      assert.ok(entry);
      assert.equal(entry.hasKey, true);
    } finally {
      restore();
    }
  });

  it('hasKey is false when no env vars are set for a provider', () => {
    const cfg = PROVIDER_CONFIGS.ollama;
    const envOverrides = {};
    for (const key of cfg.apiKeyEnv) {
      envOverrides[key] = undefined;
    }
    const restore = withEnv(envOverrides);
    try {
      const list = getProviderList();
      const entry = list.find((e) => e.id === 'ollama');
      assert.ok(entry);
      assert.equal(entry.hasKey, false);
    } finally {
      restore();
    }
  });
});

// ─── streamCompletion ───────────────────────────────────────────

describe('streamCompletion', () => {
  const testConfig = {
    id: 'testprov',
    url: 'http://test.invalid/v1/chat/completions',
    defaultModel: 'test-model',
    apiKeyEnv: ['TEST_STREAM_KEY'],
    requiresKey: false,
  };
  const testMessages = [{ role: 'user', content: 'hello' }];

  /** Build an SSE body string from an array of token strings. */
  function buildSSE(tokens) {
    let body = '';
    for (const token of tokens) {
      body += `data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`;
    }
    body += 'data: [DONE]\n\n';
    return body;
  }

  /** Build an SSE body that mixes native `reasoning_content` deltas with content. */
  function buildSSEWithReasoning(reasoningTokens, contentTokens) {
    let body = '';
    for (const token of reasoningTokens) {
      body += `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: token } }] })}\n\n`;
    }
    for (const token of contentTokens) {
      body += `data: ${JSON.stringify({ choices: [{ delta: { content: token } }] })}\n\n`;
    }
    body += 'data: [DONE]\n\n';
    return body;
  }

  /** Create a ReadableStream from a string. */
  function stringToStream(str) {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(str));
        controller.close();
      },
    });
  }

  /** Create a mock fetch that returns a successful SSE stream. */
  function mockFetchSSE(sseBody) {
    return async () => ({
      ok: true,
      status: 200,
      body: stringToStream(sseBody),
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      text: async () => sseBody,
      json: async () => ({}),
    });
  }

  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('accumulates tokens from SSE stream and returns full text', async () => {
    const sseBody = buildSSE(['Hello', ' ', 'world']);
    globalThis.fetch = mockFetchSSE(sseBody);

    const tokens = [];
    const result = await streamCompletion(testConfig, 'test-key', 'test-model', testMessages, (t) =>
      tokens.push(t),
    );

    assert.equal(result, 'Hello world');
    assert.deepEqual(tokens, ['Hello', ' ', 'world']);
  });

  it('handles [DONE] sentinel correctly', async () => {
    const sseBody = buildSSE(['done-test']);
    globalThis.fetch = mockFetchSSE(sseBody);

    const result = await streamCompletion(testConfig, 'key', 'model', testMessages, null);
    assert.equal(result, 'done-test');
  });

  it('silently skips malformed SSE chunks', async () => {
    let body = '';
    body += `data: ${JSON.stringify({ choices: [{ delta: { content: 'good' } }] })}\n\n`;
    body += `data: {not valid json\n\n`;
    body += `data: ${JSON.stringify({ choices: [{ delta: { content: ' stuff' } }] })}\n\n`;
    body += `data: [DONE]\n\n`;

    globalThis.fetch = mockFetchSSE(body);

    const result = await streamCompletion(testConfig, 'key', 'model', testMessages, null);
    assert.equal(result, 'good stuff');
  });

  it('skips lines that do not start with data:', async () => {
    let body = '';
    body += `event: message\n`;
    body += `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`;
    body += `: comment line\n`;
    body += `data: [DONE]\n\n`;

    globalThis.fetch = mockFetchSSE(body);

    const result = await streamCompletion(testConfig, 'key', 'model', testMessages, null);
    assert.equal(result, 'ok');
  });

  it('falls back to JSON when response.body is null', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      body: null,
      headers: new Headers(),
      text: async () => '',
      json: async () => ({
        choices: [{ message: { content: 'fallback content' } }],
      }),
    });

    const result = await streamCompletion(testConfig, 'key', 'model', testMessages, null);
    assert.equal(result, 'fallback content');
  });

  it('returns empty string when response.body is null and JSON has no content', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      body: null,
      headers: new Headers(),
      text: async () => '',
      json: async () => ({}),
    });

    const result = await streamCompletion(testConfig, 'key', 'model', testMessages, null);
    assert.equal(result, '');
  });

  it('returns empty string when response.body is null and JSON parse fails', async () => {
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      body: null,
      headers: new Headers(),
      text: async () => '',
      json: async () => {
        throw new Error('parse error');
      },
    });

    const result = await streamCompletion(testConfig, 'key', 'model', testMessages, null);
    assert.equal(result, '');
  });

  describe('retry behavior', () => {
    it('retries on 429 status', async () => {
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        if (attempts < 3) {
          return {
            ok: false,
            status: 429,
            body: null,
            headers: new Headers(),
            text: async () => 'rate limited',
            json: async () => ({}),
          };
        }
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildSSE(['success'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      const result = await streamCompletion(
        testConfig,
        'key',
        'model',
        testMessages,
        null,
        DEFAULT_TIMEOUT_MS,
      );
      assert.equal(result, 'success');
      assert.equal(attempts, 3);
    });

    it('retries on 500 status', async () => {
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        if (attempts < 2) {
          return {
            ok: false,
            status: 500,
            body: null,
            headers: new Headers(),
            text: async () => 'server error',
            json: async () => ({}),
          };
        }
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildSSE(['ok'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      const result = await streamCompletion(testConfig, 'key', 'model', testMessages, null);
      assert.equal(result, 'ok');
      assert.equal(attempts, 2);
    });

    it('does NOT retry on 4xx (non-429)', async () => {
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        return {
          ok: false,
          status: 401,
          body: null,
          headers: new Headers(),
          text: async () => 'unauthorized',
          json: async () => ({}),
        };
      };

      await assert.rejects(
        () => streamCompletion(testConfig, 'key', 'model', testMessages, null),
        (err) => {
          assert.ok(err.message.includes('401'));
          return true;
        },
      );
      assert.equal(attempts, 1);
    });

    it('throws after MAX_RETRIES exhausted', async () => {
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        return {
          ok: false,
          status: 502,
          body: null,
          headers: new Headers(),
          text: async () => 'bad gateway',
          json: async () => ({}),
        };
      };

      await assert.rejects(
        () => streamCompletion(testConfig, 'key', 'model', testMessages, null),
        (err) => {
          assert.ok(err.message.includes('502'));
          return true;
        },
      );
      assert.equal(attempts, MAX_RETRIES);
    });

    it('retries on network error (no response)', async () => {
      let attempts = 0;
      globalThis.fetch = async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('ECONNREFUSED');
        }
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildSSE(['recovered'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      const result = await streamCompletion(testConfig, 'key', 'model', testMessages, null);
      assert.equal(result, 'recovered');
      assert.equal(attempts, 3);
    });
  });

  describe('abort handling', () => {
    it('throws AbortError when external signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      globalThis.fetch = async () => {
        throw new Error('should not be called');
      };

      await assert.rejects(
        () =>
          streamCompletion(
            testConfig,
            'key',
            'model',
            testMessages,
            null,
            DEFAULT_TIMEOUT_MS,
            controller.signal,
          ),
        (err) => {
          assert.equal(err.name, 'AbortError');
          assert.ok(err.message.includes('aborted'));
          return true;
        },
      );
    });

    it('throws timeout error when request times out', async () => {
      globalThis.fetch = async () => {
        // Simulate a long-running request that gets aborted by timeout
        const abortErr = new DOMException('The operation was aborted', 'AbortError');
        throw abortErr;
      };

      await assert.rejects(
        () =>
          streamCompletion(
            testConfig,
            'key',
            'model',
            testMessages,
            null,
            50, // very short timeout
            null,
          ),
        (err) => {
          assert.ok(err.message.includes('timed out'));
          return true;
        },
      );
    });

    it('throws AbortError when external signal fires mid-request', async () => {
      const controller = new AbortController();

      globalThis.fetch = async () => {
        // Abort during the fetch
        controller.abort();
        const abortErr = new DOMException('The operation was aborted', 'AbortError');
        throw abortErr;
      };

      await assert.rejects(
        () =>
          streamCompletion(
            testConfig,
            'key',
            'model',
            testMessages,
            null,
            DEFAULT_TIMEOUT_MS,
            controller.signal,
          ),
        (err) => {
          assert.equal(err.name, 'AbortError');
          return true;
        },
      );
    });

    // Regression: the shared SSE pump returns cleanly (no throw) when its
    // signal aborts mid-read, so naive iteration would fall through to a
    // truncated `return accumulated`. streamCompletion must observe the
    // abort and translate it into AbortError (or timeout) instead.
    it('throws AbortError when external signal fires after streaming starts', async () => {
      const controller = new AbortController();
      let streamController;
      const body = new ReadableStream({
        start(c) {
          streamController = c;
        },
      });
      const encoder = new TextEncoder();

      globalThis.fetch = async (_url, opts) => {
        // Forward abort to the body stream so the pump's signal-abort branch
        // observes it and returns cleanly. This mimics what real fetch does
        // with the request signal.
        opts.signal?.addEventListener(
          'abort',
          () => {
            try {
              streamController.close();
            } catch {
              /* already closed */
            }
          },
          { once: true },
        );
        return {
          ok: true,
          status: 200,
          body,
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      const tokens = [];
      const promise = streamCompletion(
        testConfig,
        'key',
        'model',
        testMessages,
        (t) => tokens.push(t),
        DEFAULT_TIMEOUT_MS,
        controller.signal,
      );

      // Yield a single token to start streaming, then abort the external
      // signal. The pump sees `signal.aborted` on its next read and returns.
      await new Promise((r) => setTimeout(r, 5));
      streamController.enqueue(
        encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`),
      );
      await new Promise((r) => setTimeout(r, 5));
      controller.abort();

      await assert.rejects(promise, (err) => {
        assert.equal(err.name, 'AbortError');
        assert.ok(err.message.includes('aborted'));
        return true;
      });
      // The token that arrived before the abort is still observable to the
      // caller's onToken — we just don't return it as a successful result.
      assert.deepEqual(tokens, ['hi']);
    });

    it('throws timeout error when timer fires after streaming starts', async () => {
      let streamController;
      const body = new ReadableStream({
        start(c) {
          streamController = c;
        },
      });

      globalThis.fetch = async (_url, opts) => {
        opts.signal?.addEventListener(
          'abort',
          () => {
            try {
              streamController.close();
            } catch {
              /* already closed */
            }
          },
          { once: true },
        );
        return {
          ok: true,
          status: 200,
          body,
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      // 50ms timeout, never push any tokens — the timer fires while the
      // pump is parked on an empty read, the body stream closes, the pump
      // returns cleanly, and streamCompletion must surface "timed out".
      await assert.rejects(
        () => streamCompletion(testConfig, 'key', 'model', testMessages, null, 50, null),
        (err) => {
          assert.ok(err.message.includes('timed out'));
          return true;
        },
      );
    });
  });

  describe('OpenRouter-specific behavior', () => {
    const orConfig = {
      id: 'openrouter',
      url: 'http://test.invalid/v1/chat/completions',
      defaultModel: 'openrouter-model',
      apiKeyEnv: ['TEST_OR_KEY'],
      requiresKey: false,
    };

    it('sends HTTP-Referer and X-Title headers for openrouter', async () => {
      let capturedHeaders;
      globalThis.fetch = async (_url, opts) => {
        capturedHeaders = opts.headers;
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildSSE(['ok'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      await streamCompletion(orConfig, 'key', 'model', testMessages, null);

      assert.ok(capturedHeaders['HTTP-Referer']);
      assert.equal(capturedHeaders['X-Title'], 'Push CLI');
    });

    it('includes session_id in request body when provided', async () => {
      let capturedBody;
      globalThis.fetch = async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildSSE(['ok'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      await streamCompletion(
        orConfig,
        'key',
        'model',
        testMessages,
        null,
        DEFAULT_TIMEOUT_MS,
        null,
        { sessionId: 'sess-123' },
      );

      assert.equal(capturedBody.session_id, 'sess-123');
      assert.ok(capturedBody.trace);
      assert.equal(capturedBody.trace.generation_name, 'push-cli-chat');
    });

    it('does NOT include session_id for non-openrouter providers', async () => {
      let capturedBody;
      globalThis.fetch = async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildSSE(['ok'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      await streamCompletion(
        testConfig,
        'key',
        'model',
        testMessages,
        null,
        DEFAULT_TIMEOUT_MS,
        null,
        { sessionId: 'sess-123' },
      );

      assert.equal(capturedBody.session_id, undefined);
      assert.equal(capturedBody.trace, undefined);
    });

    it('truncates session_id to OPENROUTER_MAX_SESSION_ID_LENGTH', async () => {
      let capturedBody;
      globalThis.fetch = async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildSSE(['ok'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      const longSessionId = 'x'.repeat(500);
      await streamCompletion(
        orConfig,
        'key',
        'model',
        testMessages,
        null,
        DEFAULT_TIMEOUT_MS,
        null,
        { sessionId: longSessionId },
      );

      assert.ok(capturedBody.session_id.length <= 256);
    });

    // ─── Prompt caching (cacheBreakpointIndices: Hermes system_and_3) ─

    it('tags system + up to 3 rolling-tail messages with cache_control', async () => {
      let capturedBody;
      globalThis.fetch = async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildSSE(['ok'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      const messages = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'last' },
      ];
      await streamCompletion(orConfig, 'key', 'model', messages, null, DEFAULT_TIMEOUT_MS, null, {
        cacheBreakpointIndices: [1, 2, 3],
      });

      // 4 markers total: system + 3 tail entries. Anthropic's per-request cap.
      assert.deepEqual(capturedBody.messages[0], {
        role: 'system',
        content: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      });
      assert.deepEqual(capturedBody.messages[1], {
        role: 'user',
        content: [{ type: 'text', text: 'first', cache_control: { type: 'ephemeral' } }],
      });
      assert.deepEqual(capturedBody.messages[2], {
        role: 'assistant',
        content: [{ type: 'text', text: 'reply', cache_control: { type: 'ephemeral' } }],
      });
      assert.deepEqual(capturedBody.messages[3], {
        role: 'user',
        content: [{ type: 'text', text: 'last', cache_control: { type: 'ephemeral' } }],
      });

      // Drift-detector: no more than 4 markers total across the wire body.
      const markerCount = capturedBody.messages.filter(
        (m) => Array.isArray(m.content) && m.content.some((p) => p.cache_control),
      ).length;
      assert.ok(markerCount <= 4, `expected ≤ 4 cache markers, got ${markerCount}`);
    });

    it('tags only the indices passed when fewer than 3 are provided', async () => {
      let capturedBody;
      globalThis.fetch = async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildSSE(['ok'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      const messages = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'only-user' },
      ];
      await streamCompletion(orConfig, 'key', 'model', messages, null, DEFAULT_TIMEOUT_MS, null, {
        cacheBreakpointIndices: [1],
      });

      assert.deepEqual(capturedBody.messages[0], {
        role: 'system',
        content: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral' } }],
      });
      assert.deepEqual(capturedBody.messages[1], {
        role: 'user',
        content: [{ type: 'text', text: 'only-user', cache_control: { type: 'ephemeral' } }],
      });
    });

    it('does not tag when cacheBreakpointIndices is omitted', async () => {
      let capturedBody;
      globalThis.fetch = async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildSSE(['ok'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      const messages = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'first' },
      ];
      await streamCompletion(orConfig, 'key', 'model', messages, null);

      assert.equal(typeof capturedBody.messages[0].content, 'string');
      assert.equal(typeof capturedBody.messages[1].content, 'string');
    });

    it('does not tag when cacheBreakpointIndices is empty (system-only transcript)', async () => {
      let capturedBody;
      globalThis.fetch = async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildSSE(['ok'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      await streamCompletion(
        orConfig,
        'key',
        'model',
        [{ role: 'system', content: 'sys' }],
        null,
        DEFAULT_TIMEOUT_MS,
        null,
        { cacheBreakpointIndices: [] },
      );

      assert.equal(typeof capturedBody.messages[0].content, 'string');
    });

    // Exercises the lib-side agent-role path that calls createCliProviderStream
    // directly with a `systemPromptOverride`. The indices in `cacheBreakpointIndices`
    // are into `req.messages` (which excludes the synthesized system), so the
    // wire-side adapter must add `systemPrependOffset = 1` before tagging each.
    it('clamps to the last 3 indices when more than 3 are provided (defense in depth)', async () => {
      // The transformer caps emission at 3, but the provider contract is
      // exported and `createCliProviderStream` can be called directly by
      // future consumers. The wire layer must enforce the cap independently
      // so Anthropic's per-request limit of 4 markers (system + 3 tail) is
      // never exceeded even when the contract is violated upstream.
      let capturedBody;
      globalThis.fetch = async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildSSE(['ok'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      const messages = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'u2' },
        { role: 'assistant', content: 'a2' },
        { role: 'user', content: 'u3' },
      ];
      await streamCompletion(orConfig, 'key', 'model', messages, null, DEFAULT_TIMEOUT_MS, null, {
        // Caller passes 5 indices — the slice should keep only the last 3.
        cacheBreakpointIndices: [1, 2, 3, 4, 5],
      });

      const markerCount = capturedBody.messages.filter(
        (m) => Array.isArray(m.content) && m.content.some((p) => p.cache_control),
      ).length;
      assert.equal(
        markerCount,
        4,
        `expected 4 cache markers (system + 3 tail), got ${markerCount}`,
      );
      // The earlier indices (1, 2) must NOT be tagged — confirming the slice
      // kept the last 3, not the first 3.
      assert.equal(typeof capturedBody.messages[1].content, 'string');
      assert.equal(typeof capturedBody.messages[2].content, 'string');
      assert.ok(Array.isArray(capturedBody.messages[3].content));
      assert.ok(Array.isArray(capturedBody.messages[4].content));
      assert.ok(Array.isArray(capturedBody.messages[5].content));
    });

    it('tags wire-index 0 when no system message is present (user-first transcript)', async () => {
      // The defensive `wireIndex === 0` skip must only fire when index 0 is
      // actually a system message. A user-first transcript legitimately
      // includes index 0 in the rolling tail and would otherwise lose its
      // cache slot.
      let capturedBody;
      globalThis.fetch = async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildSSE(['ok'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      const messages = [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
      ];
      await streamCompletion(orConfig, 'key', 'model', messages, null, DEFAULT_TIMEOUT_MS, null, {
        cacheBreakpointIndices: [0, 1],
      });

      // Both indices tagged — no system at index 0 to skip.
      assert.ok(Array.isArray(capturedBody.messages[0].content));
      assert.deepEqual(capturedBody.messages[0].content[0].cache_control, { type: 'ephemeral' });
      assert.ok(Array.isArray(capturedBody.messages[1].content));
      assert.deepEqual(capturedBody.messages[1].content[0].cache_control, { type: 'ephemeral' });
    });

    it('applies systemPrependOffset to every breakpoint when systemPromptOverride is set', async () => {
      let capturedBody;
      globalThis.fetch = async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildSSE(['ok'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      const stream = createCliProviderStream(orConfig, 'key');
      const events = stream({
        provider: 'openrouter',
        model: 'model',
        messages: [
          { id: 'm0', role: 'user', content: 'first', timestamp: 0 },
          { id: 'm1', role: 'assistant', content: 'reply', timestamp: 0 },
          { id: 'm2', role: 'user', content: 'last', timestamp: 0 },
        ],
        systemPromptOverride: 'sys-from-override',
        // Indices 0..2 are into req.messages. With the synthesized system at
        // wire index 0, the tagged wire indices become 1..3.
        cacheBreakpointIndices: [0, 1, 2],
      });
      for await (const _ of events) {
        // drain
      }

      // Wire shape: [synth-system, user 'first', assistant 'reply', user 'last']
      assert.equal(capturedBody.messages.length, 4);
      assert.deepEqual(capturedBody.messages[0], {
        role: 'system',
        content: [
          { type: 'text', text: 'sys-from-override', cache_control: { type: 'ephemeral' } },
        ],
      });
      assert.deepEqual(capturedBody.messages[1], {
        role: 'user',
        content: [{ type: 'text', text: 'first', cache_control: { type: 'ephemeral' } }],
      });
      assert.deepEqual(capturedBody.messages[2], {
        role: 'assistant',
        content: [{ type: 'text', text: 'reply', cache_control: { type: 'ephemeral' } }],
      });
      assert.deepEqual(capturedBody.messages[3], {
        role: 'user',
        content: [{ type: 'text', text: 'last', cache_control: { type: 'ephemeral' } }],
      });
    });
  });

  describe('prompt caching gate (non-openrouter)', () => {
    it('does not tag cache_control for non-openrouter providers even when cacheBreakpointIndices is set', async () => {
      let capturedBody;
      globalThis.fetch = async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildSSE(['ok'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      const messages = [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'last' },
      ];
      await streamCompletion(testConfig, 'key', 'model', messages, null, DEFAULT_TIMEOUT_MS, null, {
        cacheBreakpointIndices: [1],
      });

      assert.equal(typeof capturedBody.messages[0].content, 'string');
      assert.equal(typeof capturedBody.messages[1].content, 'string');
    });
  });

  // The reasoning split itself is exhaustively tested in
  // `lib/reasoning-tokens.test.ts` (`normalizeReasoning`) and
  // `lib/openai-sse-pump.test.ts` (native `reasoning_content` parsing).
  // This block keeps a single integration test on `streamCompletion` so
  // `cli/engine.ts`'s `assistant_thinking_*` event path doesn't silently
  // regress if the wiring through the new gateway breaks.
  describe('reasoning token routing (integration)', () => {
    it('routes native reasoning_content deltas to onThinkingToken', async () => {
      const sseBody = buildSSEWithReasoning(['thinking...'], ['visible']);
      globalThis.fetch = mockFetchSSE(sseBody);

      const thinkTokens = [];
      const result = await streamCompletion(
        testConfig,
        'key',
        'model',
        testMessages,
        null,
        DEFAULT_TIMEOUT_MS,
        null,
        { onThinkingToken: (t) => thinkTokens.push(t) },
      );

      assert.equal(result, 'visible');
      const nonNull = thinkTokens.filter((t) => t !== null);
      assert.ok(nonNull.join('').includes('thinking...'));
    });

    it('routes inline <think> tags through onThinkingToken and excludes them from result', async () => {
      const sseBody = buildSSE(['<think>hidden</think>visible']);
      globalThis.fetch = mockFetchSSE(sseBody);

      const thinkTokens = [];
      const result = await streamCompletion(
        testConfig,
        'key',
        'model',
        testMessages,
        null,
        DEFAULT_TIMEOUT_MS,
        null,
        { onThinkingToken: (t) => thinkTokens.push(t) },
      );

      assert.equal(result, 'visible');
      const nonNull = thinkTokens.filter((t) => t !== null);
      assert.ok(nonNull.join('').includes('hidden'));
      // The `null` close signal is what cli/engine.ts uses to fire
      // `assistant_thinking_done` — assert the wiring still emits it.
      assert.ok(thinkTokens.includes(null));
    });
  });

  describe('request body', () => {
    it('sends correct base body fields', async () => {
      let capturedBody;
      globalThis.fetch = async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildSSE(['ok'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      await streamCompletion(
        testConfig,
        'key',
        'my-model',
        [{ role: 'user', content: 'hi' }],
        null,
      );

      assert.equal(capturedBody.model, 'my-model');
      assert.equal(capturedBody.stream, true);
      assert.equal(capturedBody.temperature, 0.1);
      assert.deepEqual(capturedBody.messages, [{ role: 'user', content: 'hi' }]);
    });

    it('sets Authorization header when apiKey is provided', async () => {
      let capturedHeaders;
      globalThis.fetch = async (_url, opts) => {
        capturedHeaders = opts.headers;
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildSSE(['ok'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      await streamCompletion(testConfig, 'my-secret', 'model', testMessages, null);

      assert.equal(capturedHeaders.Authorization, 'Bearer my-secret');
    });

    it('omits Authorization header when apiKey is empty', async () => {
      let capturedHeaders;
      globalThis.fetch = async (_url, opts) => {
        capturedHeaders = opts.headers;
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildSSE(['ok'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      await streamCompletion(testConfig, '', 'model', testMessages, null);

      assert.equal(capturedHeaders.Authorization, undefined);
    });
  });
});
