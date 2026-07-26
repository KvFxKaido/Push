import { useState, useCallback, useEffect } from 'react';
import {
  ZEN_DEFAULT_MODEL,
  ZEN_MODELS,
  ZEN_GO_DEFAULT_MODEL,
  ZEN_GO_MODELS,
  getZenGoMode,
  setZenGoMode as persistZenGoMode,
} from '@/lib/providers';
import { createRegistryModelProviderConfig } from './useApiKeyConfig';

const providerConfig = createRegistryModelProviderConfig('zen', {
  envVar: import.meta.env.VITE_ZEN_API_KEY,
  defaultModel: ZEN_DEFAULT_MODEL,
});

export const getZenKey = providerConfig.getKey;

export function useZenConfig(goCatalogModels: readonly string[] | null = ZEN_GO_MODELS) {
  const { setModel, ...config } = providerConfig.useConfig();
  const [goMode, setGoModeState] = useState(() => getZenGoMode());

  useEffect(() => {
    // A null catalog means the live Go listing has not loaded yet. Defer
    // validation rather than resetting an upstream-only persisted selection
    // against the smaller static fallback seed.
    if (goMode && goCatalogModels && !goCatalogModels.includes(config.model)) {
      setModel(ZEN_GO_DEFAULT_MODEL);
    }
  }, [config.model, goCatalogModels, goMode, setModel]);

  const setGoMode = useCallback(
    (enabled: boolean) => {
      persistZenGoMode(enabled);
      setGoModeState(enabled);
      // Only swap the model if the current one is incompatible with the
      // target tier — avoids silently overwriting an explicit user choice.
      const currentModel = config.model;
      const compatibleWithTarget = enabled ? (goCatalogModels ?? ZEN_GO_MODELS) : ZEN_MODELS;
      if (!compatibleWithTarget.includes(currentModel)) {
        setModel(enabled ? ZEN_GO_DEFAULT_MODEL : ZEN_DEFAULT_MODEL);
      }
    },
    [setModel, config.model, goCatalogModels],
  );

  return { ...config, setModel, goMode, setGoMode };
}
