import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetSettingsStoreForTests, setSetting, SETTINGS_KEYS } from './settings-store';
import { getRunTokenBudgetPref, RUN_TOKEN_BUDGET_PRESETS } from './run-token-budget-pref';

function storageMock() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => (data.has(k) ? data.get(k)! : null),
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('window', { localStorage: storageMock() });
  __resetSettingsStoreForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('getRunTokenBudgetPref', () => {
  it('defaults to off (null) when unset', () => {
    expect(getRunTokenBudgetPref()).toBeNull();
  });

  it('returns a positive cap when set to a number', () => {
    setSetting(SETTINGS_KEYS.runTokenBudget, 250_000);
    expect(getRunTokenBudgetPref()).toBe(250_000);
  });

  it('treats an explicit null / zero as off', () => {
    setSetting(SETTINGS_KEYS.runTokenBudget, null);
    expect(getRunTokenBudgetPref()).toBeNull();
    setSetting(SETTINGS_KEYS.runTokenBudget, 0);
    expect(getRunTokenBudgetPref()).toBeNull();
  });

  it('degrades a malformed stored value to off rather than throwing', () => {
    setSetting(SETTINGS_KEYS.runTokenBudget, 'garbage');
    expect(getRunTokenBudgetPref()).toBeNull();
  });

  it('exposes presets with Off first and ascending caps', () => {
    expect(RUN_TOKEN_BUDGET_PRESETS[0]).toEqual({ label: 'Off', value: null });
    const caps = RUN_TOKEN_BUDGET_PRESETS.slice(1).map((p) => p.value as number);
    expect(caps).toEqual([...caps].sort((a, b) => a - b));
    // Every preset value is round-trippable through the accessor.
    for (const preset of RUN_TOKEN_BUDGET_PRESETS) {
      setSetting(SETTINGS_KEYS.runTokenBudget, preset.value);
      expect(getRunTokenBudgetPref()).toBe(preset.value);
    }
  });
});
