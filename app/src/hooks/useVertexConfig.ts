import { useCallback, useMemo, useState } from 'react';
import { normalizeExperimentalBaseUrl } from '@/lib/experimental-providers';
import { safeStorageGet, safeStorageRemove, safeStorageSet } from '@/lib/safe-storage';
import {
  VERTEX_DEFAULT_MODEL,
  VERTEX_DEFAULT_REGION,
  VERTEX_MODEL_OPTIONS,
  getVertexModelTransport,
  looksLikeVertexServiceAccount,
  normalizeVertexRegion,
  parseVertexServiceAccount,
} from '@/lib/vertex-provider';

const VERTEX_SERVICE_ACCOUNT_STORAGE_KEY = 'vertex_service_account';
const VERTEX_REGION_STORAGE_KEY = 'vertex_region';
const VERTEX_MODEL_STORAGE_KEY = 'vertex_model';
const LEGACY_VERTEX_KEY_STORAGE_KEY = 'vertex_api_key';
const LEGACY_VERTEX_BASE_URL_STORAGE_KEY = 'vertex_base_url';

export type VertexConfiguredMode = 'native' | 'legacy' | 'none';

interface VertexConfigEnv {
  serviceAccount?: string;
  region?: string;
  model?: string;
  legacyKey?: string;
  legacyBaseUrl?: string;
}

interface VertexConfigHookResult {
  key: string | null;
  region: string;
  model: string;
  modelOptions: string[];
  hasKey: boolean;
  hasRegion: boolean;
  hasModel: boolean;
  isConfigured: boolean;
  mode: VertexConfiguredMode;
  regionError: string | null;
  keyError: string | null;
  transport: 'openapi' | 'anthropic';
  projectId: string | null;
  hasLegacyConfig: boolean;
  setKey: (value: string) => void;
  clearKey: () => void;
  setRegion: (value: string) => void;
  clearRegion: () => void;
  setModel: (value: string) => void;
  clearModel: () => void;
}

interface VertexConfigApi {
  getKey: () => string | null;
  getRegion: () => string;
  getModel: () => string;
  getMode: () => VertexConfiguredMode;
  getLegacyBaseUrl: () => string;
  useConfig: () => VertexConfigHookResult;
}

