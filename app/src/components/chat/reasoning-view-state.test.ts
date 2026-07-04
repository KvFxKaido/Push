import { describe, expect, it } from 'vitest';
import { reasoningPaneOpen, reasoningTogglePatch } from './reasoning-view-state';

describe('reasoningPaneOpen', () => {
  it('follows streaming while the user has not toggled', () => {
    expect(reasoningPaneOpen({ reasoningUserSet: false, reasoningExpanded: false }, true)).toBe(
      true,
    );
    expect(reasoningPaneOpen({ reasoningUserSet: false, reasoningExpanded: false }, false)).toBe(
      false,
    );
  });

  it('honors the pinned choice and ignores streaming once toggled', () => {
    // Pinned closed wins even while streaming.
    expect(reasoningPaneOpen({ reasoningUserSet: true, reasoningExpanded: false }, true)).toBe(
      false,
    );
    // Pinned open persists after settling.
    expect(reasoningPaneOpen({ reasoningUserSet: true, reasoningExpanded: true }, false)).toBe(
      true,
    );
  });
});

describe('reasoningTogglePatch', () => {
  it('always pins the user choice (guards the auto-open from re-opening it)', () => {
    expect(reasoningTogglePatch(false)).toEqual({
      reasoningExpanded: false,
      reasoningUserSet: true,
    });
    expect(reasoningTogglePatch(true)).toEqual({ reasoningExpanded: true, reasoningUserSet: true });
  });
});
