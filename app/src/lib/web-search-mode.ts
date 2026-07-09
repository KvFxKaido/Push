/**
 * Web Search mode — user-selected pref governing both the
 * prompt-engineered `web_search` tool's backend routing AND each
 * provider's native server-side search tool (Gemini's `googleSearch`,
 * Anthropic's `web_search_20250305`).
 *
 * One menu controls both mechanisms so users don't have to reason about
 * two surfaces. The orchestrator removes the `web_search` tool from the
 * system prompt entirely when mode is `'off'`. When mode is `'auto'`
 * (the default) each provider opts into its own native search tool via
 * `isNativeWebSearchEnabled` AND the prompt-engineered tool routes via
 * the original key + active-provider fallback. Explicit non-native
 * backends (`tavily`, `duckduckgo`, `ollama`) suppress the native tool
 * and force the prompt-engineered path through that backend.
 *
 * Keep this file dependency-free (only `safe-storage`) so the
 * orchestrator's prompt builder can read it without dragging in the
 * provider/key hooks.
 */

import { safeStorageGet, safeStorageSet } from './safe-storage';

export type WebSearchMode =
  | 'off'
  | 'auto'
  | 'tavily'
  | 'google-grounding'
  | 'duckduckgo'
  | 'ollama';

export const WEB_SEARCH_MODES: readonly WebSearchMode[] = [
  'off',
  'auto',
  'tavily',
  'google-grounding',
  'duckduckgo',
  'ollama',
] as const;

export const WEB_SEARCH_MODE_LABELS: Record<WebSearchMode, string> = {
  off: 'Off',
  auto: 'Auto',
  tavily: 'Tavily',
  'google-grounding': 'Google grounding',
  duckduckgo: 'DuckDuckGo',
  ollama: 'Ollama',
};

const WEB_SEARCH_MODE_KEY = 'push:web-search-mode';
const DEFAULT_WEB_SEARCH_MODE: WebSearchMode = 'auto';

function isMode(value: string | null | undefined): value is WebSearchMode {
  return !!value && (WEB_SEARCH_MODES as readonly string[]).includes(value);
}

export function getWebSearchMode(): WebSearchMode {
  const raw = safeStorageGet(WEB_SEARCH_MODE_KEY);
  return isMode(raw) ? raw : DEFAULT_WEB_SEARCH_MODE;
}

export function setWebSearchMode(mode: WebSearchMode): void {
  safeStorageSet(WEB_SEARCH_MODE_KEY, mode);
}

/**
 * Provider-native web-search enablement rule.
 *
 * `'auto'` (the default) opts each provider into its own native search
 * tool — that's how Gemini gets `googleSearch` grounding, Anthropic gets
 * `web_search_20250305`, OpenRouter gets its `openrouter:web_search`
 * server tool, and the Responses-native providers that implement it
 * (OpenAI, Sakana Fugu) get OpenAI's `web_search` server tool — all
 * without the user having to know any of them exist. Explicit
 * non-native backends (`'tavily'`, `'duckduckgo'`,
 * `'ollama'`) suppress native — the user has chosen a specific
 * client-side backend and we don't want the provider running a parallel
 * server-side search behind their back. `'google-grounding'` is the
 * provider-specific opt-in that forces grounding on Gemini.
 *
 * Returns false for providers that don't have a native tool — the
 * prompt-engineered `web_search` (DuckDuckGo / Tavily / Ollama) covers
 * those.
 */
export function isNativeWebSearchEnabled(
  provider: string,
  _modelId?: string,
  mode: WebSearchMode = getWebSearchMode(),
): boolean {
  switch (mode) {
    case 'off':
      return false;
    case 'auto':
      return (
        provider === 'google' ||
        provider === 'anthropic' ||
        provider === 'openrouter' ||
        // Responses-native providers that implement OpenAI's server-side
        // `web_search` built-in tool: direct OpenAI (broad model support) and
        // Sakana Fugu (every Fugu model ships it). Fireworks is deliberately
        // excluded — its `/v1/responses` supports only function/MCP/SSE tools,
        // not the built-in `web_search`, so defaulting it on would 400 every
        // chat. Fireworks stays on the prompt-engineered path (Tavily/DDG).
        provider === 'openai' ||
        provider === 'sakana'
      );
    case 'google-grounding':
      return provider === 'google';
    case 'tavily':
    case 'duckduckgo':
    case 'ollama':
      return false;
  }
}

/**
 * Friendly name of the provider-native web search that `'auto'` turns on
 * for `provider`, or `null` when the provider has no native tool (Auto then
 * falls back to the prompt-engineered `web_search`). The Web Search menu
 * shows this next to "Auto" so the row reflects what Auto resolves to for
 * the current chat — e.g. "OpenRouter" when the chat is on OpenRouter. Keyed
 * off `isNativeWebSearchEnabled(..., 'auto')` so the two can't drift.
 */
export function getAutoNativeSearchLabel(provider: string): string | null {
  if (!isNativeWebSearchEnabled(provider, undefined, 'auto')) return null;
  switch (provider) {
    case 'openrouter':
      return 'OpenRouter';
    case 'anthropic':
      return 'Anthropic';
    case 'google':
      return 'Google';
    case 'openai':
      return 'OpenAI';
    case 'sakana':
      return 'Sakana';
    default:
      return null;
  }
}

/**
 * Availability gate for the WebSearchMenu UI. `off` and `auto` are
 * always available; explicit-backend modes require the matching key
 * (and, for grounding/ollama, that the active provider is compatible).
 *
 * Returns null when the mode is available; otherwise a short reason for
 * a disabled state and a tooltip.
 */
export function getWebSearchModeUnavailableReason(
  mode: WebSearchMode,
  ctx: {
    activeProvider: string;
    hasTavilyKey: boolean;
    hasGoogleKey: boolean;
    hasOllamaKey: boolean;
  },
): string | null {
  switch (mode) {
    case 'off':
    case 'auto':
    case 'duckduckgo':
      return null;
    case 'tavily':
      return ctx.hasTavilyKey ? null : 'Add a Tavily key in Settings';
    case 'google-grounding':
      if (!ctx.hasGoogleKey) return 'Add a Google API key in Settings';
      if (ctx.activeProvider !== 'google') return 'Switch the chat to the Google provider';
      return null;
    case 'ollama':
      if (!ctx.hasOllamaKey) return 'Add an Ollama key in Settings';
      if (ctx.activeProvider !== 'ollama') return 'Switch the chat to the Ollama provider';
      return null;
  }
}
