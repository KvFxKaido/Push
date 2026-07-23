import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveApiKey,
  getProviderList,
  streamCompletion,
  createProviderStream,
  PROVIDER_CONFIGS,
  DEFAULT_TIMEOUT_MS,
  MAX_RETRIES,
} from '../provider.ts';
import { createCliProviderStream } from '../openai-stream.ts';
import { GEMINI_MISSING_THOUGHT_SIGNATURE_PLACEHOLDER } from '../../lib/gemini-thought-signature.ts';

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

// ─── live env resolution (url / defaultModel getters) ───────────

describe('PROVIDER_CONFIGS live env resolution', () => {
  // `url` and `defaultModel` must observe `process.env` at READ time, not
  // module-import time — pushd's `reload_config` verb mutates env on the
  // running daemon and the next request has to pick the new values up.
  // These pins are what keep a future refactor from quietly reverting the
  // getters to spawn-time snapshots (the #858 half-fix).
  it('url reflects an env change made after module import', () => {
    const restore = withEnv({ PUSH_ZEN_URL: undefined });
    try {
      const baseline = PROVIDER_CONFIGS.zen.url;
      process.env.PUSH_ZEN_URL = 'https://rotated.example/v1/chat/completions';
      assert.equal(PROVIDER_CONFIGS.zen.url, 'https://rotated.example/v1/chat/completions');
      delete process.env.PUSH_ZEN_URL;
      assert.equal(PROVIDER_CONFIGS.zen.url, baseline);
    } finally {
      restore();
    }
  });

  it('defaultModel reflects an env change made after module import', () => {
    const restore = withEnv({ PUSH_ZEN_MODEL: undefined });
    try {
      const baseline = PROVIDER_CONFIGS.zen.defaultModel;
      process.env.PUSH_ZEN_MODEL = 'rotated-model';
      assert.equal(PROVIDER_CONFIGS.zen.defaultModel, 'rotated-model');
      delete process.env.PUSH_ZEN_MODEL;
      assert.equal(PROVIDER_CONFIGS.zen.defaultModel, baseline);
    } finally {
      restore();
    }
  });

  it('reload_config end-to-end: reapplyProviderConfigToEnv lands in PROVIDER_CONFIGS', async () => {
    const { reapplyProviderConfigToEnv } = await import('../config-store.ts');
    const restore = withEnv({
      PUSH_OPENROUTER_URL: 'https://stale.example/v1/chat/completions',
      PUSH_OPENROUTER_MODEL: 'stale-model',
    });
    try {
      assert.equal(PROVIDER_CONFIGS.openrouter.url, 'https://stale.example/v1/chat/completions');
      const changed = reapplyProviderConfigToEnv({
        openrouter: {
          url: 'https://fresh.example/v1/chat/completions',
          model: 'fresh-model',
        },
      });
      assert.ok(changed.includes('PUSH_OPENROUTER_URL'));
      assert.ok(changed.includes('PUSH_OPENROUTER_MODEL'));
      assert.equal(PROVIDER_CONFIGS.openrouter.url, 'https://fresh.example/v1/chat/completions');
      assert.equal(PROVIDER_CONFIGS.openrouter.defaultModel, 'fresh-model');
    } finally {
      restore();
    }
  });

  it('every provider resolves url and defaultModel live, not from an import snapshot', () => {
    for (const [id, config] of Object.entries(PROVIDER_CONFIGS)) {
      const urlDesc = Object.getOwnPropertyDescriptor(config, 'url');
      const modelDesc = Object.getOwnPropertyDescriptor(config, 'defaultModel');
      assert.equal(typeof urlDesc?.get, 'function', `${id}.url must be a live getter`);
      assert.equal(typeof modelDesc?.get, 'function', `${id}.defaultModel must be a live getter`);
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

  function buildResponsesSSE(tokens) {
    let body = '';
    for (const token of tokens) {
      body += `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: token })}\n\n`;
    }
    body += `data: ${JSON.stringify({
      type: 'response.completed',
      response: { status: 'completed' },
    })}\n\n`;
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
    // These tests pin the Responses-path machinery independently of the
    // per-model capability decision. The explicit override chooses Responses as
    // the primary wire while retaining the pre-output Chat fallback.
    let prevTransport;
    beforeEach(() => {
      prevTransport = process.env.PUSH_OPENROUTER_TRANSPORT;
      process.env.PUSH_OPENROUTER_TRANSPORT = 'responses';
    });
    afterEach(() => {
      if (prevTransport === undefined) delete process.env.PUSH_OPENROUTER_TRANSPORT;
      else process.env.PUSH_OPENROUTER_TRANSPORT = prevTransport;
    });

    const orConfig = {
      id: 'openrouter',
      url: 'http://test.invalid/v1/responses',
      defaultModel: 'openrouter-model',
      apiKeyEnv: ['TEST_OR_KEY'],
      requiresKey: false,
      streamShape: 'openai-responses',
    };
    const orChatConfig = {
      ...orConfig,
      url: 'http://test.invalid/v1/chat/completions',
      streamShape: 'openai-compat',
    };
    const sampleTool = {
      name: 'read_file',
      description: 'Read a file',
      input_schema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
        additionalProperties: false,
      },
    };
    const responsesTool = {
      type: 'function',
      name: sampleTool.name,
      description: sampleTool.description,
      parameters: sampleTool.input_schema,
    };
    const openAIChatTool = {
      type: 'function',
      function: {
        name: sampleTool.name,
        description: sampleTool.description,
        parameters: sampleTool.input_schema,
      },
    };

    it('sends HTTP-Referer and X-Title headers for openrouter', async () => {
      let capturedHeaders;
      globalThis.fetch = async (_url, opts) => {
        capturedHeaders = opts.headers;
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildResponsesSSE(['ok'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      await streamCompletion(orConfig, 'key', 'model', testMessages, null);

      assert.ok(capturedHeaders['HTTP-Referer']);
      assert.equal(capturedHeaders['X-Title'], 'Push CLI');
    });

    it('retains the chat fallback when PUSH_OPENROUTER_TRANSPORT=responses', async () => {
      const urls = [];
      globalThis.fetch = async (url, opts) => {
        urls.push(String(url));
        const body = JSON.parse(opts.body);
        if (body.input !== undefined) {
          return {
            ok: false,
            status: 400,
            body: stringToStream('{"error":{"message":"beta mismatch"}}'),
            headers: new Headers(),
            text: async () => '{"error":{"message":"beta mismatch"}}',
            json: async () => ({ error: { message: 'beta mismatch' } }),
          };
        }
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildSSE(['chat-ok'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      const text = await streamCompletion(orConfig, 'key', 'model', testMessages, null);

      assert.equal(text, 'chat-ok');
      assert.deepEqual(urls, [
        'http://test.invalid/v1/responses',
        'http://test.invalid/v1/chat/completions',
      ]);
    });

    it('injects the openrouter:web_search server tool by default', async () => {
      const prev = process.env.PUSH_OPENROUTER_WEB_SEARCH;
      delete process.env.PUSH_OPENROUTER_WEB_SEARCH;
      let capturedBody;
      globalThis.fetch = async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildResponsesSSE(['ok'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      try {
        await streamCompletion(orConfig, 'key', 'model', testMessages, null);
      } finally {
        if (prev === undefined) delete process.env.PUSH_OPENROUTER_WEB_SEARCH;
        else process.env.PUSH_OPENROUTER_WEB_SEARCH = prev;
      }

      assert.deepEqual(capturedBody.tools, [{ type: 'openrouter:web_search' }]);
    });

    it('requests, replays, and emits encrypted Responses reasoning items', async () => {
      let capturedBody;
      const priorItem = {
        type: 'reasoning',
        id: 'rs_prior',
        encrypted_content: 'prior-ciphertext',
      };
      const nextItem = {
        type: 'reasoning',
        id: 'rs_next',
        encrypted_content: 'next-ciphertext',
        status: 'completed',
      };
      globalThis.fetch = async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        const frames = [
          `data: ${JSON.stringify({ type: 'response.output_item.done', output_index: 0, item: nextItem })}`,
          `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [nextItem] } })}`,
          '',
        ].join('\n\n');
        return {
          ok: true,
          status: 200,
          body: stringToStream(frames),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      const stream = createProviderStream(orConfig, 'key');
      const replayItems = [];
      for await (const event of stream({
        provider: 'openrouter',
        model: 'deepseek/deepseek-r1',
        messages: [
          {
            id: 'a1',
            role: 'assistant',
            content: 'tool call',
            timestamp: 0,
            responsesReasoningItems: [priorItem],
          },
          { id: 'u2', role: 'user', content: 'tool result', timestamp: 1 },
        ],
        openrouterWebSearch: false,
      })) {
        if (event.type === 'responses_reasoning_item') replayItems.push(event.item);
      }

      assert.deepEqual(capturedBody.include, ['reasoning.encrypted_content']);
      assert.deepEqual(capturedBody.input[0], priorItem);
      assert.deepEqual(replayItems, [nextItem]);
    });

    // Ambiguous routing response, driven through the CLI production entry
    // (`createProviderStream`) rather than only the shared combinator.
    const ROUTING_CONSTRAINT_BODY = JSON.stringify({
      error: {
        message:
          'No endpoints found that can handle the requested parameters. To learn more about provider routing, visit: https://openrouter.ai/docs/guides/routing/provider-selection',
        code: 404,
      },
    });

    function mockRoutingConstraintThenSuccess(counter) {
      return async () => {
        counter.calls += 1;
        if (counter.calls === 1) {
          return {
            ok: false,
            status: 404,
            body: null,
            headers: new Headers(),
            text: async () => ROUTING_CONSTRAINT_BODY,
            json: async () => JSON.parse(ROUTING_CONSTRAINT_BODY),
          };
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
    }

    it('falls back to chat when the Responses request pinned require_parameters', async () => {
      const counter = { calls: 0 };
      globalThis.fetch = mockRoutingConstraintThenSuccess(counter);
      const prevWebSearch = process.env.PUSH_OPENROUTER_WEB_SEARCH;
      process.env.PUSH_OPENROUTER_WEB_SEARCH = '0';

      try {
        const stream = createProviderStream(orConfig, 'key');
        const output = [];
        for await (const event of stream({
          provider: 'openrouter',
          model: 'anthropic/claude-sonnet-4',
          messages: [{ id: 'u1', role: 'user', content: 'hi', timestamp: 0 }],
          // Native tools are what set `provider.require_parameters` on this leg.
          tools: [sampleTool],
        })) {
          output.push(event);
        }
        assert.equal(counter.calls, 2, 'ambiguous Responses 404 must reach Chat');
        assert.ok(
          output.some((event) => event.type === 'text_delta' && event.text === 'recovered'),
        );
      } finally {
        if (prevWebSearch === undefined) delete process.env.PUSH_OPENROUTER_WEB_SEARCH;
        else process.env.PUSH_OPENROUTER_WEB_SEARCH = prevWebSearch;
      }
    });

    it('still falls back to chat on the same 404 when no constraint was pinned', async () => {
      // No tools and no schema → no `require_parameters`; Chat remains the intended
      // recovery for a pre-output Responses failure.
      const counter = { calls: 0 };
      globalThis.fetch = mockRoutingConstraintThenSuccess(counter);
      const prevWebSearch = process.env.PUSH_OPENROUTER_WEB_SEARCH;
      process.env.PUSH_OPENROUTER_WEB_SEARCH = '0';

      try {
        const stream = createProviderStream(orConfig, 'key');
        for await (const _ of stream({
          provider: 'openrouter',
          model: 'anthropic/claude-sonnet-4',
          messages: [{ id: 'u1', role: 'user', content: 'hi', timestamp: 0 }],
        })) {
          // drain
        }
        assert.equal(counter.calls, 2, 'unconstrained 404 must still reach the chat fallback');
      } finally {
        if (prevWebSearch === undefined) delete process.env.PUSH_OPENROUTER_WEB_SEARCH;
        else process.env.PUSH_OPENROUTER_WEB_SEARCH = prevWebSearch;
      }
    });

    it('recovers a schema-only routing rejection on Responses without dropping temperature', async () => {
      const bodies = [];
      const logs = [];
      let calls = 0;
      globalThis.fetch = async (_url, opts) => {
        bodies.push(JSON.parse(opts.body));
        calls += 1;
        if (calls === 1) {
          return {
            ok: false,
            status: 404,
            body: null,
            headers: new Headers(),
            text: async () => ROUTING_CONSTRAINT_BODY,
            json: async () => JSON.parse(ROUTING_CONSTRAINT_BODY),
          };
        }
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildResponsesSSE(['recovered'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };
      const previousConsoleError = console.error;
      console.error = (line) => logs.push(String(line));

      try {
        const stream = createProviderStream(orConfig, 'key');
        for await (const _ of stream({
          provider: 'openrouter',
          model: 'anthropic/claude-sonnet-4',
          messages: [{ id: 'u1', role: 'user', content: 'review', timestamp: 0 }],
          openrouterWebSearch: false,
          responseFormat: { name: 'verdict', schema: { type: 'object' } },
        })) {
          // drain
        }
      } finally {
        console.error = previousConsoleError;
      }

      assert.equal(calls, 2);
      assert.ok(bodies[0].text);
      assert.deepEqual(bodies[0].provider, { require_parameters: true });
      assert.equal(bodies[0].temperature, 0.1);
      assert.equal(bodies[1].text, undefined);
      assert.equal(bodies[1].provider, undefined);
      assert.equal(bodies[1].temperature, 0.1);
      assert.ok(
        logs.some((line) => {
          const parsed = JSON.parse(line);
          return (
            parsed.event === 'openrouter_structured_output_relaxed' &&
            parsed.transport === 'responses'
          );
        }),
      );
    });

    it('merges native function tools with the openrouter:web_search server tool', async () => {
      const prev = process.env.PUSH_OPENROUTER_WEB_SEARCH;
      delete process.env.PUSH_OPENROUTER_WEB_SEARCH;
      let capturedBody;
      globalThis.fetch = async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildResponsesSSE(['ok'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      try {
        const stream = createProviderStream(orConfig, 'key');
        for await (const _ of stream({
          provider: 'openrouter',
          model: 'model',
          messages: [{ id: 'm1', role: 'user', content: 'read and search', timestamp: 0 }],
          tools: [sampleTool],
        })) {
          // drain
        }
      } finally {
        if (prev === undefined) delete process.env.PUSH_OPENROUTER_WEB_SEARCH;
        else process.env.PUSH_OPENROUTER_WEB_SEARCH = prev;
      }

      assert.deepEqual(capturedBody.tools, [responsesTool, { type: 'openrouter:web_search' }]);
      assert.equal(capturedBody.tool_choice, undefined);
      assert.deepEqual(capturedBody.provider, { require_parameters: true });
    });

    it('preserves explicit sampling while omitting redundant auto tool choice', async () => {
      let capturedBody;
      globalThis.fetch = async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildResponsesSSE(['ok'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      const stream = createProviderStream(orConfig, 'key');
      for await (const _ of stream({
        provider: 'openrouter',
        model: 'inception/mercury-2',
        messages: [{ id: 'm1', role: 'user', content: 'read it', timestamp: 0 }],
        tools: [sampleTool],
        openrouterWebSearch: false,
        maxTokens: 1234,
        temperature: 0.7,
        topP: 0.9,
      })) {
        // drain
      }

      assert.deepEqual(capturedBody.provider, { require_parameters: true });
      assert.deepEqual(capturedBody.tools, [responsesTool]);
      assert.equal(capturedBody.tool_choice, undefined);
      assert.equal(capturedBody.max_output_tokens, 1234);
      assert.equal(capturedBody.temperature, 0.7);
      assert.equal(capturedBody.top_p, 0.9);
    });

    it('preserves sampling on the legacy Chat producer too', async () => {
      const previousTransport = process.env.PUSH_OPENROUTER_TRANSPORT;
      process.env.PUSH_OPENROUTER_TRANSPORT = 'chat';
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

      try {
        const stream = createProviderStream(orConfig, 'key');
        for await (const _ of stream({
          provider: 'openrouter',
          model: 'inception/mercury-2',
          messages: [{ id: 'm1', role: 'user', content: 'read it', timestamp: 0 }],
          tools: [sampleTool],
          openrouterWebSearch: false,
          maxTokens: 1234,
          temperature: 0.7,
          topP: 0.9,
        })) {
          // drain
        }
      } finally {
        if (previousTransport === undefined) delete process.env.PUSH_OPENROUTER_TRANSPORT;
        else process.env.PUSH_OPENROUTER_TRANSPORT = previousTransport;
      }

      assert.deepEqual(capturedBody.provider, { require_parameters: true });
      assert.deepEqual(capturedBody.tools, [openAIChatTool]);
      assert.equal(capturedBody.tool_choice, undefined);
      assert.equal(capturedBody.max_tokens, 1234);
      assert.equal(capturedBody.temperature, 0.7);
      assert.equal(capturedBody.top_p, 0.9);
    });

    it('relaxes unsupported structured output on legacy Chat without dropping temperature', async () => {
      const previousTransport = process.env.PUSH_OPENROUTER_TRANSPORT;
      process.env.PUSH_OPENROUTER_TRANSPORT = 'chat';
      const bodies = [];
      const logs = [];
      let calls = 0;
      globalThis.fetch = async (_url, opts) => {
        bodies.push(JSON.parse(opts.body));
        calls += 1;
        if (calls === 1) {
          return {
            ok: false,
            status: 404,
            body: null,
            headers: new Headers(),
            text: async () => ROUTING_CONSTRAINT_BODY,
            json: async () => JSON.parse(ROUTING_CONSTRAINT_BODY),
          };
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
      const previousConsoleError = console.error;
      console.error = (line) => logs.push(String(line));

      try {
        const stream = createProviderStream(orConfig, 'key');
        for await (const _ of stream({
          provider: 'openrouter',
          model: 'anthropic/claude-sonnet-4',
          messages: [{ id: 'u1', role: 'user', content: 'review', timestamp: 0 }],
          openrouterWebSearch: false,
          responseFormat: { name: 'verdict', schema: { type: 'object' } },
        })) {
          // drain
        }
      } finally {
        console.error = previousConsoleError;
        if (previousTransport === undefined) delete process.env.PUSH_OPENROUTER_TRANSPORT;
        else process.env.PUSH_OPENROUTER_TRANSPORT = previousTransport;
      }

      assert.equal(calls, 2);
      assert.ok(bodies[0].response_format);
      assert.deepEqual(bodies[0].provider, { require_parameters: true });
      assert.equal(bodies[0].temperature, 0.1);
      assert.equal(bodies[1].response_format, undefined);
      assert.equal(bodies[1].provider, undefined);
      assert.equal(bodies[1].temperature, 0.1);
      assert.ok(
        logs.some((line) => {
          const parsed = JSON.parse(line);
          return (
            parsed.event === 'openrouter_structured_output_relaxed' && parsed.transport === 'chat'
          );
        }),
      );
    });

    it('backfills Gemini thought signatures on OpenRouter Responses tool history', async () => {
      let capturedBody;
      globalThis.fetch = async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildResponsesSSE(['ok'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      const stream = createProviderStream(orConfig, 'key');
      for await (const _ of stream({
        provider: 'openrouter',
        model: 'google/gemini-3-pro-preview',
        messages: [
          {
            id: 'm1',
            role: 'assistant',
            content: '',
            timestamp: 0,
            contentBlocks: [
              {
                type: 'tool_use',
                id: 'call_1',
                name: 'sandbox_read_file',
                input: { path: 'a.ts' },
              },
            ],
          },
        ],
        tools: [sampleTool],
        openrouterWebSearch: false,
      })) {
        // drain
      }

      assert.deepEqual(capturedBody.input[0], {
        type: 'function_call',
        call_id: 'call_1',
        name: 'sandbox_read_file',
        arguments: '{"path":"a.ts"}',
        status: 'completed',
        thoughtSignature: GEMINI_MISSING_THOUGHT_SIGNATURE_PLACEHOLDER,
        extra_content: {
          google: { thought_signature: GEMINI_MISSING_THOUGHT_SIGNATURE_PLACEHOLDER },
        },
        function: { thought_signature: GEMINI_MISSING_THOUGHT_SIGNATURE_PLACEHOLDER },
      });
    });

    it('omits the web_search tool when PUSH_OPENROUTER_WEB_SEARCH=0', async () => {
      const prev = process.env.PUSH_OPENROUTER_WEB_SEARCH;
      process.env.PUSH_OPENROUTER_WEB_SEARCH = '0';
      let capturedBody;
      globalThis.fetch = async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildResponsesSSE(['ok'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      try {
        await streamCompletion(orConfig, 'key', 'model', testMessages, null);
      } finally {
        if (prev === undefined) delete process.env.PUSH_OPENROUTER_WEB_SEARCH;
        else process.env.PUSH_OPENROUTER_WEB_SEARCH = prev;
      }

      assert.equal(capturedBody.tools, undefined);
    });

    it('does NOT inject the web_search tool for non-openrouter providers', async () => {
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

      await streamCompletion(testConfig, 'key', 'model', testMessages, null);

      assert.equal(capturedBody.tools, undefined);
    });

    it('includes session_id in request body when provided', async () => {
      let capturedBody;
      globalThis.fetch = async (_url, opts) => {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildResponsesSSE(['ok'])),
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
      assert.equal(capturedBody.trace.generation_name, 'push-cli-responses');
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
          body: stringToStream(buildResponsesSSE(['ok'])),
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

    it('routes the registry OpenRouter provider through legacy Chat when PUSH_OPENROUTER_TRANSPORT=chat', async () => {
      const restore = withEnv({
        PUSH_OPENROUTER_TRANSPORT: 'chat',
        PUSH_OPENROUTER_URL: undefined,
        PUSH_OPENROUTER_WEB_SEARCH: '0',
      });
      let capturedUrl;
      let capturedBody;
      globalThis.fetch = async (url, opts) => {
        capturedUrl = url;
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          body: stringToStream(buildSSE(['legacy'])),
          headers: new Headers(),
          text: async () => '',
          json: async () => ({}),
        };
      };

      try {
        const text = await streamCompletion(
          PROVIDER_CONFIGS.openrouter,
          'key',
          'model',
          testMessages,
          null,
        );

        assert.equal(text, 'legacy');
        assert.equal(capturedUrl, 'https://openrouter.ai/api/v1/chat/completions');
        assert.deepEqual(capturedBody.messages, [{ role: 'user', content: 'hello' }]);
        assert.equal(capturedBody.input, undefined);
      } finally {
        restore();
      }
    });

    // ─── Per-model transport dispatch (no PUSH_OPENROUTER_TRANSPORT) ─
    // OpenRouter defaults ordinary models to /responses (PushCapabilityProfile.openaiWire),
    // and runs it responses-first with a chat fallback: a Responses body can't ride
    // /chat/completions, so a pre-output failure retries the whole turn on chat.

    describe('per-model transport dispatch', () => {
      let prevPerModelTransport;
      beforeEach(() => {
        // The outer describe forces `responses`; the default per-model
        // behavior needs the override ABSENT.
        prevPerModelTransport = process.env.PUSH_OPENROUTER_TRANSPORT;
        delete process.env.PUSH_OPENROUTER_TRANSPORT;
      });
      afterEach(() => {
        if (prevPerModelTransport === undefined) delete process.env.PUSH_OPENROUTER_TRANSPORT;
        else process.env.PUSH_OPENROUTER_TRANSPORT = prevPerModelTransport;
      });

      it('sends a responses-tier model to the Responses endpoint with an input body', async () => {
        let capturedUrl;
        let capturedBody;
        globalThis.fetch = async (url, opts) => {
          capturedUrl = String(url);
          capturedBody = JSON.parse(opts.body);
          return {
            ok: true,
            status: 200,
            body: stringToStream(buildResponsesSSE(['beta'])),
            headers: new Headers(),
            text: async () => '',
            json: async () => ({}),
          };
        };

        const stream = createProviderStream(orConfig, 'key');
        for await (const _ of stream({
          provider: 'openrouter',
          model: 'openai/gpt-5.4',
          messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: 0 }],
          openrouterWebSearch: false,
        })) {
          // drain
        }

        assert.equal(capturedUrl, 'http://test.invalid/v1/responses');
        assert.ok(capturedBody.input);
        assert.equal(capturedBody.messages, undefined);
      });

      it('sends DeepSeek and Kimi through Responses now that encrypted replay is durable', async () => {
        const seen = [];
        globalThis.fetch = async (url, opts) => {
          seen.push({ url: String(url), body: JSON.parse(opts.body) });
          return {
            ok: true,
            status: 200,
            body: stringToStream(buildResponsesSSE(['ok'])),
            headers: new Headers(),
            text: async () => '',
            json: async () => ({}),
          };
        };

        for (const model of ['deepseek/deepseek-r1', 'moonshotai/kimi-k2.7-code']) {
          const stream = createProviderStream(orConfig, 'key');
          for await (const _ of stream({
            provider: 'openrouter',
            model,
            messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: 0 }],
            openrouterWebSearch: false,
          })) {
            // drain
          }
        }

        assert.equal(seen.length, 2);
        for (const request of seen) {
          assert.equal(request.url, 'http://test.invalid/v1/responses');
          assert.ok(request.body.input);
          assert.deepEqual(request.body.include, ['reasoning.encrypted_content']);
        }
      });

      it('runs responses-first with a chat fallback when the beta attempt fails', async () => {
        const urls = [];
        let calls = 0;
        globalThis.fetch = async (url, opts) => {
          urls.push(String(url));
          calls += 1;
          const body = JSON.parse(opts.body);
          if (body.input !== undefined) {
            // Responses attempt → provider error before any output.
            return {
              ok: false,
              status: 400,
              body: stringToStream('{"error":{"message":"provider error"}}'),
              headers: new Headers(),
              text: async () => '{"error":{"message":"provider error"}}',
              json: async () => ({ error: { message: 'provider error' } }),
            };
          }
          // Chat fallback → succeeds.
          return {
            ok: true,
            status: 200,
            body: stringToStream(buildSSE(['chat-ok'])),
            headers: new Headers(),
            text: async () => '',
            json: async () => ({}),
          };
        };

        const stream = createProviderStream(orConfig, 'key');
        const tokens = [];
        for await (const event of stream({
          provider: 'openrouter',
          model: 'minimax/minimax-m3',
          messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: 0 }],
        })) {
          if (event.type === 'text_delta') tokens.push(event.text);
        }

        // Responses attempt (input body) then the chat fallback (messages body).
        assert.equal(calls, 2);
        assert.equal(urls[0], 'http://test.invalid/v1/responses');
        assert.equal(urls[1], 'http://test.invalid/v1/chat/completions');
        assert.equal(tokens.join(''), 'chat-ok');
      });

      it('routes a no-model request to Responses via the config default', async () => {
        let capturedUrl;
        globalThis.fetch = async (url, opts) => {
          capturedUrl = String(url);
          JSON.parse(opts.body);
          return {
            ok: true,
            status: 200,
            body: stringToStream(buildResponsesSSE(['ok'])),
            headers: new Headers(),
            text: async () => '',
            json: async () => ({}),
          };
        };

        // OpenRouter defaults a no-model request to /responses; the configured
        // default model still drives the capability decision.
        const stream = createProviderStream(orConfig, 'key');
        for await (const _ of stream({
          provider: 'openrouter',
          model: '',
          messages: [{ id: 'm1', role: 'user', content: 'hello', timestamp: 0 }],
        })) {
          // drain
        }

        assert.equal(capturedUrl, 'http://test.invalid/v1/responses');
      });
    });

    // ─── Prompt caching (cacheBreakpointIndices: Hermes system_and_3) ─
    it('tags system + up to 3 rolling-tail messages with cache_control', async () => {
      process.env.PUSH_OPENROUTER_TRANSPORT = 'chat';
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
      await streamCompletion(
        orChatConfig,
        'key',
        'model',
        messages,
        null,
        DEFAULT_TIMEOUT_MS,
        null,
        {
          cacheBreakpointIndices: [1, 2, 3],
        },
      );

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
      process.env.PUSH_OPENROUTER_TRANSPORT = 'chat';
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
      await streamCompletion(
        orChatConfig,
        'key',
        'model',
        messages,
        null,
        DEFAULT_TIMEOUT_MS,
        null,
        {
          cacheBreakpointIndices: [1],
        },
      );

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
      process.env.PUSH_OPENROUTER_TRANSPORT = 'chat';
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
      await streamCompletion(orChatConfig, 'key', 'model', messages, null);

      assert.equal(typeof capturedBody.messages[0].content, 'string');
      assert.equal(typeof capturedBody.messages[1].content, 'string');
    });

    it('does not tag when cacheBreakpointIndices is empty (system-only transcript)', async () => {
      process.env.PUSH_OPENROUTER_TRANSPORT = 'chat';
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
        orChatConfig,
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
      process.env.PUSH_OPENROUTER_TRANSPORT = 'chat';
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
      await streamCompletion(
        orChatConfig,
        'key',
        'model',
        messages,
        null,
        DEFAULT_TIMEOUT_MS,
        null,
        {
          // Caller passes 5 indices — the slice should keep only the last 3.
          cacheBreakpointIndices: [1, 2, 3, 4, 5],
        },
      );

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
      process.env.PUSH_OPENROUTER_TRANSPORT = 'chat';
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
      await streamCompletion(
        orChatConfig,
        'key',
        'model',
        messages,
        null,
        DEFAULT_TIMEOUT_MS,
        null,
        {
          cacheBreakpointIndices: [0, 1],
        },
      );

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

      const stream = createCliProviderStream(orChatConfig, 'key');
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

    it('keeps the direct Kimi K2.7 pinned sampling contract outside OpenRouter scoping', async () => {
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
      const kimiConfig = {
        id: 'kimi',
        url: 'http://test.invalid/v1/chat/completions',
        defaultModel: 'kimi-k2.7-code',
        apiKeyEnv: ['TEST_KIMI_KEY'],
        requiresKey: false,
      };

      const stream = createCliProviderStream(kimiConfig, 'key');
      for await (const _ of stream({
        provider: 'kimi',
        model: 'kimi-k2.7-code',
        messages: [{ id: 'm1', role: 'user', content: 'code', timestamp: 0 }],
      })) {
        // drain
      }

      assert.equal(capturedBody.temperature, 1);
      assert.equal(capturedBody.top_p, 0.95);
      assert.equal(capturedBody.provider, undefined);
    });

    it('keeps max_tokens for generic OpenAI-compatible CLI providers', async () => {
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

      const stream = createCliProviderStream(testConfig, 'key');
      for await (const _ of stream({
        provider: 'openrouter',
        model: 'model',
        messages: [{ id: 'm0', role: 'user', content: 'hi', timestamp: 0 }],
        maxTokens: 1234,
      })) {
        // drain
      }

      assert.equal(capturedBody.max_tokens, 1234);
      assert.equal(capturedBody.max_completion_tokens, undefined);
    });

    it('uses max_output_tokens for the direct OpenAI Responses CLI provider', async () => {
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

      const stream = createProviderStream(
        { ...testConfig, id: 'openai', streamShape: 'openai-responses' },
        'key',
      );
      for await (const _ of stream({
        provider: 'openai',
        model: 'gpt-5.4',
        messages: [{ id: 'm0', role: 'user', content: 'hi', timestamp: 0 }],
        maxTokens: 1234,
      })) {
        // drain
      }

      assert.equal(capturedBody.max_output_tokens, 1234);
      assert.equal(capturedBody.store, false);
      assert.deepEqual(capturedBody.input, [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
      ]);
      assert.equal(capturedBody.max_completion_tokens, undefined);
      assert.equal(capturedBody.max_tokens, undefined);
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

// ─── reasoning-block round-trip through the legacy engine path ──────────
//
// The bridge consumes `reasoning_blocks` on the OpenAI-shaped message and
// re-emits them as the FIRST entries of the upstream assistant content[].
// The forwarding chain through streamCompletion is what makes that work
// for the legacy `cli/engine.ts` → streamCompletion path. Without these
// tests, the field could silently get dropped at the ChatMessage → LlmMessage
// → wire boundary again and the daemon-path tests wouldn't catch it.

describe('streamCompletion reasoning-block forwarding (direct Anthropic)', () => {
  const ANTHROPIC_CONFIG = {
    id: 'anthropic',
    url: 'http://test.invalid/v1/messages',
    defaultModel: 'claude-sonnet-4-6',
    apiKeyEnv: ['TEST_STREAM_KEY'],
    requiresKey: false,
    streamShape: 'anthropic',
  };

  function stringToStream(s) {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(s));
        c.close();
      },
    });
  }

  let originalFetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('forwards ChatMessage.reasoningBlocks through the LlmMessage mapping into the Anthropic body', async () => {
    let capturedBody;
    globalThis.fetch = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      // Yield a single content_block_delta + message_stop so the
      // translator emits one text_delta + done. Keeps the adapter from
      // hanging on this request.
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

    const messages = [
      { role: 'user', content: 'Why is the sky blue?' },
      {
        role: 'assistant',
        content: 'Rayleigh scattering.',
        reasoningBlocks: [{ type: 'thinking', text: 'Recall optics.', signature: 'sig-abc' }],
      },
      { role: 'user', content: 'More' },
    ];

    await streamCompletion(ANTHROPIC_CONFIG, 'sk', 'claude-opus-4-7', messages, null);

    // The bridge translates the OpenAI-shaped reasoning_blocks into the
    // Anthropic content[] prefix. Without the streamCompletion mapping
    // forwarding the field, this assertion would fire on a plain-text
    // content array — the regression that triggered this test.
    const assistantTurn = capturedBody.messages[1];
    assert.equal(assistantTurn.role, 'assistant');
    assert.ok(Array.isArray(assistantTurn.content));
    assert.deepEqual(assistantTurn.content[0], {
      type: 'thinking',
      thinking: 'Recall optics.',
      signature: 'sig-abc',
    });
  });

  it('fires onReasoningBlock for each reasoning_block event the adapter emits', async () => {
    // Build an Anthropic SSE stream that opens a `thinking` block, streams
    // text + signature deltas, then closes — the bridge translates this
    // into a single reasoning_block PushStreamEvent which the
    // streamCompletion loop must forward to onReasoningBlock.
    const frames = [
      // message_start
      `data: ${JSON.stringify({ type: 'message_start', message: { id: 'm1' } })}\n\n`,
      // content_block_start: open a thinking block at index 0
      `data: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      })}\n\n`,
      // thinking_delta
      `data: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Need to think...' },
      })}\n\n`,
      // signature_delta
      `data: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'sig-xyz' },
      })}\n\n`,
      // content_block_stop: closes the thinking block → emits reasoning_block
      `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
      // message_stop
      `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ].join('');

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      body: stringToStream(frames),
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      text: async () => frames,
    });

    const capturedBlocks = [];
    await streamCompletion(
      ANTHROPIC_CONFIG,
      'sk',
      'claude-opus-4-7',
      [{ role: 'user', content: 'hi' }],
      null,
      undefined,
      null,
      {
        onReasoningBlock: (block) => capturedBlocks.push(block),
      },
    );

    assert.equal(capturedBlocks.length, 1, 'one reasoning_block event expected');
    assert.deepEqual(capturedBlocks[0], {
      type: 'thinking',
      text: 'Need to think...',
      signature: 'sig-xyz',
    });
  });

  it('does not fire onReasoningBlock when the adapter never emits reasoning_block (OpenAI-compat path)', async () => {
    // Non-Anthropic adapters never emit reasoning_block PushStreamEvents,
    // so the callback should stay silent — pins the contract that
    // callers can always wire the callback without worrying about
    // spurious fires on plain-text providers.
    const openaiCompatConfig = {
      id: 'openrouter',
      url: 'http://test.invalid/v1/chat/completions',
      defaultModel: 'test-model',
      apiKeyEnv: ['TEST_STREAM_KEY'],
      requiresKey: false,
    };

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      body: stringToStream(
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`,
      ),
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      text: async () => '',
    });

    const capturedBlocks = [];
    await streamCompletion(
      openaiCompatConfig,
      'sk',
      'model',
      [{ role: 'user', content: 'hi' }],
      null,
      undefined,
      null,
      {
        onReasoningBlock: (block) => capturedBlocks.push(block),
      },
    );

    assert.equal(capturedBlocks.length, 0);
  });

  it('forwards openrouter url_citation annotations to onCitations (normalized)', async () => {
    const orConfig = {
      id: 'openrouter',
      url: 'http://test.invalid/v1/chat/completions',
      defaultModel: 'test-model',
      apiKeyEnv: ['TEST_STREAM_KEY'],
      requiresKey: false,
    };

    // OpenRouter defaults to /responses now, so annotations arrive on the
    // Responses `output_text.annotation.added` channel (not chat `delta.annotations`).
    const textFrame = JSON.stringify({ type: 'response.output_text.delta', delta: 'answer' });
    const annFrame = JSON.stringify({
      type: 'response.output_text.annotation.added',
      annotation: {
        type: 'url_citation',
        url: 'https://a.test',
        title: 'A',
        content: 'excerpt',
        start_index: 1,
        end_index: 2,
      },
    });
    const completedFrame = JSON.stringify({
      type: 'response.completed',
      response: { status: 'completed' },
    });

    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      body: stringToStream(
        `data: ${textFrame}\n\ndata: ${annFrame}\n\ndata: ${completedFrame}\n\n`,
      ),
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      text: async () => '',
    });

    const captured = [];
    const text = await streamCompletion(
      orConfig,
      'sk',
      'model',
      [{ role: 'user', content: 'hi' }],
      null,
      undefined,
      null,
      { onCitations: (c) => captured.push(...c) },
    );

    // Citations pass through normalizeReasoning without truncating the answer.
    assert.equal(text, 'answer');
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0], {
      url: 'https://a.test',
      title: 'A',
      content: 'excerpt',
      startIndex: 1,
      endIndex: 2,
    });
  });
});

// ─── AI Gateway cache bypass (#1554) ─────────────────────────────────────
//
// Every CLI transport must send `cf-aig-skip-cache: true` when its
// configured URL is an AI Gateway route (user config can point any provider
// at a push-gate provider-native route), and must NOT leak the header to
// direct provider hosts. The gemini transport's copy of this test lives in
// gemini-stream.test.mjs beside its URL-construction fixtures.

describe('AI Gateway cache-bypass headers (#1554)', () => {
  const GATEWAY_BASE = 'https://gateway.ai.cloudflare.com/v1/acct/push-gate';

  function stringToStream(s) {
    const encoder = new TextEncoder();
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(s));
        controller.close();
      },
    });
  }

  function captureFetch(sse) {
    const calls = [];
    const handler = async (url, init) => {
      calls.push({ url, init });
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

  const CHAT_SSE = `data: ${JSON.stringify({
    choices: [{ delta: { content: 'ok' } }],
  })}\n\ndata: [DONE]\n\n`;
  const RESPONSES_SSE = [
    `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n`,
    `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`,
  ].join('');
  const ANTHROPIC_SSE = [
    `data: ${JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: 'ok' },
    })}\n\n`,
    `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ].join('');

  let originalFetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  async function drain(stream, provider, model) {
    for await (const _ of stream({
      provider,
      model,
      messages: [{ id: 'm0', role: 'user', content: 'hi', timestamp: 0 }],
    })) {
      // drain
    }
  }

  it('openai-compat sends the bypass on gateway routes only', async () => {
    const { calls, handler } = captureFetch(CHAT_SSE);
    globalThis.fetch = handler;
    const gateway = {
      id: 'zen',
      url: `${GATEWAY_BASE}/zen/api/paas/v4/chat/completions`,
      defaultModel: 'glm-5.1',
      apiKeyEnv: ['TEST_AIG_KEY'],
      requiresKey: false,
    };
    await drain(createProviderStream(gateway, 'key'), 'zen', 'glm-5.1');
    assert.equal(calls[0].init.headers['cf-aig-skip-cache'], 'true');

    const direct = { ...gateway, url: 'https://api.z.ai/api/paas/v4/chat/completions' };
    await drain(createProviderStream(direct, 'key'), 'zen', 'glm-5.1');
    assert.equal(calls[1].init.headers['cf-aig-skip-cache'], undefined);
  });

  it('openai-responses sends the bypass on gateway routes', async () => {
    const { calls, handler } = captureFetch(RESPONSES_SSE);
    globalThis.fetch = handler;
    const gateway = {
      id: 'openai',
      url: `${GATEWAY_BASE}/openai/responses`,
      defaultModel: 'gpt-5.4',
      apiKeyEnv: ['TEST_AIG_KEY'],
      requiresKey: false,
      streamShape: 'openai-responses',
    };
    await drain(createProviderStream(gateway, 'key'), 'openai', 'gpt-5.4');
    assert.equal(calls[0].init.headers['cf-aig-skip-cache'], 'true');
  });

  it('anthropic sends the bypass on gateway routes', async () => {
    const { calls, handler } = captureFetch(ANTHROPIC_SSE);
    globalThis.fetch = handler;
    const gateway = {
      id: 'anthropic',
      url: `${GATEWAY_BASE}/anthropic/v1/messages`,
      defaultModel: 'claude-sonnet-4-6',
      apiKeyEnv: ['TEST_AIG_KEY'],
      requiresKey: false,
      streamShape: 'anthropic',
    };
    await drain(createProviderStream(gateway, 'sk'), 'anthropic', 'claude-opus-4-7');
    assert.equal(calls[0].init.headers['cf-aig-skip-cache'], 'true');
  });
});
