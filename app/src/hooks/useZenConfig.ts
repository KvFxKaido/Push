import { useState, useCallback, useEffect } from 'react';
import {
  ZEN_DEFAULT_MODEL,
  ZEN_MODELS,
  ZEN_GO_MODELS,
  getZenGoMode,
  setZenGoMode as persistZenGoMode,
} from '@/lib/providers';
import { createModelProviderConfig } from './useApiKeyConfig';

const KEY_STORAGE = 'zen_api_key';
const MODEL_STORAGE = 'zen_model';

const providerConfig = createModelProviderConfig({
  storageKey: KEY_STORAGE,
  modelStorageKey: MODEL_STORAGE,
  envVar: import.meta.env.VITE_ZEN_API_KEY,
  defaultModel: ZEN_DEFAULT_MODEL,
});

export const getZenKey = providerConfig.getKey;

export function useZenConfig() {
  const { setModel, ...config } = providerConfig.useConfig();
  const [goMode, setGoModeState] = useState(() => getZenGoMode());

  useEffect(() => {
    if (goMode && !ZEN_GO_MODELS.includes(config.model)) {
      setModel(ZEN_GO_MODELS[0]);
    }
  }, [config.model, goMode, setModel]);

  const setGoMode = useCallback(
    (enabled: boolean) => {
      persistZenGoMode(enabled);
      setGoModeState(enabled);
      // Only swap the model if the current one is incompatible with the
      // target tier — avoids silently overwriting an explicit user choice.
      const currentModel = config.model;
      const compatibleWithTarget = enabled ? ZEN_GO_MODELS : ZEN_MODELS;
      if (!compatibleWithTarget.includes(currentModel)) {
        setModel(enabled ? ZEN_GO_MODELS[0] : ZEN_DEFAULT_MODEL);
      }
    },
    [setModel, config.model],
  );

  return { ...config, setModel, goMode, setGoMode };
}
