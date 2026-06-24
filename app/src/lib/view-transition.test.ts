import { describe, expect, it, vi } from 'vitest';
import { runViewTransition, supportsViewTransitions } from './view-transition';

// The test runs in the `node` environment: no `document`, so the API is
// unsupported and runViewTransition must fall back to a synchronous update.
describe('runViewTransition', () => {
  it('reports no support when document is absent', () => {
    expect(supportsViewTransitions()).toBe(false);
  });

  it('runs the update synchronously when the API is unavailable', () => {
    const update = vi.fn();
    runViewTransition(update);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('runs the update synchronously (still applied) when disabled', () => {
    const update = vi.fn();
    runViewTransition(update, { disabled: true });
    expect(update).toHaveBeenCalledTimes(1);
  });
});
