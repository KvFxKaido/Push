/**
 * Cloudflare Worker — serves the Vite app + streaming proxy to Ollama Cloud.
 *
 * Static assets in ./dist are served directly by the [assets] layer.
 * Only unmatched requests (like /api/chat) reach this Worker.
 */

interface Env {
  OLLAMA_CLOUD_API_KEY: string;
  ASSETS: Fetcher;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // API route: streaming proxy to Ollama Cloud
    if (url.pathname === '/api/chat' && request.method === 'POST') {
      return handleChat(request, env);
    }

    // SPA fallback: serve index.html for non-file paths
    // (actual static files like .js/.css are already served by the [assets] layer)
    return env.ASSETS.fetch(new Request(new URL('/index.html', request.url)));
  },
};

async function handleChat(request: Request, env: Env): Promise<Response> {
  const apiKey = env.OLLAMA_CLOUD_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: 'API key not configured. Add OLLAMA_CLOUD_API_KEY in Cloudflare settings.' },
      { status: 500 },
    );
  }

  let parsed: any;
  try {
    parsed = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  console.log(`[api/chat] model=${parsed.model}, messages=${parsed.messages?.length}, stream=${parsed.stream}`);

  try {
    const upstream = await fetch('https://ollama.com/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Diff/1.0',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(parsed),
    });

    console.log(`[api/chat] Upstream responded: ${upstream.status}`);

    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => '');
      console.error(`[api/chat] Upstream ${upstream.status}: ${errBody.slice(0, 500)}`);
      return Response.json(
        { error: `Ollama API error ${upstream.status}: ${errBody.slice(0, 200)}` },
        { status: upstream.status },
      );
    }

    // Streaming: pipe upstream ndjson straight through
    if (parsed.stream && upstream.body) {
      return new Response(upstream.body, {
        status: 200,
        headers: {
          'Content-Type': 'application/x-ndjson',
          'Cache-Control': 'no-cache',
        },
      });
    }

    // Non-streaming: return as-is
    const data: unknown = await upstream.json();
    return Response.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api/chat] Unhandled: ${message}`);
    return Response.json({ error: message }, { status: 500 });
  }
}
