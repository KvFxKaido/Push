/**
 * Web Search mode — user-selected pref governing both the `web_search`
 * tool's backend routing and Gemini's native search grounding.
 *
 * One menu controls both mechanisms so users don't have to reason about
 * two surfaces. The orchestrator removes the `web_search` tool from the
 * system prompt entirely when mode is `'off'` (the model can't call a
 * tool it doesn't know exists). When mode is an explicit backend
 * (`tavily`, `google-grounding`, etc.) the tool routes through that
 * backend; `auto` keeps the original key + active-provider routing.
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
