import { describe, expect, it } from 'vitest';
import { mapCfErrorCode } from './cloudflare-sandbox-provider';

describe('mapCfErrorCode', () => {
  it('maps 413 / SNAPSHOT_TOO_LARGE to a distinct code (not UNKNOWN)', () => {
    // The whole point of the graceful guard: callers can special-case "too
    // large" instead of seeing a generic failure.
    expect(mapCfErrorCode('SNAPSHOT_TOO_LARGE', 413)).toBe('SNAPSHOT_TOO_LARGE');
    // The HTTP status alone is enough, even without the body code.
    expect(mapCfErrorCode(undefined, 413)).toBe('SNAPSHOT_TOO_LARGE');
  });

  it('preserves the existing status/code mappings', () => {
    expect(mapCfErrorCode(undefined, 503)).toBe('NOT_CONFIGURED');
    expect(mapCfErrorCode(undefined, 501)).toBe('SNAPSHOT_FAILED');
    expect(mapCfErrorCode(undefined, 404)).toBe('NOT_FOUND');
    expect(mapCfErrorCode(undefined, 403)).toBe('AUTH_FAILURE');
    expect(mapCfErrorCode('TIMEOUT', 500)).toBe('TIMEOUT');
    expect(mapCfErrorCode('SNAPSHOT_NOT_SUPPORTED', 500)).toBe('SNAPSHOT_FAILED');
  });

  it('falls back to UNKNOWN for unrecognized codes', () => {
    expect(mapCfErrorCode('SOMETHING_NEW', 500)).toBe('UNKNOWN');
    expect(mapCfErrorCode(undefined, 500)).toBe('UNKNOWN');
  });
});
