/**
 * Direct-provider definitions.
 *
 * Single source of truth for OpenAI / Anthropic / Google direct integrations.
 * Per CLAUDE.md's new-feature checklist (rule 3 — "one source of truth per
 * vocabulary"), follow-up PRs derive their CLI configs, Worker proxy routes,
 * Settings UI entries, and capability rules from these records rather than
 * re-declaring the same data in three places.
 *
 * The existing 11 providers (`ollama`, `openrouter`, `cloudflare`, ...) stay
 * on the legacy per-surface registration pattern for now. They can migrate
 * incrementally in a follow-up cleanup PR — that is intentional scoping, not
 * an oversight.
 *
 * The drift-detector test (`cli/tests/provider-definition.test.mjs`) enforces
 * internal consistency of each entry. Cross-registry assertions (does the
 * CLI / Worker / Settings UI actually have entries for this provider?) get
 * added per-provider as each follow-up PR lands.
 */

import {
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_MODELS,
  GOOGLE_DEFAULT_MODEL,
  GOOGLE_MODELS,
  OPENAI_DEFAULT_MODEL,
  OPENAI_MODELS,
} from './provider-models.ts';

/**
 * Wire shape for streaming + request bodies.
 *
 * - `openai-compat`: OpenAI Chat Completions schema; consume via
 *   `lib/openai-sse-pump.ts`. Used by OpenAI proper plus the existing
 *   OpenAI-compatible providers (OpenRouter, NVIDIA, Zen, etc.).
 * - `anthropic`: Anthropic Messages API (`/v1/messages`); translate via
 *   `app/src/lib/openai-anthropic-bridge.ts` (already exists for Bedrock).
 *   Reasoning blocks must round-trip with signatures intact when extended
 *   thinking is used.
 * - `gemini`: Google Generative Language API
 *   (`/v1beta/models/{model}:streamGenerateContent`). Distinct request body
 *   (`contents[].parts[]`, `systemInstruction` field) and `?key=` query-param
 *   auth (or `x-goog-api-key` header). Distinct from Vertex.
 */
export type ProviderStreamShape = 'openai-compat' | 'anthropic' | 'gemini';

/**
 * ID space for direct providers. Intentionally separate from
 * `AIProviderType` in `lib/provider-contract.ts` — each follow-up PR extends
 * that union when its provider is fully wired, so the type cascade (web
 * `PROVIDER_URLS` exhaustiveness, Settings UI exhaustiveness) lands together
 * with the implementation rather than as orphan stubs.
 */
export type DirectProviderId = 'openai' | 'anthropic' | 'google';

export interface ProviderDefinition {
  /** Stable kebab-case id. Becomes a member of `AIProviderType` once wired. */
  readonly id: DirectProviderId;
  /** Human-readable name for Settings UI. */
  readonly displayName: string;
  /**
   * Base URL for the streaming endpoint. For `openai-compat` and `anthropic`
   * this is the full endpoint; for `gemini` the adapter appends
   * `/models/{model}:streamGenerateContent`.
   */
  readonly baseUrl: string;
  /** Default model for new sessions. MUST appear in `models`. */
  readonly defaultModel: string;
  /** Curated model id list for UI dropdowns. Free-text entry still allowed. */
  readonly models: readonly string[];
  /**
   * Environment variable names to try, in order. The CLI consumes this from
   * `process.env`; the Worker consumes the *first* entry from its secret
   * store. Convention: `PUSH_<PROVIDER>_API_KEY` first, then bare name, then
   * `VITE_` prefix for legacy compat.
   */
  readonly apiKeyEnvVars: readonly string[];
  /** Worker proxy path used by the web app, e.g. `/api/openai/chat`. */
  readonly webProxyPath: string;
  /** SSE/request translator selector. */
  readonly streamShape: ProviderStreamShape;
}

export const PROVIDER_DEFINITIONS: readonly ProviderDefinition[] = [
  {
    id: 'openai',
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1/chat/completions',
    defaultModel: OPENAI_DEFAULT_MODEL,
    models: OPENAI_MODELS,
    apiKeyEnvVars: ['PUSH_OPENAI_API_KEY', 'OPENAI_API_KEY', 'VITE_OPENAI_API_KEY'],
    webProxyPath: '/api/openai/chat',
    streamShape: 'openai-compat',
  },
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1/messages',
    defaultModel: ANTHROPIC_DEFAULT_MODEL,
    models: ANTHROPIC_MODELS,
    apiKeyEnvVars: ['PUSH_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'VITE_ANTHROPIC_API_KEY'],
    webProxyPath: '/api/anthropic/chat',
    streamShape: 'anthropic',
  },
  {
    id: 'google',
    displayName: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: GOOGLE_DEFAULT_MODEL,
    models: GOOGLE_MODELS,
    apiKeyEnvVars: [
      'PUSH_GOOGLE_API_KEY',
      'GOOGLE_API_KEY',
      'GEMINI_API_KEY',
      'VITE_GOOGLE_API_KEY',
    ],
    webProxyPath: '/api/google/chat',
    streamShape: 'gemini',
  },
];

const PROVIDER_DEFINITION_BY_ID: ReadonlyMap<DirectProviderId, ProviderDefinition> = new Map(
  PROVIDER_DEFINITIONS.map((def) => [def.id, def]),
);

export function getProviderDefinition(id: DirectProviderId): ProviderDefinition {
  const def = PROVIDER_DEFINITION_BY_ID.get(id);
  if (!def) {
    throw new Error(`No ProviderDefinition for id "${id}"`);
  }
  return def;
}

export function findProviderDefinition(id: string): ProviderDefinition | undefined {
  return PROVIDER_DEFINITION_BY_ID.get(id as DirectProviderId);
}
