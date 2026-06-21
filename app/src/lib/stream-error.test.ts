import { describe, expect, it } from 'vitest';

import {
  ProviderStreamError,
  STREAM_RETRY_MAX,
  isRetryableStreamError,
  isTransientHttpStatus,
  streamRetryDelayMs,
} from './stream-error';

describe('isTransientHttpStatus', () => {
  it('treats 408/425/429 and all 5xx as transient', () => {
    for (const s of [408, 425, 429, 500, 502, 503, 504, 529, 599]) {
      expect(isTransientHttpStatus(s), String(s)).toBe(true);
    }
  });
  it('treats other 4xx (and 2xx/3xx) as terminal', () => {
    for (const s of [400, 401, 403, 404, 422, 200, 301]) {
      expect(isTransientHttpStatus(s), String(s)).toBe(false);
    }
  });
});

describe('ProviderStreamError', () => {
  it('derives retryable from a transient status', () => {
    expect(new ProviderStreamError('Blackbox AI 502: x', { status: 502 }).retryable).toBe(true);
    expect(new ProviderStreamError('OpenAI 400: bad', { status: 400 }).retryable).toBe(false);
  });
  it('honors an explicit retryable override (e.g. stall timeout, no status)', () => {
    expect(new ProviderStreamError('stalled', { retryable: true }).retryable).toBe(true);
    expect(new ProviderStreamError('no status').retryable).toBe(false);
  });
});

describe('isRetryableStreamError', () => {
  it('retries transient ProviderStreamErrors only', () => {
    expect(isRetryableStreamError(new ProviderStreamError('502', { status: 502 }))).toBe(true);
    expect(isRetryableStreamError(new ProviderStreamError('404', { status: 404 }))).toBe(false);
  });
  it('retries duck-typed retryable errors (timeouts from the stream iterator)', () => {
    const e = Object.assign(new Error('stalled'), { retryable: true });
    expect(isRetryableStreamError(e)).toBe(true);
  });
  it('does not retry plain errors or non-errors (no string matching)', () => {
    expect(isRetryableStreamError(new Error('Blackbox AI 502: x'))).toBe(false); // status only in text → not retried
    expect(isRetryableStreamError(null)).toBe(false);
    expect(isRetryableStreamError('502')).toBe(false);
  });
});

describe('streamRetryDelayMs', () => {
  it('backs off exponentially, capped at 4s', () => {
    expect(streamRetryDelayMs(0)).toBe(500);
    expect(streamRetryDelayMs(1)).toBe(1000);
    expect(streamRetryDelayMs(2)).toBe(2000);
    expect(streamRetryDelayMs(5)).toBe(4000); // clamped
  });
  it('exposes a small bounded retry budget', () => {
    expect(STREAM_RETRY_MAX).toBe(2);
  });
});
