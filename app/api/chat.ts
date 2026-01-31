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

    // First try: request non-streaming to avoid potential streaming blocks
    // We'll stream to the client ourselves by converting the full response
    const upstreamBody = { ...parsed, stream: false };

    const upstream = await fetch('https://ollama.com/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Diff/1.0',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(upstreamBody),
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

    const data = await upstream.json();

    if (parsed.stream) {
      // Client expects ndjson streaming — simulate it from the full response
      const content = data.message?.content || '';
      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        start(controller) {
          // Send the content as a single chunk in Ollama ndjson format
          const chunk = JSON.stringify({
            model: data.model,
            created_at: data.created_at,
            message: { role: 'assistant', content },
            done: false,
          });
          controller.enqueue(encoder.encode(chunk + '\n'));

          // Send the done signal
          const doneChunk = JSON.stringify({
            model: data.model,
            created_at: data.created_at,
            message: { role: 'assistant', content: '' },
            done: true,
          });
          controller.enqueue(encoder.encode(doneChunk + '\n'));
          controller.close();
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'application/x-ndjson',
          'Cache-Control': 'no-cache',
        },
      });
    }

    // Non-streaming: return as-is
    return Response.json(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api/chat] Unhandled: ${message}`);
    return Response.json({ error: message }, { status: 500 });
  }
}
