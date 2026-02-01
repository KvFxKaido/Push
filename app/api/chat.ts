export const config = { runtime: 'edge' };

export async function POST(request: Request) {
  try {
    const apiKey = process.env.OLLAMA_CLOUD_API_KEY;
    if (!apiKey) {
      console.error('[api/chat] OLLAMA_CLOUD_API_KEY not set');
      return Response.json(
        { error: 'API key not configured. Add OLLAMA_CLOUD_API_KEY in Vercel settings.' },
        { status: 500 },
      );
    }

    const body = await request.text();

    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    console.log(`[api/chat] model=${parsed.model}, messages=${parsed.messages?.length}, stream=${parsed.stream}`);

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

    // Streaming: pipe the upstream ndjson body straight through
    if (parsed.stream && upstream.body) {
      return new Response(upstream.body, {
        status: 200,
        headers: {
          'Content-Type': 'application/x-ndjson',
          'Cache-Control': 'no-cache',
          'Transfer-Encoding': 'chunked',
        },
      });
    }

    // Non-streaming: return as-is
    const data = await upstream.json();
    return Response.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api/chat] Unhandled: ${message}`);
    return Response.json({ error: message }, { status: 500 });
  }
}
