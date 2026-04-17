import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveApiKey,
  getProviderList,
  createReasoningTokenParser,
  streamCompletion,
  PROVIDER_CONFIGS,
  DEFAULT_TIMEOUT_MS,
  MAX_RETRIES,
} from '../provider.ts';

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

// ─── createReasoningTokenParser ─────────────────────────────────

describe('createReasoningTokenParser', () => {
  /** Collect content + thinking tokens from a parser. */
  function makeCollector() {
    const content = [];
    const thinking = [];
    const parser = createReasoningTokenParser(
      (token) => content.push(token),
      (token) => thinking.push(token),
    );
    return { content, thinking, parser };
  }

  describe('plain content (no think tags)', () => {
    it('emits all tokens to content callback', () => {
      const { content, thinking, parser } = makeCollector();
      parser.pushContent('Hello');
      parser.pushContent(' world');
      parser.flush();
      assert.equal(content.join(''), 'Hello world');
      // No thinking tokens (null close signal may appear via flush)
      const nonNull = thinking.filter((t) => t !== null);
      assert.equal(nonNull.length, 0);
    });

    it('ignores empty tokens', () => {
      const { content, parser } = makeCollector();
      parser.pushContent('');
      parser.pushContent('');
      parser.pushContent('hello');
      parser.flush();
      assert.equal(content.join(''), 'hello');
    });
  });

  describe('<think>...</think> tag handling', () => {
    it('splits reasoning and content from a single chunk', () => {
      const { content, thinking, parser } = makeCollector();
      parser.pushContent('<think>reasoning here</think>visible content');
      parser.flush();
      const thinkText = thinking.filter((t) => t !== null).join('');
      assert.equal(thinkText, 'reasoning here');
      assert.equal(content.join(''), 'visible content');
    });

    it('handles think tag split across multiple pushContent calls', () => {
      const { content, thinking, parser } = makeCollector();
      parser.pushContent('<thi');
      parser.pushContent('nk>deep thought</th');
      parser.pushContent('ink>after');
      parser.flush();
      const thinkText = thinking.filter((t) => t !== null).join('');
      assert.equal(thinkText, 'deep thought');
      assert.equal(content.join(''), 'after');
    });

    it('handles nested <think> tags (inner <think> is treated as content of outer)', () => {
      const { content, thinking, parser } = makeCollector();
      // When inside a think block, encountering another <think> doesn't reset —
      // it just emits as reasoning text. The first </think> closes.
      parser.pushContent('<think>outer<think>inner</think>after');
      parser.flush();
      const thinkText = thinking.filter((t) => t !== null).join('');
      // The inner <think> gets split: "outer" before it, then inner block opens
      // Actually let's verify the real behavior — the split('<think>') logic
      // processes the first <think>, enters think mode, then the remaining text
      // "outer<think>inner</think>after" is re-pushed. Inside think mode it looks
      // for </think>, finds it at "inner", so "outer<think>inner" is reasoning.
      assert.ok(thinkText.includes('outer'));
      assert.ok(thinkText.includes('inner'));
      assert.equal(content.join(''), 'after');
    });

    it('handles content before <think> tag', () => {
      const { content, thinking, parser } = makeCollector();
      parser.pushContent('prefix<think>reason</think>suffix');
      parser.flush();
      const thinkText = thinking.filter((t) => t !== null).join('');
      assert.equal(thinkText, 'reason');
      assert.ok(content.join('').includes('prefix'));
      assert.ok(content.join('').includes('suffix'));
    });

    it('emits null close signal when think block ends', () => {
      const { thinking, parser } = makeCollector();
      parser.pushContent('<think>thought</think>done');
      parser.flush();
      assert.ok(thinking.includes(null), 'should have null close signal');
    });

    it('strips leading whitespace after </think>', () => {
      const { content, parser } = makeCollector();
      parser.pushContent('<think>x</think>   visible');
      parser.flush();
      assert.equal(content.join(''), 'visible');
    });
  });

  describe('pushReasoning (native reasoning_content)', () => {
    it('emits reasoning tokens to thinking callback', () => {
      const { thinking, parser } = makeCollector();
      parser.pushReasoning('native thought');
      const nonNull = thinking.filter((t) => t !== null);
      assert.equal(nonNull.join(''), 'native thought');
    });

    it('ignores empty reasoning tokens', () => {
      const { thinking, parser } = makeCollector();
      parser.pushReasoning('');
      parser.pushReasoning('real');
      const nonNull = thinking.filter((t) => t !== null);
      assert.equal(nonNull.join(''), 'real');
    });
  });

  describe('flush behavior', () => {
    it('flushes buffered content outside think block', () => {
      const { content, parser } = makeCollector();
      // Push short content that contains '<' — this gets held in tagBuffer
      parser.pushContent('<b');
      parser.flush();
      assert.equal(content.join(''), '<b');
    });

    it('flushes buffered reasoning when inside think block', () => {
      const { thinking, parser } = makeCollector();
      // Enter think block but never close it
      parser.pushContent('<think>unfinished');
      parser.flush();
      const nonNull = thinking.filter((t) => t !== null);
      assert.ok(nonNull.join('').includes('unfinished'));
      // Should also emit null close signal
      assert.ok(thinking.includes(null));
    });

    it('emits close signal on flush after pushReasoning', () => {
      const { thinking, parser } = makeCollector();
      parser.pushReasoning('some reasoning');
      parser.flush();
      assert.ok(thinking.includes(null), 'flush should close open thinking');
    });

    it('flush with no buffered content still emits close if thinking was open', () => {
      const { thinking, parser } = makeCollector();
      parser.pushReasoning('thought');
      // No pending buffer, but thinkingOpen should be true
      parser.flush();
      assert.ok(thinking.includes(null));
    });
  });

  describe('closeThinking', () => {
    it('emits null signal when thinking is open', () => {
      const { thinking, parser } = makeCollector();
      parser.pushReasoning('some thought');
      parser.closeThinking();
      assert.ok(thinking.includes(null));
    });

    it('does nothing when thinking is not open', () => {
      const { thinking, parser } = makeCollector();
      parser.closeThinking();
      assert.equal(thinking.length, 0);
    });

    it('emits null only once for consecutive calls', () => {
      const { thinking, parser } = makeCollector();
      parser.pushReasoning('thought');
      parser.closeThinking();
      parser.closeThinking();
      const nulls = thinking.filter((t) => t === null);
      assert.equal(nulls.length, 1);
    });
  });

  describe('buffer holding for partial tag detection', () => {
    it('holds last 10 chars inside think block for split tag detection', () => {
      const { thinking, parser } = makeCollector();
      parser.pushContent('<think>');
      // Push a long chunk — safe portion should emit, tail held
      parser.pushContent('a]b]c]d]e]f]g]h]i]j]k]l]m]n]');
      const emitted = thinking.filter((t) => t !== null).join('');
      // The last 10 chars should be held, the rest emitted
      assert.ok(emitted.length > 0);
      assert.ok(emitted.length <= 'a]b]c]d]e]f]g]h]i]j]k]l]m]n]'.length - 10);

      // Flush to get the rest
      parser.flush();
      const allEmitted = thinking.filter((t) => t !== null).join('');
      assert.equal(allEmitted, 'a]b]c]d]e]f]g]h]i]j]k]l]m]n]');
    });

    it('buffers short content containing < for partial tag detection outside think block', () => {
      const { content, parser } = makeCollector();
      parser.pushContent('<th');
      // Content contains '<' and is short — should be buffered
      assert.equal(content.length, 0);
      parser.pushContent('is is not a tag');
      // Now total is ">this is not a tag" (> 50 chars? no, but no '<' in the tail)
      parser.flush();
      assert.equal(content.join(''), '<this is not a tag');
    });
  });

  describe('null callbacks', () => {
    it('works with null content callback', () => {
      const thinking = [];
      const parser = createReasoningTokenParser(null, (t) => thinking.push(t));
      parser.pushContent('<think>thought</think>content');
      parser.flush();
      const nonNull = thinking.filter((t) => t !== null);
      assert.equal(nonNull.join(''), 'thought');
    });

    it('works with null thinking callback', () => {
      const content = [];
      const parser = createReasoningTokenParser((t) => content.push(t), null);
      parser.pushContent('<think>thought</think>content');
      parser.flush();
      assert.equal(content.join(''), 'content');
    });

    it('works with both callbacks null', () => {
      const parser = createReasoningTokenParser(null, null);
      // Should not throw
      parser.pushContent('hello');
      parser.pushReasoning('think');
      parser.flush();
    });
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

  /** Build an SSE body with reasoning_content deltas. */
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
  });

  describe('reasoning token routing', () => {
    it('routes reasoning_content deltas to onThinkingToken', async () => {
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
