import { describe, expect, it } from 'vitest';
import { isAprilFirst } from '@/lib/april-fools';

describe('isAprilFirst', () => {
  it('returns true on April 1st', () => {
    expect(isAprilFirst(new Date(2026, 3, 1, 12, 0, 0))).toBe(true);
  });

  it('returns false on March 31st', () => {
    expect(isAprilFirst(new Date(2026, 2, 31, 23, 59, 59))).toBe(false);
  });

  it('returns false on April 2nd', () => {
    expect(isAprilFirst(new Date(2026, 3, 2, 0, 0, 1))).toBe(false);
  });

  it('returns false in January', () => {
    expect(isAprilFirst(new Date(2026, 0, 1, 0, 0, 0))).toBe(false);
  });
});
