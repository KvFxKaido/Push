// Pins the routing decision for the Coder Delegation Collapse step-1 A/B
// (see `docs/decisions/Coder Delegation Collapse — Component Audit.md`).
// `resolveTurnEngineTrigger` is the single source of truth for "does this
// turn bypass the Orchestrator and run on the durable engine?", reading
// both named triggers (the `inline` delegation-mode experiment and legacy
// background-mode). The setter/hook need a DOM and are covered by manual
// flips; the resolver + getters carry the branching logic, so they are
// what gets pinned here. Mocks `./safe-storage` because the app test
// suite runs in the `node` environment with no real localStorage.

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

beforeEach(() => {
  storage.map.clear();
});

describe('delegation-mode-settings', () => {
  it('defaults to the delegated arc (no engine trigger) when no flags are set', () => {
    expect(getDelegationMode()).toBe('delegated');
    expect(isInlineDelegationEnabled()).toBe(false);
    expect(resolveTurnEngineTrigger({ hasAttachments: false })).toBeNull();
  });

  it('only treats the exact "inline" value as inline (forward-compat with unknown values)', () => {
    storage.map.set(INLINE_KEY, 'delegated');
    expect(getDelegationMode()).toBe('delegated');
    storage.map.set(INLINE_KEY, 'something-else');
    expect(getDelegationMode()).toBe('delegated');
    storage.map.set(INLINE_KEY, 'inline');
    expect(getDelegationMode()).toBe('inline');
    expect(isInlineDelegationEnabled()).toBe(true);
  });

  it('routes to inline-delegation when delegation-mode is inline', () => {
    storage.map.set(INLINE_KEY, 'inline');
    expect(resolveTurnEngineTrigger({ hasAttachments: false })).toBe('inline-delegation');
  });

  it('routes to background-mode when only the legacy background flag is on', () => {
    storage.map.set(BG_KEY, '1');
    expect(resolveTurnEngineTrigger({ hasAttachments: false })).toBe('background-mode');
  });

  it('gives inline-delegation precedence when both triggers are on', () => {
    storage.map.set(INLINE_KEY, 'inline');
    storage.map.set(BG_KEY, '1');
    expect(resolveTurnEngineTrigger({ hasAttachments: false })).toBe('inline-delegation');
  });

  it('forces the Orchestrator loop (null) when attachments are present, regardless of flags', () => {
    storage.map.set(INLINE_KEY, 'inline');
    storage.map.set(BG_KEY, '1');
    expect(resolveTurnEngineTrigger({ hasAttachments: true })).toBeNull();
  });
});
