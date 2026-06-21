import { describe, expect, it } from 'vitest';
import {
  decideStreamFailover,
  isFailoverWorthy,
  type FailoverInput,
  type StreamErrorClassification,
} from './provider-failover.js';

function base(overrides: Partial<FailoverInput> = {}): FailoverInput {
  return {
    classification: { retryable: true },
    aborted: false,
    hasOutput: false,
    sameProviderAttempt: 0,
    sameProviderMax: 2,
    tried: new Set(['anthropic']),
    candidates: ['openai', 'google'],
    retryDelayMs: 500,
    ...overrides,
  };
}

describe('isFailoverWorthy', () => {
  it('treats every transient error as failover-worthy regardless of status', () => {
    expect(isFailoverWorthy({ retryable: true })).toBe(true);
    expect(isFailoverWorthy({ retryable: true, status: 503 })).toBe(true);
  });

  it('treats auth (401/403) and not-found (404) as failover-worthy even when not retryable', () => {
    expect(isFailoverWorthy({ retryable: false, status: 401 })).toBe(true);
    expect(isFailoverWorthy({ retryable: false, status: 403 })).toBe(true);
    expect(isFailoverWorthy({ retryable: false, status: 404 })).toBe(true);
  });

  it('does NOT fail over on malformed-request errors that fail everywhere', () => {
    expect(isFailoverWorthy({ retryable: false, status: 400 })).toBe(false);
    expect(isFailoverWorthy({ retryable: false, status: 422 })).toBe(false);
  });

  it('does not fail over when there is no status and the error is not retryable', () => {
    expect(isFailoverWorthy({ retryable: false })).toBe(false);
  });
});

describe('decideStreamFailover — unsafe-to-reattempt guards', () => {
  it('gives up on user abort before considering retry or failover', () => {
    const d = decideStreamFailover(base({ aborted: true }));
    expect(d).toEqual({ action: 'give-up', reason: 'aborted' });
  });

  it('gives up once output has streamed (re-attempt would duplicate visible text)', () => {
    const d = decideStreamFailover(base({ hasOutput: true }));
    expect(d).toEqual({ action: 'give-up', reason: 'has-output' });
  });

  it('abort takes precedence over output', () => {
    const d = decideStreamFailover(base({ aborted: true, hasOutput: true }));
    expect(d).toEqual({ action: 'give-up', reason: 'aborted' });
  });
});

describe('decideStreamFailover — same-provider retry', () => {
  it('retries the same provider while the budget remains, surfacing the backoff', () => {
    const d = decideStreamFailover(base({ sameProviderAttempt: 0, retryDelayMs: 750 }));
    expect(d).toEqual({ action: 'retry-same', delayMs: 750 });
  });

  it('stops retrying the same provider once the budget is spent and fails over', () => {
    const d = decideStreamFailover(base({ sameProviderAttempt: 2, sameProviderMax: 2 }));
    expect(d).toEqual({ action: 'failover', provider: 'openai' });
  });

  it('does not retry-same for a non-retryable but failover-worthy error', () => {
    const d = decideStreamFailover(base({ classification: { retryable: false, status: 401 } }));
    expect(d).toEqual({ action: 'failover', provider: 'openai' });
  });
});

describe('decideStreamFailover — failover candidate selection', () => {
  it('picks the first candidate not already tried', () => {
    const d = decideStreamFailover(
      base({
        sameProviderAttempt: 2,
        tried: new Set(['anthropic', 'openai']),
        candidates: ['openai', 'google'],
      }),
    );
    expect(d).toEqual({ action: 'failover', provider: 'google' });
  });

  it('reports candidates-exhausted when every candidate was already tried', () => {
    const d = decideStreamFailover(
      base({
        sameProviderAttempt: 2,
        tried: new Set(['anthropic', 'openai', 'google']),
        candidates: ['openai', 'google'],
      }),
    );
    expect(d).toEqual({ action: 'give-up', reason: 'candidates-exhausted' });
  });

  it('reports candidates-exhausted when the candidate list is empty', () => {
    const d = decideStreamFailover(base({ sameProviderAttempt: 2, candidates: [] }));
    expect(d).toEqual({ action: 'give-up', reason: 'candidates-exhausted' });
  });
});

describe('decideStreamFailover — terminal errors', () => {
  it('gives up with terminal-error on a malformed-request failure', () => {
    const cls: StreamErrorClassification = { retryable: false, status: 400 };
    const d = decideStreamFailover(base({ classification: cls, sameProviderAttempt: 0 }));
    expect(d).toEqual({ action: 'give-up', reason: 'terminal-error' });
  });

  it('gives up with terminal-error on an unclassifiable non-retryable failure', () => {
    const d = decideStreamFailover(base({ classification: { retryable: false } }));
    expect(d).toEqual({ action: 'give-up', reason: 'terminal-error' });
  });
});
