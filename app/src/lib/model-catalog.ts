import { getOllamaKey } from '@/hooks/useOllamaConfig';
import { getMistralKey } from '@/hooks/useMistralConfig';

const OLLAMA_MODELS_URL = import.meta.env.DEV
  ? '/ollama/v1/models'
  : '/api/ollama/models';

const MISTRAL_MODELS_URL = import.meta.env.DEV
  ? '/mistral/v1/models'
  : '/api/mistral/models';

import { asRecord } from './utils';

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

  if (Array.isArray(payload)) {
    fromArray(payload);
  } else {
    const rec = asRecord(payload);
    if (rec) {
      if (Array.isArray(rec.data)) fromArray(rec.data);
      if (Array.isArray(rec.models)) fromArray(rec.models);
    }
  }

  return Array.from(ids).sort((a, b) => a.localeCompare(b));
}

async function fetchProviderModels(url: string, key: string | null, providerName: string): Promise<string[]> {
  const headers: HeadersInit = {};
  if (key) headers.Authorization = `Bearer ${key}`;

  const res = await fetch(url, {
    method: 'GET',
    headers,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${providerName} model list failed (${res.status}): ${detail.slice(0, 200)}`);
  }

  const payload = (await res.json()) as unknown;
  return normalizeModelList(payload);
}

export async function fetchOllamaModels(): Promise<string[]> {
  return fetchProviderModels(OLLAMA_MODELS_URL, getOllamaKey(), 'Ollama');
}

export async function fetchMistralModels(): Promise<string[]> {
  return fetchProviderModels(MISTRAL_MODELS_URL, getMistralKey(), 'Mistral');
}
