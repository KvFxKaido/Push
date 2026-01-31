import type { ChatMessage } from '@/types';

const OLLAMA_CLOUD_API_KEY = import.meta.env.VITE_OLLAMA_CLOUD_API_KEY || '';

// Dev: Vite proxy avoids CORS. Prod: Vercel Edge function at /api/chat holds the key.
const OLLAMA_CLOUD_API_URL =
  import.meta.env.VITE_OLLAMA_CLOUD_API_URL ||
  (import.meta.env.DEV ? '/ollama/api/chat' : '/api/chat');

const ORCHESTRATOR_MODEL = 'kimi-k2.5:cloud';

// Demo mode only applies in dev without a key.
// In production, the Edge function has the key server-side.
const isDemoMode = import.meta.env.DEV && !OLLAMA_CLOUD_API_KEY;

if (import.meta.env.DEV) {
  if (OLLAMA_CLOUD_API_KEY) {
    console.log(`[Diff] Ollama Cloud key loaded: ${OLLAMA_CLOUD_API_KEY.slice(0, 8)}...`);
  } else {
    console.log('[Diff] No API key — demo mode');
  }
}

export const ORCHESTRATOR_SYSTEM_PROMPT = `You are Diff, a concise AI coding assistant with direct GitHub repo access. You help developers review PRs, understand codebases, and ship changes from their phone.

Rules:
- Be conversational but concise. No walls of text.
- When the user asks about repos or PRs, describe what you see and offer next steps.
- Use markdown for code snippets. Keep responses scannable.
- You're mobile-first — short paragraphs, clear structure.
- If you don't know something, say so. Don't guess.
- Never start with "I" — vary your openings.`;

const DEMO_WELCOME = `Welcome to **Diff** — your AI coding agent with direct repo access.

Here's what I can help with:

- **Review PRs** — paste a GitHub PR link and I'll analyze it
- **Explore repos** — ask about any repo's structure, recent changes, or open issues
- **Ship changes** — describe what you want changed and I'll draft the code
- **Monitor pipelines** — check CI/CD status and deployment health

Connect your GitHub account in settings to get started, or just ask me anything about code.`;

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function toOllamaMessages(messages: ChatMessage[]): OllamaMessage[] {
  const ollamaMessages: OllamaMessage[] = [
    { role: 'system', content: ORCHESTRATOR_SYSTEM_PROMPT },
  ];

  for (const msg of messages) {
    ollamaMessages.push({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content,
    });
  }

  return ollamaMessages;
}

export async function streamChat(
  messages: ChatMessage[],
  onToken: (token: string) => void,
  onDone: () => void,
  onError: (error: Error) => void,
): Promise<void> {
  if (isDemoMode) {
    const words = DEMO_WELCOME.split(' ');
    for (let i = 0; i < words.length; i++) {
      await new Promise((r) => setTimeout(r, 12));
      onToken(words[i] + (i < words.length - 1 ? ' ' : ''));
    }
    onDone();
    return;
  }

  try {
    console.log(`[Diff] POST ${OLLAMA_CLOUD_API_URL} (model: ${ORCHESTRATOR_MODEL})`);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // In dev, client sends the key through the Vite proxy.
    // In prod, the Edge function adds it server-side.
    if (OLLAMA_CLOUD_API_KEY) {
      headers['Authorization'] = `Bearer ${OLLAMA_CLOUD_API_KEY}`;
    }

    const response = await fetch(OLLAMA_CLOUD_API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: ORCHESTRATOR_MODEL,
        messages: toOllamaMessages(messages),
        stream: true,
        options: {
          temperature: 0.4,
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`API ${response.status}: ${body.slice(0, 300)}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    // Ollama native streaming: newline-delimited JSON (ndjson)
    // Each line: { message: { content: "..." }, done: bool }
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const parsed = JSON.parse(trimmed);
          const token = parsed.message?.content;
          if (token) {
            onToken(token);
          }
          if (parsed.done) {
            onDone();
            return;
          }
        } catch {
          // Skip malformed lines
        }
      }
    }

    onDone();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Diff] Chat error:`, msg);
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      onError(new Error(
        `Cannot reach the AI service. Check your connection and try again.`
      ));
    } else {
      onError(err instanceof Error ? err : new Error(msg));
    }
  }
}
