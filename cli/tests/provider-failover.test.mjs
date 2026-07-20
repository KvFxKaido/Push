import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_CONFIGS,
  classifyCliStreamError,
  cliStreamRetryDelayMs,
  resolveCliFailoverCandidates,
} from '../provider.ts';
import { CliProviderError } from '../openai-stream.ts';

// ─── Env helper ─────────────────────────────────────────────────

/** Clear every provider's API-key env vars, then apply `set` on top. Returns a
 *  restore fn. Clearing first makes candidate resolution deterministic against
 *  whatever keys happen to be in the ambient environment. */
function withProviderKeys(set) {
  const overrides = {};
  for (const cfg of Object.values(PROVIDER_CONFIGS)) {
    for (const env of cfg.apiKeyEnv) overrides[env] = undefined;
  }
  Object.assign(overrides, set);
  const originals = {};
  for (const [key, value] of Object.entries(overrides)) {
    originals[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return function restore() {
    for (const key of Object.keys(overrides)) {
      if (originals[key] === undefined) delete process.env[key];
      else process.env[key] = originals[key];
    }
  };
}

const ids = (candidates) => candidates.map((c) => c.config.id);

// ─── classifyCliStreamError ─────────────────────────────────────

describe('classifyCliStreamError', () => {
  it('marks 429 and 5xx CliProviderErrors retryable, carrying the status', () => {
    assert.deepEqual(classifyCliStreamError(new CliProviderError('rate', 429)), {
      retryable: true,
      status: 429,
    });
    assert.deepEqual(classifyCliStreamError(new CliProviderError('down', 503)), {
      retryable: true,
      status: 503,
    });
  });

  it('marks quota-exhausted 429s non-retryable — retrying a drained balance cannot succeed', () => {
    // Moonshot multiplexes retryable pressure (engine_overloaded_error,
    // rate_limit_reached_error) and permanent quota exhaustion
    // (exceeded_current_quota_error) onto the same 429; OpenAI does the same
    // with insufficient_quota. Status alone cannot distinguish them.
    assert.deepEqual(
      classifyCliStreamError(
        new CliProviderError(
          'Kimi 429: {"error":{"message":"Your account balance is insufficient","type":"exceeded_current_quota_error"}}',
          429,
        ),
      ),
      { retryable: false, status: 429 },
    );
    assert.deepEqual(
      classifyCliStreamError(
        new CliProviderError(
          'OpenAI 429: {"error":{"message":"You exceeded your current quota","type":"insufficient_quota"}}',
          429,
        ),
      ),
      { retryable: false, status: 429 },
    );
    // The retryable 429 flavors stay retryable.
    assert.deepEqual(
      classifyCliStreamError(
        new CliProviderError(
          'Kimi 429: {"error":{"message":"The engine is currently overloaded","type":"engine_overloaded_error"}}',
          429,
        ),
      ),
      { retryable: true, status: 429 },
    );
    assert.deepEqual(
      classifyCliStreamError(
        new CliProviderError(
          'Kimi 429: {"error":{"message":"requests per minute exceeded","type":"rate_limit_reached_error"}}',
          429,
        ),
      ),
      { retryable: true, status: 429 },
    );
  });

  it('marks 4xx (non-rate-limit) CliProviderErrors non-retryable but keeps the status', () => {
    assert.deepEqual(classifyCliStreamError(new CliProviderError('bad key', 401)), {
      retryable: false,
      status: 401,
    });
    assert.deepEqual(classifyCliStreamError(new CliProviderError('bad req', 400)), {
      retryable: false,
      status: 400,
    });
  });

  it('treats a transport-level error (no HTTP status) as transient', () => {
    assert.deepEqual(classifyCliStreamError(new Error('ECONNRESET')), { retryable: true });
  });

  it('honors structured in-band stream errors from Responses providers', () => {
    assert.deepEqual(
      classifyCliStreamError(
        Object.assign(new Error('OpenAI Responses stream error: NOT_FOUND: model not found'), {
          status: 404,
          retryable: false,
        }),
      ),
      { retryable: false, status: 404 },
    );
    assert.deepEqual(
      classifyCliStreamError(
        Object.assign(new Error('OpenAI Responses stream error: rate_limit_exceeded: slow down'), {
          status: 429,
          retryable: true,
        }),
      ),
      { retryable: true, status: 429 },
    );
    // Unclassifiable in-band code: no status maps, but the pump fails open so
    // the turn retries/fails over instead of dying on a likely-transient blip.
    assert.deepEqual(
      classifyCliStreamError(
        Object.assign(new Error('OpenAI Responses stream error: service_unavailable'), {
          retryable: true,
        }),
      ),
      { retryable: true },
    );
  });
});

// ─── cliStreamRetryDelayMs ──────────────────────────────────────

describe('cliStreamRetryDelayMs', () => {
  it('backs off exponentially from 1s', () => {
    assert.equal(cliStreamRetryDelayMs(0), 1000);
    assert.equal(cliStreamRetryDelayMs(1), 2000);
    assert.equal(cliStreamRetryDelayMs(2), 4000);
  });
});

// ─── resolveCliFailoverCandidates ───────────────────────────────

describe('resolveCliFailoverCandidates', () => {
  it('returns same-shape configured providers, excluding the locked one', () => {
    const restore = withProviderKeys({
      PUSH_OPENAI_API_KEY: 'k-openai',
      PUSH_OPENROUTER_API_KEY: 'k-openrouter',
      PUSH_FIREWORKS_API_KEY: 'k-fireworks',
      PUSH_ANTHROPIC_API_KEY: 'k-anthropic',
    });
    try {
      // openai + openrouter + fireworks are Responses-native, so a turn locked on
      // openai can fail over to OpenRouter and Fireworks. anthropic
      // (different shape) are excluded even though they have keys. Order follows
      // PROVIDER_CONFIGS declaration.
      assert.deepEqual(ids(resolveCliFailoverCandidates('openai', new Set(['openai']))), [
        'openrouter',
        'fireworks',
      ]);
    } finally {
      restore();
    }
  });

  it('includes OpenRouter in the Responses failover bucket', () => {
    const restore = withProviderKeys({
      PUSH_OPENAI_API_KEY: 'k-openai',
      PUSH_OPENROUTER_API_KEY: 'k-openrouter',
    });
    try {
      assert.deepEqual(ids(resolveCliFailoverCandidates('openai', new Set(['openai']))), [
        'openrouter',
      ]);
    } finally {
      restore();
    }
  });

  it('excludes providers already tried this round', () => {
    const restore = withProviderKeys({
      PUSH_OPENAI_API_KEY: 'k-openai',
      PUSH_OPENROUTER_API_KEY: 'k-openrouter',
      PUSH_FIREWORKS_API_KEY: 'k-fireworks',
    });
    try {
      assert.deepEqual(
        ids(resolveCliFailoverCandidates('openrouter', new Set(['openrouter', 'fireworks']))),
        ['openai'],
      );
    } finally {
      restore();
    }
  });

  it('skips same-shape providers that have no key configured', () => {
    const restore = withProviderKeys({ PUSH_OPENAI_API_KEY: 'k-openai' });
    try {
      // Only openai has a key; every other Responses provider is keyless.
      assert.deepEqual(ids(resolveCliFailoverCandidates('openai', new Set(['openai']))), []);
    } finally {
      restore();
    }
  });

  it('never fails over from anthropic — it is alone in its wire-shape bucket', () => {
    const restore = withProviderKeys({
      PUSH_ANTHROPIC_API_KEY: 'k-anthropic',
      PUSH_OPENAI_API_KEY: 'k-openai',
      PUSH_OPENROUTER_API_KEY: 'k-openrouter',
    });
    try {
      assert.deepEqual(ids(resolveCliFailoverCandidates('anthropic', new Set(['anthropic']))), []);
    } finally {
      restore();
    }
  });

  it('never fails over from google — gemini is also a single-member bucket', () => {
    const restore = withProviderKeys({
      PUSH_GOOGLE_API_KEY: 'k-google',
      PUSH_OPENAI_API_KEY: 'k-openai',
    });
    try {
      assert.deepEqual(ids(resolveCliFailoverCandidates('google', new Set(['google']))), []);
    } finally {
      restore();
    }
  });

  it('returns [] for an unknown locked provider', () => {
    assert.deepEqual(resolveCliFailoverCandidates('nope', new Set(['nope'])), []);
  });
});
