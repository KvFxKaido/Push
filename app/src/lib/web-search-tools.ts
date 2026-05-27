/**
 * Web search tools — allows agents to search the web.
 *
 * Three search backends, used in priority order:
 *  1. **Tavily** — Optional premium search (LLM-optimized results). User adds
 *     a key in Settings; when present, all providers use Tavily.
 *  2. **Ollama native** — Ollama's built-in REST endpoint (POST /api/web_search).
 *     Used when the active provider is Ollama and no Tavily key is set.
 *  3. **DuckDuckGo free** — HTML scraping, no API key needed. Fallback for
 *     providers without native search when Tavily isn't configured.
 *
 * All providers use prompt-engineered web search — the web_search tool
 * protocol is injected into the system prompt for all providers.
 */

import type { ToolExecutionResult, WebSearchResult, WebSearchCardData } from '@/types';
import { resolveApiUrl } from './api-url';
import { detectToolFromText } from './utils';
import { getOllamaKey } from '@/hooks/useOllamaConfig';
import { getTavilyKey } from '@/hooks/useTavilyConfig';
import { getGoogleKey } from '@/hooks/useGoogleConfig';
import { getWebSearchMode } from './web-search-mode';
import { getToolArgHint, getToolPublicName, resolveToolName } from './tool-registry';
import { sanitizeUntrustedSource } from '@push/lib/untrusted-content';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebSearchToolCall {
  tool: 'web_search';
  args: { query: string };
}

// ---------------------------------------------------------------------------
// Protocol prompt (injected into system prompt for Ollama provider)
// ---------------------------------------------------------------------------

export const WEB_SEARCH_TOOL_PROTOCOL = `
## Web Search

You can search the web for current information by outputting a JSON tool block:

\`\`\`json
${getToolArgHint('web_search')}
\`\`\`

Prefer the short name \`${getToolPublicName('web_search')}\`. The long name still works for compatibility.

**When to use:**
- User asks about current events, recent releases, or real-time data
- Questions about up-to-date documentation, pricing, or availability
- Fact-checking claims that may have changed since your training
- Looking up error messages, library docs, or Stack Overflow solutions

**When NOT to use:**
- Questions answerable by reading the active repo — use repo or sandbox tools when they are available
- General programming concepts you already know well
- Tasks that don't need current information

**Rules:**
- Include the JSON block when searching. A brief sentence before or after the block is fine, but the JSON block must be present.
- Wait for the search result before continuing your response
- Cite sources (title + URL) when using search results
- Keep queries concise and specific (2-6 words is ideal)
`;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Detect a web_search tool call in the model's output text.
 */
export function detectWebSearchToolCall(text: string): WebSearchToolCall | null {
  return detectToolFromText<WebSearchToolCall>(text, (parsed) => {
    if (isWebSearchTool(parsed)) {
      return { tool: 'web_search', args: { query: parsed.args.query } };
    }
    return null;
  });
}

function isWebSearchTool(obj: unknown): obj is { tool: 'web_search'; args: { query: string } } {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'tool' in obj &&
    resolveToolName((obj as { tool: string }).tool) === 'web_search' &&
    'args' in obj &&
    typeof (obj as { args: unknown }).args === 'object' &&
    (obj as { args: unknown }).args !== null &&
    'query' in (obj as { args: Record<string, unknown> }).args &&
    typeof (obj as { args: { query: unknown } }).args.query === 'string'
  );
}

// ---------------------------------------------------------------------------
// Execution — shared core
// ---------------------------------------------------------------------------

const OLLAMA_SEARCH_URL = import.meta.env.DEV
  ? '/ollama/api/web_search'
  : resolveApiUrl('/api/ollama/search');

// In both dev and prod, /api routes go through the Worker (or Vite proxy → Worker).
const FREE_SEARCH_URL = resolveApiUrl('/api/search');

// Tavily API key is kept client-side (same as AI provider keys) and sent to
// the Worker in an Authorization header. Not required — DuckDuckGo works fine
// as the default. Add a Tavily key in Settings for higher-quality results.
const TAVILY_SEARCH_URL = resolveApiUrl('/api/search/tavily');

// Gemini-grounded search. The Worker holds the Google API key by default;
// when the user has stored a key in Settings, we forward it as a Bearer
// (mirrors gemini-stream.ts).
const GOOGLE_GROUNDED_SEARCH_URL = resolveApiUrl('/api/google/search');

