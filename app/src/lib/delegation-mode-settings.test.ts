// Pins the turn dispatch table for the Inline Foreground Lane (see
// `docs/archive/decisions/Inline Foreground Lane — Local While Watched.md`).
// `resolveTurnEngineTrigger` is the single source of truth for which
// runtime a turn takes: 'background-mode' → CoderJob DO engine,
// 'inline-delegation' → foreground inline lane, null → foreground
// Orchestrator loop. Precedence is background-mode first (explicit detach
// is the more specific intent — open question 3, INVERTING the pre-lane
// rule where inline won the measurement label). The setter/hook need a
// DOM and are covered by manual flips; the resolver + getters carry the
// branching logic, so they are what gets pinned here. Mocks
// `./safe-storage` because the app test suite runs in the `node`
// environment with no real localStorage.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ map: new Map<string, string>() }));

vi.mock('./safe-storage', () => ({
  safeStorageGet: (key: string) => storage.map.get(key) ?? null,
  safeStorageSet: (key: string, value: string) => {
    storage.map.set(key, value);
    return true;
  },
  safeStorageRemove: (key: string) => {
    storage.map.delete(key);
    return true;
  },
}));

import {
  getDelegationMode,
  isInlineDelegationEnabled,
  resolveTurnEngineTrigger,
} from './delegation-mode-settings';

const INLINE_KEY = 'push:delegation-mode-preference';
const BG_KEY = 'push:background-mode-preference';

/** Both routes satisfiable — the common repo-workspace shape. */
const ELIGIBLE = { engineEligible: true, inlineEligible: true };

beforeEach(() => {
  storage.map.clear();
});

describe('delegation-mode-settings', () => {
  it('defaults to inline (foreground lane trigger) when no flags are set — the 2026-06-11 flip', () => {
    expect(getDelegationMode()).toBe('inline');
    expect(isInlineDelegationEnabled()).toBe(true);
    expect(resolveTurnEngineTrigger(ELIGIBLE)).toBe('inline-delegation');
  });

  it('only treats the exact "delegated" value as the opt-out (forward-compat with unknown values)', () => {
    storage.map.set(INLINE_KEY, 'inline');
    expect(getDelegationMode()).toBe('inline');
    storage.map.set(INLINE_KEY, 'something-else');
    expect(getDelegationMode()).toBe('inline');
    storage.map.set(INLINE_KEY, 'delegated');
    expect(getDelegationMode()).toBe('delegated');
    expect(isInlineDelegationEnabled()).toBe(false);
  });

  it('keeps the delegated opt-out on the foreground Orchestrator loop (null)', () => {
    storage.map.set(INLINE_KEY, 'delegated');
    expect(resolveTurnEngineTrigger(ELIGIBLE)).toBeNull();
  });

  it('routes a delegated opt-out to background-mode when the detach toggle is on', () => {
    storage.map.set(INLINE_KEY, 'delegated');
    storage.map.set(BG_KEY, '1');
    expect(resolveTurnEngineTrigger(ELIGIBLE)).toBe('background-mode');
  });

  it('routes to the inline lane when delegation-mode is inline', () => {
    storage.map.set(INLINE_KEY, 'inline');
    expect(resolveTurnEngineTrigger(ELIGIBLE)).toBe('inline-delegation');
  });

  it('gives background-mode precedence when both triggers are on — explicit detach wins (open question 3 re-pin)', () => {
    // INVERTS the pre-lane precedence: before the Inline Foreground Lane the
    // two triggers shared one engine route and 'inline-delegation' merely won
    // the measurement label. Now they name different runtimes, and the
    // explicit detach toggle is the more specific intent.
    storage.map.set(INLINE_KEY, 'inline');
    storage.map.set(BG_KEY, '1');
    expect(resolveTurnEngineTrigger(ELIGIBLE)).toBe('background-mode');
    // Same under the inline default (no explicit mode write).
    storage.map.clear();
    storage.map.set(BG_KEY, '1');
    expect(resolveTurnEngineTrigger(ELIGIBLE)).toBe('background-mode');
  });

  it('falls back from an ineligible engine route to the inline lane — the capability fold is engine-only', () => {
    // A Settings-key-only provider can't run in the CoderJob DO (#889/#890),
    // but the inline lane is a foreground run where browser-held keys work.
    // background-mode on + engine-ineligible + inline default → inline lane.
    storage.map.set(BG_KEY, '1');
    expect(
      resolveTurnEngineTrigger({
        engineEligible: false,
        inlineEligible: true,
      }),
    ).toBe('inline-delegation');
  });

  it('forces the Orchestrator loop (null) when neither route is satisfiable — no-repo workspaces', () => {
    // Codex P1 (PR #887): with inline as the DEFAULT, a scratch/chat
    // workspace (no active repo/branch) must stay on the foreground
    // Orchestrator loop — both bypass routes hard-require repo + branch.
    const ineligible = { engineEligible: false, inlineEligible: false };
    expect(resolveTurnEngineTrigger(ineligible)).toBeNull();
    storage.map.set(BG_KEY, '1');
    expect(resolveTurnEngineTrigger(ineligible)).toBeNull();
  });
});
