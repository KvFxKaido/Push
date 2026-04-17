import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Config hooks — stub so we control which backend is chosen.
// ---------------------------------------------------------------------------

const getOllamaKeyMock = vi.fn<[], string | null>();
const getTavilyKeyMock = vi.fn<[], string | null>();

vi.mock('@/hooks/useOllamaConfig', () => ({
  getOllamaKey: () => getOllamaKeyMock(),
}));

vi.mock('@/hooks/useTavilyConfig', () => ({
  getTavilyKey: () => getTavilyKeyMock(),
}));

import {
  detectWebSearchToolCall,
  executeFreeWebSearch,
  executeOllamaWebSearch,
  executeTavilySearch,
  executeWebSearch,
  WEB_SEARCH_TOOL_PROTOCOL,
} from './web-search-tools';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchArgs = Parameters<typeof fetch>;

function queueFetchResponses(responses: Array<Response | Error>) {
  const queue = [...responses];
  const calls: FetchArgs[] = [];
  const fetchMock = vi.fn(async (...args: FetchArgs) => {
    calls.push(args);
    const next = queue.shift();
    if (!next) throw new Error('fetch queue exhausted');
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init,
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
  getOllamaKeyMock.mockReset();
  getTavilyKeyMock.mockReset();
});

// ---------------------------------------------------------------------------
// Protocol prompt
// ---------------------------------------------------------------------------

describe('WEB_SEARCH_TOOL_PROTOCOL', () => {
  it('documents the canonical web_search tool name and usage rules', () => {
    expect(WEB_SEARCH_TOOL_PROTOCOL).toContain('## Web Search');
    expect(WEB_SEARCH_TOOL_PROTOCOL).toMatch(/When to use/);
    expect(WEB_SEARCH_TOOL_PROTOCOL).toMatch(/When NOT to use/);
  });
});

// ---------------------------------------------------------------------------
// detectWebSearchToolCall
// ---------------------------------------------------------------------------

describe('detectWebSearchToolCall', () => {
  it('extracts a valid web_search call from a fenced-JSON block', () => {
    const text =
      'Sure, I\'ll look that up.\n```json\n{"tool":"web_search","args":{"query":"typescript 5.4"}}\n```';
    expect(detectWebSearchToolCall(text)).toEqual({
      tool: 'web_search',
      args: { query: 'typescript 5.4' },
    });
  });

  it('returns null when the block is missing a query', () => {
    const text = '```json\n{"tool":"web_search","args":{}}\n```';
    expect(detectWebSearchToolCall(text)).toBeNull();
  });

  it('returns null for a non-web_search tool', () => {
    const text = '```json\n{"tool":"sandbox_exec","args":{"command":"ls"}}\n```';
    expect(detectWebSearchToolCall(text)).toBeNull();
  });

  it('returns null when the query is not a string', () => {
    const text = '```json\n{"tool":"web_search","args":{"query":123}}\n```';
    expect(detectWebSearchToolCall(text)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Core result shaping (exercised via executeFreeWebSearch)
// ---------------------------------------------------------------------------

describe('executeFreeWebSearch — result shaping', () => {
  it('formats up to 5 results with title/url/content and returns a web-search card', async () => {
    const results = Array.from({ length: 7 }, (_, i) => ({
      title: `Title ${i}`,
      url: `https://example.com/${i}`,
      content: `Snippet ${i}`,
    }));
    const { calls } = queueFetchResponses([jsonResponse({ results })]);
    const result = await executeFreeWebSearch('typescript');
    expect(calls[0][0]).toBe('/api/search');
    expect(result.text).toContain('5 results');
    expect(result.text).toContain('Title 0');
    expect(result.card?.type).toBe('web-search');
    if (result.card?.type === 'web-search') {
      expect(result.card.data.query).toBe('typescript');
      // Results are sliced to MAX_RESULTS (5) before being attached to the card.
      expect(result.card.data.results).toHaveLength(5);
    }
  });

  it('returns a "No results" message when the backend yields nothing', async () => {
    queueFetchResponses([jsonResponse({ results: [] })]);
    const result = await executeFreeWebSearch('needle');
    expect(result.text).toContain('No results found for "needle"');
    expect(result.card).toBeUndefined();
  });

  it('surfaces !ok responses with the search-failed prefix and status code', async () => {
    queueFetchResponses([new Response('upstream 502', { status: 502 })]);
    const result = await executeFreeWebSearch('x');
    expect(result.text).toContain('Search failed');
    expect(result.text).toContain('502');
    expect(result.text).toContain('upstream 502');
  });

  it('truncates long snippets to the 500-char cap', async () => {
    const huge = 'x'.repeat(800);
    queueFetchResponses([jsonResponse({ results: [{ title: 't', url: 'u', content: huge }] })]);
    const result = await executeFreeWebSearch('q');
    // The formatted block should contain the truncated 500-char body but not the full 800.
    expect(result.text).toContain('x'.repeat(500));
    expect(result.text).not.toContain('x'.repeat(600));
  });

  it('wraps fetch errors in a Tool Error message', async () => {
    queueFetchResponses([new Error('offline')]);
    const result = await executeFreeWebSearch('q');
    expect(result.text).toBe('[Tool Error — web_search] offline');
  });
});

// ---------------------------------------------------------------------------
// executeOllamaWebSearch — key gating + auth header
// ---------------------------------------------------------------------------

describe('executeOllamaWebSearch', () => {
  it('returns an Error result when no Ollama key is configured', async () => {
    getOllamaKeyMock.mockReturnValue(null);
    const result = await executeOllamaWebSearch('x');
    expect(result.text).toContain('Ollama API key not configured');
  });

  it('attaches a Bearer <key> header when a key is present', async () => {
    getOllamaKeyMock.mockReturnValue('OLLAMA_TEST_KEY');
    const { calls } = queueFetchResponses([jsonResponse({ results: [] })]);
    await executeOllamaWebSearch('q');
    const init = calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer OLLAMA_TEST_KEY');
  });
});

// ---------------------------------------------------------------------------
// executeTavilySearch — key gating + Tavily error prefix
// ---------------------------------------------------------------------------

describe('executeTavilySearch', () => {
  it('returns an Error result when no Tavily key is configured', async () => {
    getTavilyKeyMock.mockReturnValue(null);
    const result = await executeTavilySearch('x');
    expect(result.text).toContain('Tavily API key not configured');
  });

  it('uses the Tavily-specific error prefix on !ok', async () => {
    getTavilyKeyMock.mockReturnValue('TAV_KEY');
    queueFetchResponses([new Response('bad key', { status: 401 })]);
    const result = await executeTavilySearch('q');
    expect(result.text).toContain('Tavily search failed');
    expect(result.text).toContain('401');
  });

  it('sends the Tavily key as a Bearer token', async () => {
    getTavilyKeyMock.mockReturnValue('TAV_KEY');
    const { calls } = queueFetchResponses([jsonResponse({ results: [] })]);
    await executeTavilySearch('q');
    const init = calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer TAV_KEY');
  });
});

// ---------------------------------------------------------------------------
// executeWebSearch — backend selection
// ---------------------------------------------------------------------------

describe('executeWebSearch — backend selection', () => {
  it('prefers Tavily when the Tavily key is configured', async () => {
    getTavilyKeyMock.mockReturnValue('TAV_KEY');
    getOllamaKeyMock.mockReturnValue('OLLAMA_KEY'); // should be ignored
    const { calls } = queueFetchResponses([jsonResponse({ results: [] })]);
    await executeWebSearch('q', 'ollama');
    expect(calls[0][0]).toBe('/api/search/tavily');
  });

  it('uses Ollama native search when no Tavily key and the active provider is ollama', async () => {
    getTavilyKeyMock.mockReturnValue(null);
    getOllamaKeyMock.mockReturnValue('OLLAMA_KEY');
    const { calls } = queueFetchResponses([jsonResponse({ results: [] })]);
    await executeWebSearch('q', 'ollama');
    // Path depends on import.meta.env.DEV; either value is fine.
    expect(calls[0][0]).toMatch(/\/ollama\/api\/web_search|\/api\/ollama\/search/);
  });

  it('falls back to the free DuckDuckGo search when nothing else applies', async () => {
    getTavilyKeyMock.mockReturnValue(null);
    const { calls } = queueFetchResponses([jsonResponse({ results: [] })]);
    await executeWebSearch('q', 'anthropic');
    expect(calls[0][0]).toBe('/api/search');
  });
});
