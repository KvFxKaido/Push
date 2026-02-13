/**
 * Web search tools — allows agents to search the web.
 *
 * Three search backends, used in priority order:
 *  1. **Tavily** — Optional premium search (LLM-optimized results). User adds
 *     a key in Settings; when present, all providers use Tavily.
 *  2. **Ollama native** — Ollama's built-in REST endpoint (POST /api/web_search).
 *     Used when the active provider is Ollama and no Tavily key is set.
 *  3. **DuckDuckGo free** — HTML scraping, no API key needed. Fallback for
 *     providers without native search (e.g., Kimi) when Tavily isn't configured.
 *
 * Mistral handles search natively via the Agents API — no prompt-engineered
 * tool is needed for that provider (see orchestrator.ts).
 */

import type { ToolExecutionResult, WebSearchResult, WebSearchCardData } from '@/types';
import { detectToolFromText } from './utils';
import { getOllamaKey } from '@/hooks/useOllamaConfig';
import { getTavilyKey } from '@/hooks/useTavilyConfig';

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
{"tool": "web_search", "args": {"query": "search terms here"}}
\`\`\`

**When to use:**
- User asks about current events, recent releases, or real-time data
- Questions about up-to-date documentation, pricing, or availability
- Fact-checking claims that may have changed since your training
- Looking up error messages, library docs, or Stack Overflow solutions

**When NOT to use:**
- Questions about the active repo (use GitHub or sandbox tools instead)
- General programming concepts you already know well
- Tasks that don't need current information

**Rules:**
- Output ONLY the JSON block when searching — no surrounding text
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
    (obj as { tool: unknown }).tool === 'web_search' &&
    'args' in obj &&
    typeof (obj as { args: unknown }).args === 'object' &&
    (obj as { args: unknown }).args !== null &&
    'query' in ((obj as { args: Record<string, unknown> }).args) &&
    typeof ((obj as { args: { query: unknown } }).args.query) === 'string'
  );
}

// ---------------------------------------------------------------------------
// Execution — calls Ollama's web search REST endpoint
// ---------------------------------------------------------------------------

const OLLAMA_SEARCH_URL = import.meta.env.DEV
  ? '/ollama/api/web_search'
  : '/api/ollama/search';

const MAX_RESULT_SNIPPET_LENGTH = 500;
const MAX_RESULTS = 5;

/**
 * Execute a web search via the Ollama search API.
 */
export async function executeOllamaWebSearch(query: string): Promise<ToolExecutionResult> {
  const apiKey = getOllamaKey();
  if (!apiKey) {
    return { text: '[Tool Error — web_search] Ollama API key not configured.' };
  }

  try {
    const response = await fetch(OLLAMA_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      return {
        text: `[Tool Error — web_search] Search failed (${response.status}): ${errBody.slice(0, 200)}`,
      };
    }

    const data = (await response.json()) as { results?: WebSearchResult[] };
    const results = (data.results || []).slice(0, MAX_RESULTS);

    if (results.length === 0) {
      return { text: `[Tool Result — web_search]\nNo results found for "${query}".` };
    }

    // Format results for LLM consumption
    const formatted = results
      .map(
        (r, i) =>
          `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.content.slice(0, MAX_RESULT_SNIPPET_LENGTH)}`,
      )
      .join('\n\n');

    const cardData: WebSearchCardData = { query, results };

    return {
      text: `[Tool Result — web_search]\nQuery: "${query}"\n${results.length} result${results.length > 1 ? 's' : ''}:\n\n${formatted}`,
      card: { type: 'web-search', data: cardData },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: `[Tool Error — web_search] ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Execution — free web search via DuckDuckGo HTML scraping (no API key)
// ---------------------------------------------------------------------------

// In both dev and prod, /api routes go through the Worker (or Vite proxy → Worker).
const FREE_SEARCH_URL = '/api/search';

/**
 * Execute a web search via the free DuckDuckGo-backed endpoint.
 * Used for providers that don't bundle search (e.g., Kimi).
 * No API key needed — the Worker scrapes DuckDuckGo's HTML lite page.
 */
export async function executeFreeWebSearch(query: string): Promise<ToolExecutionResult> {
  try {
    const response = await fetch(FREE_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      return {
        text: `[Tool Error — web_search] Search failed (${response.status}): ${errBody.slice(0, 200)}`,
      };
    }

    const data = (await response.json()) as { results?: WebSearchResult[] };
    const results = (data.results || []).slice(0, MAX_RESULTS);

    if (results.length === 0) {
      return { text: `[Tool Result — web_search]\nNo results found for "${query}".` };
    }

    const formatted = results
      .map(
        (r, i) =>
          `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.content.slice(0, MAX_RESULT_SNIPPET_LENGTH)}`,
      )
      .join('\n\n');

    const cardData: WebSearchCardData = { query, results };

    return {
      text: `[Tool Result — web_search]\nQuery: "${query}"\n${results.length} result${results.length > 1 ? 's' : ''}:\n\n${formatted}`,
      card: { type: 'web-search', data: cardData },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { text: `[Tool Error — web_search] ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Execution — Tavily search (optional premium upgrade, LLM-optimized results)
// ---------------------------------------------------------------------------

// Tavily API key is kept client-side (same as AI provider keys) and sent to
// the Worker in an Authorization header. Not required — DuckDuckGo works fine
// as the default. Add a Tavily key in Settings for higher-quality results.

const TAVILY_SEARCH_URL = '/api/search/tavily';

/**
 * Execute a web search via the Tavily API (proxied through Worker).
 * Returns LLM-optimized results with pre-extracted content.
 */
export async function executeTavilySearch(query: string): Promise<ToolExecutionResult> {
  const apiKey = getTavilyKey();
  if (!apiKey) {
    return { text: '[Tool Error — web_search] Tavily API key not configured.' };
  }

  try {
    const response = await fetch(TAVILY_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      return {
        text: `[Tool Error — web_search] Tavily search failed (${response.status}): ${errBody.slice(0, 200)}`,
      };
    }

    const data = (await response.json()) as { results?: WebSearchResult[] };
    const results = (data.results || []).slice(0, MAX_RESULTS);

    if (results.length === 0) {
      return { text: `[Tool Result — web_search]\nNo results found for "${query}".` };
    }

    const formatted = results
      .map(
        (r, i) =>
          `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.content.slice(0, MAX_RESULT_SNIPPET_LENGTH)}`,
      )
      .join('\n\n');

    const cardData: WebSearchCardData = { query, results };

    return {
      text: `[Tool Result — web_search]\nQuery: "${query}"\n${results.length} result${results.length > 1 ? 's' : ''}:\n\n${formatted}`,
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
 * Execute a web search using the best available backend:
 *  1. Tavily (if key is configured) — highest quality, LLM-optimized
 *  2. Ollama native search (if active provider is 'ollama') — bundled with Ollama subscription
 *  3. DuckDuckGo free scraping — always available, no key needed
 *
 * Callers don't need to know which backend is used.
 */
export async function executeWebSearch(query: string, activeProvider: string): Promise<ToolExecutionResult> {
  // Priority 1: Tavily (optional premium upgrade)
  if (getTavilyKey()) {
    return executeTavilySearch(query);
  }

  // Priority 2: Ollama native search
  if (activeProvider === 'ollama') {
    return executeOllamaWebSearch(query);
  }

  // Priority 3: DuckDuckGo free search
  return executeFreeWebSearch(query);
}
