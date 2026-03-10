import { useCallback, useMemo, useState } from 'react';
import {
  MAX_EXPERIMENTAL_DEPLOYMENTS,
  normalizeExperimentalDeployment,
  parseStoredExperimentalDeployments,
  getExperimentalProviderDescriptor,
  normalizeExperimentalBaseUrl,
  type ExperimentalDeployment,
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
  deployments: ExperimentalDeployment[];
  activeDeploymentId: string | null;
  hasKey: boolean;
  hasBaseUrl: boolean;
  hasModel: boolean;
  isConfigured: boolean;
  deploymentLimitReached: boolean;
  baseUrlError: string | null;
  setKey: (value: string) => void;
  clearKey: () => void;
  setBaseUrl: (value: string) => void;
  clearBaseUrl: () => void;
  setModel: (value: string) => void;
  clearModel: () => void;
  saveDeployment: (baseUrl: string, model: string) => boolean;
  selectDeployment: (id: string) => void;
  removeDeployment: (id: string) => void;
  clearDeployments: () => void;
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
  const deploymentsStorageKey = `${provider}_deployments`;
  const activeDeploymentStorageKey = `${provider}_active_deployment`;

  const getKey = () => safeStorageGet(keyStorageKey) || env.key?.trim() || null;
  const getStoredBaseUrl = () => safeStorageGet(baseUrlStorageKey) || '';
  const getStoredModel = () => safeStorageGet(modelStorageKey) || '';

  const getBaseUrl = () => {
    const stored = getStoredBaseUrl() || env.baseUrl?.trim() || '';
    const normalized = normalizeExperimentalBaseUrl(provider, stored);
    return normalized.ok ? normalized.normalized : stored.trim();
  };

  const getModel = () => getStoredModel() || env.model?.trim() || descriptor.defaultModel;

  const getDeployments = () => {
    const parsed = parseStoredExperimentalDeployments(provider, safeStorageGet(deploymentsStorageKey));
    if (parsed.length > 0) return parsed;
    const legacy = normalizeExperimentalDeployment(provider, {
      baseUrl: getStoredBaseUrl(),
      model: getStoredModel(),
    });
    return legacy ? [legacy] : [];
  };

  const getActiveDeploymentId = () => {
    const deployments = getDeployments();
    if (deployments.length === 0) return null;

    const storedId = safeStorageGet(activeDeploymentStorageKey);
    if (storedId && deployments.some((deployment) => deployment.id === storedId)) {
      return storedId;
    }

    const current = normalizeExperimentalDeployment(provider, {
      baseUrl: getStoredBaseUrl(),
      model: getStoredModel(),
    });
    if (!current) return null;

    return deployments.find(
      (deployment) => deployment.baseUrl === current.baseUrl && deployment.model === current.model,
    )?.id ?? null;
  };

  return {
    getKey,
    getBaseUrl,
    getModel,
    useConfig: () => {
      const [key, setKeyState] = useState<string | null>(() => getKey());
      const [baseUrl, setBaseUrlState] = useState<string>(() => getBaseUrl());
      const [model, setModelState] = useState<string>(() => getModel());
      const [deployments, setDeploymentsState] = useState<ExperimentalDeployment[]>(() => getDeployments());
      const [activeDeploymentId, setActiveDeploymentIdState] = useState<string | null>(() => getActiveDeploymentId());

      const syncActiveDeployment = useCallback((
        nextBaseUrl: string,
        nextModel: string,
        nextDeployments: ExperimentalDeployment[],
      ) => {
        const normalized = normalizeExperimentalDeployment(provider, {
          baseUrl: nextBaseUrl,
          model: nextModel,
        });
        const matchingId = normalized
          ? nextDeployments.find(
            (deployment) => deployment.baseUrl === normalized.baseUrl && deployment.model === normalized.model,
          )?.id ?? null
          : null;

        if (matchingId) {
          safeStorageSet(activeDeploymentStorageKey, matchingId);
        } else {
          safeStorageRemove(activeDeploymentStorageKey);
        }
        setActiveDeploymentIdState(matchingId);
      }, [activeDeploymentStorageKey]);

      const persistDeployments = useCallback((nextDeployments: ExperimentalDeployment[]) => {
        const limited = nextDeployments.slice(0, MAX_EXPERIMENTAL_DEPLOYMENTS);
        if (limited.length > 0) {
          safeStorageSet(deploymentsStorageKey, JSON.stringify(limited));
        } else {
          safeStorageRemove(deploymentsStorageKey);
        }
        setDeploymentsState(limited);
        return limited;
      }, [deploymentsStorageKey]);

      const resetCurrentDeployment = useCallback(() => {
        safeStorageRemove(baseUrlStorageKey);
        safeStorageRemove(modelStorageKey);
        setBaseUrlState(getBaseUrl());
        setModelState(env.model?.trim() || descriptor.defaultModel);
      }, [baseUrlStorageKey, modelStorageKey]);

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
        syncActiveDeployment(toStore, model, deployments);
      }, [baseUrlStorageKey, deployments, model, syncActiveDeployment]);

      const clearBaseUrl = useCallback(() => {
        safeStorageRemove(baseUrlStorageKey);
        setBaseUrlState(getBaseUrl());
        syncActiveDeployment(getBaseUrl(), model, deployments);
      }, [baseUrlStorageKey, deployments, model, syncActiveDeployment]);

      const setModel = useCallback((value: string) => {
        const trimmed = value.trim();
        if (!trimmed) return;
        safeStorageSet(modelStorageKey, trimmed);
        setModelState(trimmed);
        syncActiveDeployment(baseUrl, trimmed, deployments);
      }, [baseUrl, deployments, modelStorageKey, syncActiveDeployment]);

      const clearModel = useCallback(() => {
        safeStorageRemove(modelStorageKey);
        setModelState(env.model?.trim() || descriptor.defaultModel);
        syncActiveDeployment(baseUrl, env.model?.trim() || descriptor.defaultModel, deployments);
      }, [baseUrl, deployments, modelStorageKey, syncActiveDeployment]);

      const saveDeployment = useCallback((rawBaseUrl: string, rawModel: string) => {
        const normalized = normalizeExperimentalDeployment(provider, {
          baseUrl: rawBaseUrl,
          model: rawModel,
        });
        if (!normalized) return false;

        const existing = deployments.find(
          (deployment) => deployment.baseUrl === normalized.baseUrl && deployment.model === normalized.model,
        );
        const selected = existing ?? normalized;

        if (!existing && deployments.length >= MAX_EXPERIMENTAL_DEPLOYMENTS) {
          return false;
        }

        const nextDeployments = existing
          ? deployments
          : persistDeployments([...deployments, normalized]);

        safeStorageSet(baseUrlStorageKey, selected.baseUrl);
        safeStorageSet(modelStorageKey, selected.model);
        safeStorageSet(activeDeploymentStorageKey, selected.id);
        setBaseUrlState(selected.baseUrl);
        setModelState(selected.model);
        setActiveDeploymentIdState(selected.id);
        if (existing) {
          setDeploymentsState(nextDeployments);
        }
        return true;
      }, [
        activeDeploymentStorageKey,
        baseUrlStorageKey,
        deployments,
        modelStorageKey,
        persistDeployments,
      ]);

      const selectDeployment = useCallback((id: string) => {
        const selected = deployments.find((deployment) => deployment.id === id);
        if (!selected) return;
        safeStorageSet(baseUrlStorageKey, selected.baseUrl);
        safeStorageSet(modelStorageKey, selected.model);
        safeStorageSet(activeDeploymentStorageKey, selected.id);
        setBaseUrlState(selected.baseUrl);
        setModelState(selected.model);
        setActiveDeploymentIdState(selected.id);
      }, [activeDeploymentStorageKey, baseUrlStorageKey, deployments, modelStorageKey]);

      const removeDeployment = useCallback((id: string) => {
        const nextDeployments = persistDeployments(deployments.filter((deployment) => deployment.id !== id));
        if (activeDeploymentId !== id) {
          syncActiveDeployment(baseUrl, model, nextDeployments);
          return;
        }

        const nextActive = nextDeployments[0] ?? null;
        if (nextActive) {
          safeStorageSet(baseUrlStorageKey, nextActive.baseUrl);
          safeStorageSet(modelStorageKey, nextActive.model);
          safeStorageSet(activeDeploymentStorageKey, nextActive.id);
          setBaseUrlState(nextActive.baseUrl);
          setModelState(nextActive.model);
          setActiveDeploymentIdState(nextActive.id);
          return;
        }

        safeStorageRemove(activeDeploymentStorageKey);
        setActiveDeploymentIdState(null);
        resetCurrentDeployment();
      }, [
        activeDeploymentId,
        activeDeploymentStorageKey,
        baseUrl,
        baseUrlStorageKey,
        deployments,
        model,
        modelStorageKey,
        persistDeployments,
        resetCurrentDeployment,
        syncActiveDeployment,
      ]);

      const clearDeployments = useCallback(() => {
        safeStorageRemove(activeDeploymentStorageKey);
        safeStorageRemove(deploymentsStorageKey);
        setDeploymentsState([]);
        setActiveDeploymentIdState(null);
        resetCurrentDeployment();
      }, [activeDeploymentStorageKey, deploymentsStorageKey, resetCurrentDeployment]);

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
        deployments,
        activeDeploymentId,
        hasKey,
        hasBaseUrl,
        hasModel,
        isConfigured: hasKey && hasBaseUrl && hasModel,
        deploymentLimitReached: deployments.length >= MAX_EXPERIMENTAL_DEPLOYMENTS,
        baseUrlError: baseUrlValidation.ok ? null : (baseUrl ? baseUrlValidation.error : null),
        setKey,
        clearKey,
        setBaseUrl,
        clearBaseUrl,
        setModel,
        clearModel,
        saveDeployment,
        selectDeployment,
        removeDeployment,
        clearDeployments,
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
