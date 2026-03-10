import { useCallback, useMemo, useState } from 'react';
import {
  getExperimentalProviderDescriptor,
  normalizeExperimentalBaseUrl,
  type ExperimentalProviderType,
} from '@/lib/experimental-providers';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/lib/safe-storage';

interface ExperimentalProviderEnv {
  key?: string;
  baseUrl?: string;
  model?: string;
}

interface ExperimentalProviderHookResult {
  key: string | null;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  hasBaseUrl: boolean;
  hasModel: boolean;
  isConfigured: boolean;
  baseUrlError: string | null;
  setKey: (value: string) => void;
  clearKey: () => void;
  setBaseUrl: (value: string) => void;
  clearBaseUrl: () => void;
  setModel: (value: string) => void;
  clearModel: () => void;
}

interface ExperimentalProviderConfigApi {
  getKey: () => string | null;
  getBaseUrl: () => string;
  getModel: () => string;
  useConfig: () => ExperimentalProviderHookResult;
}

function createExperimentalProviderConfig(
  provider: ExperimentalProviderType,
  env: ExperimentalProviderEnv,
): ExperimentalProviderConfigApi {
  const descriptor = getExperimentalProviderDescriptor(provider);
  const keyStorageKey = `${provider}_api_key`;
  const baseUrlStorageKey = `${provider}_base_url`;
  const modelStorageKey = `${provider}_model`;

  const getKey = () => safeStorageGet(keyStorageKey) || env.key?.trim() || null;

  const getBaseUrl = () => {
    const stored = safeStorageGet(baseUrlStorageKey) || env.baseUrl?.trim() || '';
    const normalized = normalizeExperimentalBaseUrl(provider, stored);
    return normalized.ok ? normalized.normalized : stored.trim();
  };

  const getModel = () => safeStorageGet(modelStorageKey) || env.model?.trim() || descriptor.defaultModel;

  return {
    getKey,
    getBaseUrl,
    getModel,
    useConfig: () => {
      const [key, setKeyState] = useState<string | null>(() => getKey());
      const [baseUrl, setBaseUrlState] = useState<string>(() => getBaseUrl());
      const [model, setModelState] = useState<string>(() => getModel());

      const setKey = useCallback((value: string) => {
        const trimmed = value.trim();
        if (!trimmed) return;
        safeStorageSet(keyStorageKey, trimmed);
        setKeyState(trimmed);
      }, [keyStorageKey]);

      const clearKey = useCallback(() => {
        safeStorageRemove(keyStorageKey);
        setKeyState(env.key?.trim() || null);
      }, [keyStorageKey]);

      const setBaseUrl = useCallback((value: string) => {
        const normalized = normalizeExperimentalBaseUrl(provider, value);
        const toStore = normalized.ok ? normalized.normalized : value.trim();
        if (!toStore) return;
        safeStorageSet(baseUrlStorageKey, toStore);
        setBaseUrlState(toStore);
      }, [baseUrlStorageKey]);

      const clearBaseUrl = useCallback(() => {
        safeStorageRemove(baseUrlStorageKey);
        setBaseUrlState(getBaseUrl());
      }, [baseUrlStorageKey]);

      const setModel = useCallback((value: string) => {
        const trimmed = value.trim();
        if (!trimmed) return;
        safeStorageSet(modelStorageKey, trimmed);
        setModelState(trimmed);
      }, [modelStorageKey]);

      const clearModel = useCallback(() => {
        safeStorageRemove(modelStorageKey);
        setModelState(env.model?.trim() || descriptor.defaultModel);
      }, [modelStorageKey]);

      const baseUrlValidation = useMemo(
        () => normalizeExperimentalBaseUrl(provider, baseUrl),
        [baseUrl],
      );

      const hasKey = Boolean(key);
      const hasBaseUrl = baseUrlValidation.ok;
      const hasModel = Boolean(model.trim());

      return {
        key,
        baseUrl,
        model,
        hasKey,
        hasBaseUrl,
        hasModel,
        isConfigured: hasKey && hasBaseUrl && hasModel,
        baseUrlError: baseUrlValidation.ok ? null : (baseUrl ? baseUrlValidation.error : null),
        setKey,
        clearKey,
        setBaseUrl,
        clearBaseUrl,
        setModel,
        clearModel,
      };
    },
  };
}

const azureConfig = createExperimentalProviderConfig('azure', {
  key: import.meta.env.VITE_AZURE_OPENAI_API_KEY,
  baseUrl: import.meta.env.VITE_AZURE_OPENAI_BASE_URL,
  model: import.meta.env.VITE_AZURE_OPENAI_MODEL,
});

const bedrockConfig = createExperimentalProviderConfig('bedrock', {
  key: import.meta.env.VITE_BEDROCK_API_KEY,
  baseUrl: import.meta.env.VITE_BEDROCK_BASE_URL,
  model: import.meta.env.VITE_BEDROCK_MODEL,
});

const vertexConfig = createExperimentalProviderConfig('vertex', {
  key: import.meta.env.VITE_VERTEX_API_KEY,
  baseUrl: import.meta.env.VITE_VERTEX_BASE_URL,
  model: import.meta.env.VITE_VERTEX_MODEL,
});

export const getAzureKey = azureConfig.getKey;
export const getAzureBaseUrl = azureConfig.getBaseUrl;
export const getAzureModelName = azureConfig.getModel;
export function useAzureConfig() {
  return azureConfig.useConfig();
}

export const getBedrockKey = bedrockConfig.getKey;
export const getBedrockBaseUrl = bedrockConfig.getBaseUrl;
export const getBedrockModelName = bedrockConfig.getModel;
export function useBedrockConfig() {
  return bedrockConfig.useConfig();
}

export const getVertexKey = vertexConfig.getKey;
export const getVertexBaseUrl = vertexConfig.getBaseUrl;
export const getVertexModelName = vertexConfig.getModel;
export function useVertexConfig() {
  return vertexConfig.useConfig();
}
