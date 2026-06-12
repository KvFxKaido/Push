import { describe, expect, it } from 'vitest';

import { resolveDelegationMode } from './delegation-mode';

// Drift pin for the cross-surface opt-in rule: web storage values and the
// CLI's PUSH_DELEGATION_MODE env var both resolve through this function, so
// the "only an exact 'delegated' opts back into the wrapper" contract is
// enforced here once for both surfaces.
describe('resolveDelegationMode', () => {
  it("returns 'delegated' only for the exact opt-in string", () => {
    expect(resolveDelegationMode('delegated')).toBe('delegated');
  });

  it('falls back to inline for missing values', () => {
    expect(resolveDelegationMode(undefined)).toBe('inline');
    expect(resolveDelegationMode(null)).toBe('inline');
    expect(resolveDelegationMode('')).toBe('inline');
  });

  it('falls back to inline for unknown or legacy values', () => {
    expect(resolveDelegationMode('inline')).toBe('inline');
    expect(resolveDelegationMode('DELEGATED')).toBe('inline');
    expect(resolveDelegationMode('true')).toBe('inline');
    expect(resolveDelegationMode('1')).toBe('inline');
  });
});
