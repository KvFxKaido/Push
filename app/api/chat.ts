export const config = { runtime: 'edge' };

export default async function handler(req: Request) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const apiKey = process.env.OLLAMA_CLOUD_API_KEY;
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: 'OLLAMA_CLOUD_API_KEY not configured on server' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const body = await req.text();

  const upstream = await fetch('https://ollama.com/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body,
  });

  if (!upstream.ok) {
    const errBody = await upstream.text().catch(() => '');
    return new Response(errBody || 'Upstream error', { status: upstream.status });
  }

  // Stream the ndjson response back to the client
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
    },
  });
}