function createVertexConfig(env: VertexConfigEnv): VertexConfigApi {
  const getServiceAccount = () => {
    const stored = safeStorageGet(VERTEX_SERVICE_ACCOUNT_STORAGE_KEY);
    if (stored) return stored;
    if (env.serviceAccount?.trim()) return env.serviceAccount.trim();

    const legacy = safeStorageGet(LEGACY_VERTEX_KEY_STORAGE_KEY) || env.legacyKey?.trim() || '';
    return looksLikeVertexServiceAccount(legacy) ? legacy.trim() : null;
  };

  const getLegacyKey = () => {
    const stored = safeStorageGet(LEGACY_VERTEX_KEY_STORAGE_KEY) || env.legacyKey?.trim() || '';
    return looksLikeVertexServiceAccount(stored) ? null : (stored.trim() || null);
  };

  const getLegacyBaseUrl = () => safeStorageGet(LEGACY_VERTEX_BASE_URL_STORAGE_KEY) || env.legacyBaseUrl?.trim() || '';

  const getRegion = () => {
    const stored = safeStorageGet(VERTEX_REGION_STORAGE_KEY) || env.region?.trim() || VERTEX_DEFAULT_REGION;
    const normalized = normalizeVertexRegion(stored);
    return normalized.ok ? normalized.normalized : stored.trim();
  };

  const getModel = () => safeStorageGet(VERTEX_MODEL_STORAGE_KEY) || env.model?.trim() || VERTEX_DEFAULT_MODEL;

  const getMode = (): VertexConfiguredMode => {
    const nativeKey = getServiceAccount();
    const model = getModel();
    const region = getRegion();
    if (nativeKey && parseVertexServiceAccount(nativeKey).ok && normalizeVertexRegion(region).ok && model.trim()) {
      return 'native';
    }

    const legacyKey = getLegacyKey();
    const legacyBaseUrl = getLegacyBaseUrl();
    if (legacyKey && normalizeExperimentalBaseUrl('vertex', legacyBaseUrl).ok && model.trim()) {
      return 'legacy';
    }

    return 'none';
  };

  return {
    getKey: () => {
      const native = getServiceAccount();
      if (native) return native;
      return getLegacyKey();
    },
    getRegion,
    getModel,
    getMode,
    getLegacyBaseUrl,
    useConfig: () => {
      const [key, setKeyState] = useState<string | null>(() => getServiceAccount());
      const [region, setRegionState] = useState<string>(() => getRegion());
      const [model, setModelState] = useState<string>(() => getModel());

      const parsedKey = useMemo(() => parseVertexServiceAccount(key), [key]);
      const regionValidation = useMemo(() => normalizeVertexRegion(region), [region]);
      const mode = useMemo<VertexConfiguredMode>(() => {
        if (parsedKey.ok && regionValidation.ok && model.trim()) return 'native';
        const legacyKey = getLegacyKey();
        const legacyBaseUrl = getLegacyBaseUrl();
        if (legacyKey && normalizeExperimentalBaseUrl('vertex', legacyBaseUrl).ok && model.trim()) {
          return 'legacy';
        }
        return 'none';
      }, [model, parsedKey, regionValidation]);

      const setKey = useCallback((value: string) => {
        const parsed = parseVertexServiceAccount(value);
        if (!parsed.ok) return;
        safeStorageSet(VERTEX_SERVICE_ACCOUNT_STORAGE_KEY, parsed.normalized);
        setKeyState(parsed.normalized);
      }, []);

      const clearKey = useCallback(() => {
        safeStorageRemove(VERTEX_SERVICE_ACCOUNT_STORAGE_KEY);
        safeStorageRemove(LEGACY_VERTEX_KEY_STORAGE_KEY);
        safeStorageRemove(LEGACY_VERTEX_BASE_URL_STORAGE_KEY);
        setKeyState(null);
      }, []);

      const setRegion = useCallback((value: string) => {
        const normalized = normalizeVertexRegion(value);
        const toStore = normalized.ok ? normalized.normalized : value.trim();
        if (!toStore) return;
        safeStorageSet(VERTEX_REGION_STORAGE_KEY, toStore);
        setRegionState(toStore);
      }, []);

      const clearRegion = useCallback(() => {
        safeStorageRemove(VERTEX_REGION_STORAGE_KEY);
        setRegionState(env.region?.trim() || VERTEX_DEFAULT_REGION);
      }, []);

      const setModel = useCallback((value: string) => {
        const trimmed = value.trim();
        if (!trimmed) return;
        safeStorageSet(VERTEX_MODEL_STORAGE_KEY, trimmed);
        setModelState(trimmed);
      }, []);

      const clearModel = useCallback(() => {
        safeStorageRemove(VERTEX_MODEL_STORAGE_KEY);
        setModelState(env.model?.trim() || VERTEX_DEFAULT_MODEL);
      }, []);

      return {
        key,
        region,
        model,
        modelOptions: VERTEX_MODEL_OPTIONS.map((option) => option.id),
        hasKey: Boolean(key),
        hasRegion: regionValidation.ok,
        hasModel: Boolean(model.trim()),
        isConfigured: mode !== 'none',
        mode,
        regionError: regionValidation.ok ? null : (region ? regionValidation.error : null),
        keyError: parsedKey.ok ? null : (key ? parsedKey.error : null),
        transport: getVertexModelTransport(model),
        projectId: parsedKey.ok ? parsedKey.parsed.projectId : null,
        hasLegacyConfig: Boolean(getLegacyKey() && normalizeExperimentalBaseUrl('vertex', getLegacyBaseUrl()).ok),
        setKey,
        clearKey,
        setRegion,
        clearRegion,
        setModel,
        clearModel,
      };
    },
  };
}

const vertexConfig = createVertexConfig({
  serviceAccount: import.meta.env.VITE_VERTEX_SERVICE_ACCOUNT_JSON || import.meta.env.VITE_VERTEX_API_KEY,
  region: import.meta.env.VITE_VERTEX_REGION,
  model: import.meta.env.VITE_VERTEX_MODEL,
  legacyKey: import.meta.env.VITE_VERTEX_API_KEY,
  legacyBaseUrl: import.meta.env.VITE_VERTEX_BASE_URL,
});

export const getVertexKey = vertexConfig.getKey;
export const getVertexRegion = vertexConfig.getRegion;
export const getVertexModelName = vertexConfig.getModel;
export const getVertexMode = vertexConfig.getMode;
export const getVertexBaseUrl = vertexConfig.getLegacyBaseUrl;

export function useVertexConfig() {
  return vertexConfig.useConfig();
}
