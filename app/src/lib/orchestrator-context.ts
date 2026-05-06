import {
  budgetFromWindow,
  type ContextBudget,
  DEFAULT_CONTEXT_BUDGET,
  getContextBudget as getContextBudgetByName,
  stripRoutingSuffix,
} from '@push/lib/context-budget';
import type { AIProviderType } from '@/types';
import { getModelCapabilities } from './model-catalog';

// Re-export the shared budget shape + default so existing callers keep working.
// The math (ratios, name-pattern fallback table) lives in `@push/lib/context-budget`
// so the CLI and web stay in lockstep — only the catalog probe below is web-only.
export type { ContextBudget };
export { DEFAULT_CONTEXT_BUDGET };

// Context mode config (runtime toggle from Settings)
const CONTEXT_MODE_STORAGE_KEY = 'push_context_mode';
export type ContextMode = 'graceful' | 'none';

// Catalog metadata (models.dev) only loads for providers that fetch it:
// openrouter, blackbox, nvidia, ollama, zen. Other providers (cloudflare,
// vertex, bedrock, azure, kilocode, openadapter) hand us a model name with
// no metadata, so we probe sibling catalogs by name and finally fall through
// to the shared name-pattern table that captures the major model families'
// real context windows.
const CATALOG_PROBE_PROVIDERS: readonly AIProviderType[] = [
  'openrouter',
  'zen',
  'ollama',
  'nvidia',
  'blackbox',
];

function probeWindow(provider: AIProviderType, model: string): number {
  const direct = getModelCapabilities(provider, model).contextLimit;
  if (direct > 0) return direct;
  const baseId = stripRoutingSuffix(model);
  if (baseId === model) return 0;
  return getModelCapabilities(provider, baseId).contextLimit;
}

function lookupCatalogWindow(provider: AIProviderType | undefined, model: string): number {
  if (provider) {
    const cap = probeWindow(provider, model);
    if (cap > 0) return cap;
  }
  // Same model id often exists in another provider's catalog (e.g.,
  // gemini-2.5-pro is in OpenRouter, Zen, and Ollama metadata). Try those
  // before letting the shared name-pattern fallback take over.
  for (const probe of CATALOG_PROBE_PROVIDERS) {
    if (probe === provider) continue;
    const cap = probeWindow(probe, model);
    if (cap > 0) return cap;
  }
  return 0;
}

export function getContextBudget(provider?: AIProviderType, model?: string): ContextBudget {
  const normalizedModel = (model || '').trim();
  if (!normalizedModel) return { ...DEFAULT_CONTEXT_BUDGET };
  const catalogWindow = lookupCatalogWindow(provider, normalizedModel);
  if (catalogWindow > 0) return budgetFromWindow(catalogWindow);
  // No catalog hit — defer to the shared name-pattern resolver. This mirrors
  // exactly what the CLI does, so the two surfaces converge whenever the
  // catalog is silent.
  return getContextBudgetByName(provider, normalizedModel);
}

export function getContextMode(): ContextMode {
  try {
    const stored = localStorage.getItem(CONTEXT_MODE_STORAGE_KEY);
    if (stored === 'none') return 'none';
  } catch {
    // ignore storage errors
  }
  return 'graceful';
}

export function setContextMode(mode: ContextMode): void {
  try {
    localStorage.setItem(CONTEXT_MODE_STORAGE_KEY, mode);
  } catch {
    // ignore storage errors
  }
}

// ---------------------------------------------------------------------------
// Token Estimation — re-exported from the shared runtime so web + CLI run on
// the same content-aware heuristic. ChatMessage is structurally compatible
// with lib's TokenEstimationMessage (content/thinking/attachments[].type).
// ---------------------------------------------------------------------------
export {
  estimateContextTokens,
  estimateMessageTokens,
  estimateTokens,
} from '@push/lib/context-budget';
