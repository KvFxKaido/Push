import { useState, useCallback } from 'react';
import type { AIProviderType } from '@/types';
import { PROVIDERS } from '@/lib/providers';

const PROVIDER_STORAGE_KEY = 'ai_provider_type';
const KIMI_KEY_STORAGE_KEY = 'moonshot_api_key';
const OLLAMA_KEY_STORAGE_KEY = 'ollama_api_key';

/**
 * Get the active provider type from localStorage, defaulting to 'moonshot'.
 */
function getStoredProvider(): AIProviderType {
  try {
    const stored = localStorage.getItem(PROVIDER_STORAGE_KEY);
    if (stored === 'moonshot' || stored === 'ollama-cloud') {
      return stored;
    }
  } catch {
    // SSR / restricted context
  }
  return 'moonshot';
}

/**
 * Get API key for a specific provider.
 * Checks localStorage first, falls back to env var.
 */
export function getProviderKey(providerType: AIProviderType): string | null {
  const storageKey = providerType === 'moonshot' ? KIMI_KEY_STORAGE_KEY : OLLAMA_KEY_STORAGE_KEY;
  
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored) return stored;
  } catch {
    // SSR / restricted context
  }
  
  // Fall back to env var
  const provider = PROVIDERS.find(p => p.type === providerType);
  const envKey = provider ? import.meta.env[provider.envKey] : null;
  return envKey || null;
}

/**
 * React hook for managing AI provider selection and API keys.
 */
export function useAIProvider() {
  const [activeProvider, setActiveProviderState] = useState<AIProviderType>(() => getStoredProvider());

  const setActiveProvider = useCallback((providerType: AIProviderType) => {
    localStorage.setItem(PROVIDER_STORAGE_KEY, providerType);
    setActiveProviderState(providerType);
  }, []);

  const getKey = useCallback((providerType: AIProviderType) => {
    return getProviderKey(providerType);
  }, []);

  const setKey = useCallback((providerType: AIProviderType, newKey: string) => {
    const trimmed = newKey.trim();
    if (!trimmed) return;
    
    const storageKey = providerType === 'moonshot' ? KIMI_KEY_STORAGE_KEY : OLLAMA_KEY_STORAGE_KEY;
    localStorage.setItem(storageKey, trimmed);
    
    // Force re-render
    setActiveProviderState(prev => prev);
  }, []);

  const clearKey = useCallback((providerType: AIProviderType) => {
    const storageKey = providerType === 'moonshot' ? KIMI_KEY_STORAGE_KEY : OLLAMA_KEY_STORAGE_KEY;
    localStorage.removeItem(storageKey);
    
    // Force re-render
    setActiveProviderState(prev => prev);
  }, []);

  const activeProviderConfig = PROVIDERS.find(p => p.type === activeProvider);
  const activeKey = getKey(activeProvider);
  const hasActiveKey = Boolean(activeKey);

  return {
    activeProvider,
    activeProviderConfig,
    setActiveProvider,
    getKey,
    setKey,
    clearKey,
    hasActiveKey,
    providers: PROVIDERS,
  };
}

// Backwards-compatible standalone getter for orchestrator.ts
export function getMoonshotKey(): string | null {
  return getProviderKey('moonshot');
}
