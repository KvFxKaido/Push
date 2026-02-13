/**
 * Factory for API key management hooks.
 *
 * All five provider config hooks (Moonshot, Tavily, Ollama, Mistral, Z.ai)
 * share the same skeleton: a standalone getter (localStorage → env var fallback)
 * and a React hook that wraps useState + useCallback for set/clear/hasKey.
 *
 * This factory eliminates that duplication. Each hook file becomes a thin
 * wrapper that specifies its storage key, env var, and optional model config.
 */

import { useState, useCallback } from 'react';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/lib/safe-storage';

// ---------------------------------------------------------------------------
// Standalone getter factory
// ---------------------------------------------------------------------------

export function createApiKeyGetter(
  storageKey: string,
  envVar: string | undefined,
): () => string | null {
  return () => {
    const stored = safeStorageGet(storageKey);
    if (stored) return stored;
    return envVar || null;
  };
}

// ---------------------------------------------------------------------------
// Key-only hook (Moonshot, Tavily)
// ---------------------------------------------------------------------------

interface ApiKeyHookResult {
  key: string | null;
  setKey: (newKey: string) => void;
  clearKey: () => void;
  hasKey: boolean;
}

export function useApiKeyConfig(
  storageKey: string,
  envVar: string | undefined,
  getter: () => string | null,
): ApiKeyHookResult {
  const [key, setKeyState] = useState<string | null>(() => getter());

  const setKey = useCallback((newKey: string) => {
    const trimmed = newKey.trim();
    if (!trimmed) return;
    safeStorageSet(storageKey, trimmed);
    setKeyState(trimmed);
  }, [storageKey]);

  const clearKey = useCallback(() => {
    safeStorageRemove(storageKey);
    setKeyState(envVar || null);
  }, [storageKey, envVar]);

  const hasKey = Boolean(key);

  return { key, setKey, clearKey, hasKey };
}

// ---------------------------------------------------------------------------
// Key + model hook (Ollama, Mistral, Z.ai)
// ---------------------------------------------------------------------------

interface ApiKeyWithModelHookResult extends ApiKeyHookResult {
  model: string;
  setModel: (newModel: string) => void;
}

export function useApiKeyWithModelConfig(
  keyStorageKey: string,
  modelStorageKey: string,
  envVar: string | undefined,
  defaultModel: string,
  getter: () => string | null,
): ApiKeyWithModelHookResult {
  const { key, setKey, clearKey, hasKey } = useApiKeyConfig(keyStorageKey, envVar, getter);

  const [model, setModelState] = useState<string>(() => {
    return safeStorageGet(modelStorageKey) || defaultModel;
  });

  const setModel = useCallback((newModel: string) => {
    const trimmed = newModel.trim();
    if (!trimmed) return;
    safeStorageSet(modelStorageKey, trimmed);
    setModelState(trimmed);
  }, [modelStorageKey]);

  return { key, setKey, clearKey, hasKey, model, setModel };
}