const MAX_RESULT_SNIPPET_LENGTH = 500;
const MAX_RESULTS = 5;

/**
 * Shared implementation for all web search backends.
 * @param url       The search endpoint URL.
 * @param query     The user's search query.
 * @param headers   Optional extra headers (e.g. Authorization).
 * @param errorPrefix Label used in the !response.ok error message (default "Search failed").
 */
async function executeWebSearchCore(
  url: string,
  query: string,
  headers?: Record<string, string>,
  errorPrefix = 'Search failed',
): Promise<ToolExecutionResult> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      return {
        text: `[Tool Error — web_search] ${errorPrefix} (${response.status}): ${errBody.slice(0, 200)}`,
      };
    }

    const data = (await response.json()) as { results?: WebSearchResult[] };
    const results = (data.results || []).slice(0, MAX_RESULTS);

    if (results.length === 0) {
      return { text: `[Tool Result — web_search]\nNo results found for "${query}".` };
    }

    // Format results for LLM consumption. Untrusted snippets from the open
    // web are sanitized so they cannot break out of the [TOOL_RESULT]
    // envelope, spoof infrastructure markers like [meta] / [CODER_STATE],
    // or embed echo-able JSON tool-call shapes.
    const formatted = results
      .map(
        (r, i) =>
          `${i + 1}. **${sanitizeUntrustedSource(r.title)}**\n   ${sanitizeUntrustedSource(r.url)}\n   ${sanitizeUntrustedSource(r.content.slice(0, MAX_RESULT_SNIPPET_LENGTH))}`,
      )
      .join('\n\n');

    const cardData: WebSearchCardData = { query, results };

    return {
      text: `[Tool Result — web_search]\nQuery: "${sanitizeUntrustedSource(query)}"\n${results.length} result${results.length > 1 ? 's' : ''}:\n\n${formatted}`,
      card: { type: 'web-search', data: cardData },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: `[Tool Error — web_search] ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Execution — Ollama native search
// ---------------------------------------------------------------------------

/**
 * Execute a web search via the Ollama search API.
 */
export async function executeOllamaWebSearch(query: string): Promise<ToolExecutionResult> {
  const apiKey = getOllamaKey();
  if (!apiKey) {
    return { text: '[Tool Error — web_search] Ollama API key not configured.' };
  }

  return executeWebSearchCore(OLLAMA_SEARCH_URL, query, {
    Authorization: `Bearer ${apiKey}`,
  });
}

// ---------------------------------------------------------------------------
// Execution — free web search via DuckDuckGo HTML scraping (no API key)
// ---------------------------------------------------------------------------

/**
 * Execute a web search via the free DuckDuckGo-backed endpoint.
 * Used for providers that don't bundle search.
 * No API key needed — the Worker scrapes DuckDuckGo's HTML lite page.
 */
export async function executeFreeWebSearch(query: string): Promise<ToolExecutionResult> {
  return executeWebSearchCore(FREE_SEARCH_URL, query);
}

// ---------------------------------------------------------------------------
// Execution — Tavily search (optional premium upgrade, LLM-optimized results)
// ---------------------------------------------------------------------------

/**
 * Execute a web search via the Tavily API (proxied through Worker).
 * Returns LLM-optimized results with pre-extracted content.
 */
export async function executeTavilySearch(query: string): Promise<ToolExecutionResult> {
  const apiKey = getTavilyKey();
  if (!apiKey) {
    return { text: '[Tool Error — web_search] Tavily API key not configured.' };
  }

  return executeWebSearchCore(
    TAVILY_SEARCH_URL,
    query,
    {
      Authorization: `Bearer ${apiKey}`,
    },
    'Tavily search failed',
  );
}

// ---------------------------------------------------------------------------
// Execution — Gemini-grounded search (one-shot generateContent + googleSearch)
// ---------------------------------------------------------------------------

interface GeminiGroundedSearchPayload {
  answer?: string;
  results?: WebSearchResult[];
  error?: string;
}

/**
 * Execute a web search via Gemini's native `googleSearch` tool. The Worker
 * issues a one-shot non-streaming `:generateContent` call; the response is a
 * synthesized answer plus a list of cited sources (title + URL only — Gemini
 * does not return per-chunk snippets, the answer carries the content).
 */
export async function executeGoogleGroundedSearch(query: string): Promise<ToolExecutionResult> {
  const apiKey = (getGoogleKey() ?? '').trim();
  try {
    const response = await fetch(GOOGLE_GROUNDED_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      let detail = errBody;
      try {
        const parsed = JSON.parse(errBody) as { error?: string };
        if (typeof parsed.error === 'string') detail = parsed.error;
      } catch {
        // fall through with raw body
      }
      // Untrusted upstream/Worker text — sanitize before embedding in the
      // tool envelope so it can't smuggle tool markers or prompt-injection
      // back into the model's input.
      const safeDetail = sanitizeUntrustedSource(detail).slice(0, 200);
      return {
        text: `[Tool Error — web_search] Grounded search failed (${response.status}): ${safeDetail}`,
      };
    }

    const data = (await response.json()) as GeminiGroundedSearchPayload;
    const answer = (data.answer ?? '').trim();
    const results = (data.results ?? []).slice(0, MAX_RESULTS);

    if (!answer && results.length === 0) {
      return { text: `[Tool Result — web_search]\nNo results found for "${query}".` };
    }

    const sanitizedQuery = sanitizeUntrustedSource(query);
    const sanitizedAnswer = sanitizeUntrustedSource(answer);
    const sources =
      results.length > 0
        ? results
            .map(
              (r, i) =>
                `${i + 1}. **${sanitizeUntrustedSource(r.title)}**\n   ${sanitizeUntrustedSource(r.url)}`,
            )
            .join('\n')
        : '(no source citations returned)';

    const cardData: WebSearchCardData = { query, results };

    return {
      text:
        `[Tool Result — web_search]\nQuery: "${sanitizedQuery}"\n` +
        (sanitizedAnswer ? `Grounded answer:\n${sanitizedAnswer}\n\n` : '') +
        `Sources:\n${sources}`,
      card: { type: 'web-search', data: cardData },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: `[Tool Error — web_search] ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Unified search routing — picks the best available backend
// ---------------------------------------------------------------------------

/**
 * Execute a web search. Honors the user-selected `WebSearchMode`:
 *  - `off`: defensive error (orchestrator should have removed the tool
 *    from the prompt already; this catches stale tool calls).
 *  - `auto`: routes through Tavily → Ollama → Google grounded based on
 *    configured keys + the active provider. DuckDuckGo is intentionally
 *    NOT a silent fallback: the HTML scrape is unofficial and fragile,
 *    and Cloudflare doesn't ship a managed open-web search API to
 *    replace it, so we return a nudge instead and let the user opt in
 *    explicitly (`mode === 'duckduckgo'`) or configure Tavily.
 *  - explicit backend (`tavily`/`google-grounding`/`ollama`/`duckduckgo`):
 *    forces that backend; the backend itself returns a config error if
 *    its required key/provider is missing.
 *
 * Callers don't need to know which backend is used.
 */
export async function executeWebSearch(
  query: string,
  activeProvider: string,
): Promise<ToolExecutionResult> {
  const mode = getWebSearchMode();

  if (mode === 'off') {
    return {
      text: '[Tool Error — web_search] Web search is turned off. Enable it from the Web menu.',
    };
  }

  if (mode === 'tavily') return executeTavilySearch(query);
  if (mode === 'ollama') return executeOllamaWebSearch(query);
  if (mode === 'google-grounding') return executeGoogleGroundedSearch(query);
  if (mode === 'duckduckgo') return executeFreeWebSearch(query);

  // mode === 'auto': pick the first available official backend in priority
  // order. DuckDuckGo is intentionally excluded from this list — see the
  // function-level doc above for why. The nudge below explains the situation
  // to the model so it can either inform the user or fall back on its
  // training knowledge.
  if (getTavilyKey()) {
    return executeTavilySearch(query);
  }
  if (activeProvider === 'ollama') {
    return executeOllamaWebSearch(query);
  }
  if (activeProvider === 'google' && getGoogleKey()) {
    return executeGoogleGroundedSearch(query);
  }
  // Drop the "switch to a provider with native search" line: when this
  // path fires the active provider either lacks native search (so the
  // suggestion is the actionable fix) OR it's a native-equipped provider
  // whose model bypassed the native tool (so the suggestion is
  // misleading because native is already wired). Tavily + DDG are the
  // actionable options in both cases.
  return {
    text:
      '[Tool Error — web_search] No official web search backend is configured for this chat. ' +
      'Add a Tavily API key in Settings (recommended), or pick "DuckDuckGo" from the Web Search ' +
      'menu to use the unofficial HTML scrape. Falling back to training knowledge until then.',
  };
}
