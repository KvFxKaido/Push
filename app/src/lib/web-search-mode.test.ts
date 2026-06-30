import { beforeEach, describe, expect, it, vi } from 'vitest';

// Test env is `node` (no DOM, no localStorage). Stub `safe-storage` with a
// per-test in-memory map so the mode round-trips through the real getter/setter.
const store = new Map<string, string>();
vi.mock('./safe-storage', () => ({
  safeStorageGet: (key: string) => store.get(key) ?? null,
  safeStorageSet: (key: string, value: string) => {
    store.set(key, value);
    return true;
  },
}));

import {
  getAutoNativeSearchLabel,
  getWebSearchMode,
  getWebSearchModeUnavailableReason,
  isNativeWebSearchEnabled,
  setWebSearchMode,
} from './web-search-mode';

beforeEach(() => {
  store.clear();
});

describe('getWebSearchMode / setWebSearchMode', () => {
  it('defaults to "auto" when no value is stored', () => {
    expect(getWebSearchMode()).toBe('auto');
  });

  it('round-trips through the storage backend', () => {
    setWebSearchMode('tavily');
    expect(getWebSearchMode()).toBe('tavily');
    setWebSearchMode('off');
    expect(getWebSearchMode()).toBe('off');
  });

  it('falls back to "auto" when storage holds an unknown value', () => {
    store.set('push:web-search-mode', 'not-a-mode');
    expect(getWebSearchMode()).toBe('auto');
  });
});

describe('getWebSearchModeUnavailableReason', () => {
  const baseCtx = {
    activeProvider: 'anthropic',
    hasTavilyKey: false,
    hasGoogleKey: false,
    hasOllamaKey: false,
  };

  it('always allows off / auto / duckduckgo regardless of context', () => {
    expect(getWebSearchModeUnavailableReason('off', baseCtx)).toBeNull();
    expect(getWebSearchModeUnavailableReason('auto', baseCtx)).toBeNull();
    expect(getWebSearchModeUnavailableReason('duckduckgo', baseCtx)).toBeNull();
  });

  it('gates tavily on a configured key', () => {
    expect(getWebSearchModeUnavailableReason('tavily', baseCtx)).toMatch(/Tavily/);
    expect(
      getWebSearchModeUnavailableReason('tavily', { ...baseCtx, hasTavilyKey: true }),
    ).toBeNull();
  });

  it('gates google-grounding on both a key and the active provider matching google', () => {
    expect(getWebSearchModeUnavailableReason('google-grounding', baseCtx)).toMatch(
      /Google API key/,
    );
    expect(
      getWebSearchModeUnavailableReason('google-grounding', { ...baseCtx, hasGoogleKey: true }),
    ).toMatch(/Switch the chat to the Google provider/);
    expect(
      getWebSearchModeUnavailableReason('google-grounding', {
        ...baseCtx,
        hasGoogleKey: true,
        activeProvider: 'google',
      }),
    ).toBeNull();
  });

  it('gates ollama on key + active provider matching ollama', () => {
    expect(getWebSearchModeUnavailableReason('ollama', baseCtx)).toMatch(/Ollama key/);
    expect(
      getWebSearchModeUnavailableReason('ollama', {
        ...baseCtx,
        hasOllamaKey: true,
        activeProvider: 'ollama',
      }),
    ).toBeNull();
  });
});

describe('isNativeWebSearchEnabled', () => {
  it('enables native search on "auto" for providers that have a native tool', () => {
    for (const provider of [
      'google',
      'anthropic',
      'vertex',
      'openrouter',
      // Responses-native providers that implement OpenAI's `web_search` tool.
      'openai',
      'sakana',
    ]) {
      expect(isNativeWebSearchEnabled(provider, undefined, 'auto')).toBe(true);
    }
  });

  it('leaves native-less providers on the prompt-engineered path under "auto"', () => {
    // Fireworks speaks the Responses API but does NOT implement the built-in
    // `web_search` tool, so it must stay off the native path.
    for (const provider of ['fireworks', 'ollama', 'zen', 'kilocode', 'nvidia']) {
      expect(isNativeWebSearchEnabled(provider, undefined, 'auto')).toBe(false);
    }
  });

  it('suppresses native search for every provider when mode is "off"', () => {
    for (const provider of ['google', 'anthropic', 'vertex', 'openrouter', 'openai', 'sakana']) {
      expect(isNativeWebSearchEnabled(provider, undefined, 'off')).toBe(false);
    }
  });

  it('does not enable native search under explicit non-native backends', () => {
    for (const mode of ['tavily', 'duckduckgo', 'ollama'] as const) {
      expect(isNativeWebSearchEnabled('openrouter', undefined, mode)).toBe(false);
      expect(isNativeWebSearchEnabled('sakana', undefined, mode)).toBe(false);
    }
  });
});

describe('getAutoNativeSearchLabel', () => {
  it('names the native search Auto resolves to for each native provider', () => {
    expect(getAutoNativeSearchLabel('openrouter')).toBe('OpenRouter');
    expect(getAutoNativeSearchLabel('anthropic')).toBe('Anthropic');
    expect(getAutoNativeSearchLabel('google')).toBe('Google');
    expect(getAutoNativeSearchLabel('vertex')).toBe('Vertex');
    expect(getAutoNativeSearchLabel('openai')).toBe('OpenAI');
    expect(getAutoNativeSearchLabel('sakana')).toBe('Sakana');
  });

  it('returns null for providers without a native tool (Auto falls back to prompt-engineered)', () => {
    // Fireworks included: Responses-API, but no built-in web_search tool.
    for (const provider of ['fireworks', 'ollama', 'zen', 'kilocode', 'nvidia']) {
      expect(getAutoNativeSearchLabel(provider)).toBeNull();
    }
  });

  it('stays in lockstep with isNativeWebSearchEnabled under auto', () => {
    for (const provider of [
      'openrouter',
      'anthropic',
      'google',
      'vertex',
      'openai',
      'sakana',
      'fireworks',
      'ollama',
      'zen',
    ]) {
      const hasNative = isNativeWebSearchEnabled(provider, undefined, 'auto');
      expect(getAutoNativeSearchLabel(provider) !== null).toBe(hasNative);
    }
  });
});
