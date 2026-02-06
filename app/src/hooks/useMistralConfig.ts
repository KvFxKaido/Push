import { useState, useCallback } from 'react';
import { MISTRAL_DEFAULT_MODEL } from '@/lib/providers';

const KEY_STORAGE = 'mistral_api_key';
const MODEL_STORAGE = 'mistral_model';

/**
 * Standalone getter — callable from orchestrator.ts without React.
 * Checks localStorage first, falls back to env var.
 */
export function getMistralKey(): string | null {
  try {
    const stored = localStorage.getItem(KEY_STORAGE);
    if (stored) return stored;
  } catch {
    // SSR / restricted context
  }
  const envKey = import.meta.env.VITE_MISTRAL_API_KEY;
  return envKey || null;
}

/**
 * React hook for Settings UI — manage Mistral Vibe API key + model name.
 */
export function useMistralConfig() {
  const [key, setKeyState] = useState<string | null>(() => getMistralKey());
  const [model, setModelState] = useState<string>(() => {
    try {
      return localStorage.getItem(MODEL_STORAGE) || MISTRAL_DEFAULT_MODEL;
    } catch {
      return MISTRAL_DEFAULT_MODEL;
    }
  });

  const setKey = useCallback((newKey: string) => {
    const trimmed = newKey.trim();
    if (!trimmed) return;
    localStorage.setItem(KEY_STORAGE, trimmed);
    setKeyState(trimmed);
  }, []);

  const clearKey = useCallback(() => {
    localStorage.removeItem(KEY_STORAGE);
    setKeyState(import.meta.env.VITE_MISTRAL_API_KEY || null);
  }, []);

  const setModel = useCallback((newModel: string) => {
    const trimmed = newModel.trim();
    if (!trimmed) return;
    localStorage.setItem(MODEL_STORAGE, trimmed);
    setModelState(trimmed);
  }, []);

  const hasKey = Boolean(key);

  return { key, setKey, clearKey, hasKey, model, setModel };
}
