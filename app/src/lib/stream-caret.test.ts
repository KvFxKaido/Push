import { describe, expect, it } from 'vitest';
import { resolveStreamCaret, STREAM_CARET_DEFAULT } from './stream-caret';

// The node test env has no `window`, so the resolver must take its SSR-safe
// path and return the default. The URL / localStorage override branches need a
// DOM and are exercised at runtime, not here.
describe('resolveStreamCaret', () => {
  it('defaults to the pill caret', () => {
    expect(STREAM_CARET_DEFAULT).toBe('pill');
  });

  it('returns the default when there is no window (SSR)', () => {
    expect(resolveStreamCaret()).toBe('pill');
  });
});
