import { getOllamaKey } from '@/hooks/useOllamaConfig';
import { getMistralKey } from '@/hooks/useMistralConfig';
import { getOpenRouterKey } from '@/hooks/useOpenRouterConfig';
import { getMinimaxKey } from '@/hooks/useMinimaxConfig';
import { getZaiKey } from '@/hooks/useZaiConfig';
import { getGoogleKey } from '@/hooks/useGoogleConfig';
import { getZenKey } from '@/hooks/useZenConfig';
import { PROVIDER_URLS } from './providers';
import { asRecord } from './utils';

const MODELS_FETCH_TIMEOUT_MS = 12_000;

function normalizeModelList(payload: unknown): string[] {
  const ids = new Set<string>();

  const maybePushId = (value: unknown) => {
    if (typeof value === 'string' && value.trim()) {
      ids.add(value.trim());
    }
  };

  const fromArray = (arr: unknown[]) => {
    for (const item of arr) {
      if (typeof item === 'string') {
        maybePushId(item);
        continue;
      }
      const rec = asRecord(item);
      if (!rec) continue;
      maybePushId(rec.id);
      maybePushId(rec.name);
      maybePushId(rec.model);
    }
  };

  const visited = new WeakSet<object>();
  const fromRecord = (rec: Record<string, unknown>) => {
    if (visited.has(rec)) return;
    visited.add(rec);

    if (Array.isArray(rec.data)) fromArray(rec.data);
    if (Array.isArray(rec.models)) fromArray(rec.models);
    if (Array.isArray(rec.items)) fromArray(rec.items);
    if (Array.isArray(rec.list)) fromArray(rec.list);
    if (Array.isArray(rec.model_list)) fromArray(rec.model_list);

    const nestedData = asRecord(rec.data);
    if (nestedData) fromRecord(nestedData);
    const nestedResult = asRecord(rec.result);
    if (nestedResult) fromRecord(nestedResult);
    const nestedOutput = asRecord(rec.output);
    if (nestedOutput) fromRecord(nestedOutput);
  };

  if (Array.isArray(payload)) {
    fromArray(payload);
  } else {
    const rec = asRecord(payload);
    if (rec) fromRecord(rec);
  }

  return Array.from(ids).sort((a, b) => a.localeCompare(b));
}

async function fetchProviderModels(url: string, key: string | null, providerName: string): Promise<string[]> {
  const headers: HeadersInit = {};
  if (key) headers.Authorization = `Bearer ${key}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), MODELS_FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
      cache: 'no-store',
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`${providerName} model list failed (${res.status}): ${detail.slice(0, 200)}`);
    }

    const payload = (await res.json()) as unknown;
    return normalizeModelList(payload);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`${providerName} model list timed out after ${Math.floor(MODELS_FETCH_TIMEOUT_MS / 1000)}s`);
    }
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

export async function fetchOllamaModels(): Promise<string[]> {
  return fetchProviderModels(PROVIDER_URLS.ollama.models, getOllamaKey(), 'Ollama');
}

export async function fetchMistralModels(): Promise<string[]> {
  return fetchProviderModels(PROVIDER_URLS.mistral.models, getMistralKey(), 'Mistral');
}

export async function fetchOpenRouterModels(): Promise<string[]> {
  return fetchProviderModels(PROVIDER_URLS.openrouter.models, getOpenRouterKey(), 'OpenRouter');
}

export async function fetchMinimaxModels(): Promise<string[]> {
  return fetchProviderModels(PROVIDER_URLS.minimax.models, getMinimaxKey(), 'MiniMax');
}

export async function fetchZaiModels(): Promise<string[]> {
  return fetchProviderModels(PROVIDER_URLS.zai.models, getZaiKey(), 'Z.AI');
}

export async function fetchGoogleModels(): Promise<string[]> {
  return fetchProviderModels(PROVIDER_URLS.google.models, getGoogleKey(), 'Google');
}

export async function fetchZenModels(): Promise<string[]> {
  return fetchProviderModels(PROVIDER_URLS.zen.models, getZenKey(), 'OpenCode Zen');
}
