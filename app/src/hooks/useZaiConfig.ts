import { useState, useCallback } from 'react';
import { ZAI_DEFAULT_MODEL } from '@/lib/providers';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/lib/safe-storage';

const KEY_STORAGE = 'zai_api_key';
const MODEL_STORAGE = 'zai_model';

export function getZaiKey(): string | null {
  const stored = safeStorageGet(KEY_STORAGE);
  if (stored) return stored;
  const envKey = import.meta.env.VITE_ZAI_API_KEY;
  return envKey || null;
}

export function useZaiConfig() {
  const [key, setKeyState] = useState<string | null>(() => getZaiKey());
  const [model, setModelState] = useState<string>(() => {
    return safeStorageGet(MODEL_STORAGE) || ZAI_DEFAULT_MODEL;
  });

  const setKey = useCallback((newKey: string) => {
    const trimmed = newKey.trim();
    if (!trimmed) return;
    safeStorageSet(KEY_STORAGE, trimmed);
    setKeyState(trimmed);
  }, []);

  const clearKey = useCallback(() => {
    safeStorageRemove(KEY_STORAGE);
    setKeyState(import.meta.env.VITE_ZAI_API_KEY || null);
  }, []);

  const setModel = useCallback((newModel: string) => {
    const trimmed = newModel.trim();
    if (!trimmed) return;
    safeStorageSet(MODEL_STORAGE, trimmed);
    setModelState(trimmed);
  }, []);

  const hasKey = Boolean(key);

  return { key, setKey, clearKey, hasKey, model, setModel };
}
