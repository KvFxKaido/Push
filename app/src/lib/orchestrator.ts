import type { ChatMessage } from '@/types';
import { TOOL_PROTOCOL } from './github-tools';

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

function toOllamaMessages(messages: ChatMessage[], workspaceContext?: string): OllamaMessage[] {
  // Build system prompt: base + workspace context + tool protocol
  let systemContent = ORCHESTRATOR_SYSTEM_PROMPT;
  if (workspaceContext) {
    systemContent += '\n\n' + workspaceContext + '\n' + TOOL_PROTOCOL;
  }

  const ollamaMessages: OllamaMessage[] = [
    { role: 'system', content: systemContent },
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
  onThinkingToken?: (token: string | null) => void,
  workspaceContext?: string,
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
        messages: toOllamaMessages(messages, workspaceContext),
        stream: true,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      // Try to extract a meaningful error from JSON response
      let detail = '';
      try {
        const parsed = JSON.parse(body);
        detail = parsed.error || body.slice(0, 200);
      } catch {
        detail = body ? body.slice(0, 200) : 'empty body';
      }
      console.error(`[Diff] API error: ${response.status} from ${OLLAMA_CLOUD_API_URL}`, detail);
      throw new Error(`API ${response.status} (${OLLAMA_CLOUD_API_URL}): ${detail}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    // Ollama native streaming: newline-delimited JSON (ndjson)
    // Each line: { message: { content: "..." }, done: bool }
    // Kimi K2.5 emits <think>...</think> reasoning before the answer.
    // We separate thinking tokens from response tokens via callbacks.
    const decoder = new TextDecoder();
    let buffer = '';
    let insideThink = false;
    let tagBuffer = '';

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
          if (parsed.done) {
            onDone();
            return;
          }
          if (!token) continue;

          tagBuffer += token;

          // Detect <think> opening
          if (!insideThink && tagBuffer.includes('<think>')) {
            const before = tagBuffer.split('<think>')[0];
            if (before) onToken(before);
            insideThink = true;
            tagBuffer = '';
            continue;
          }

          // Inside thinking — emit thinking tokens, watch for </think>
          if (insideThink) {
            if (tagBuffer.includes('</think>')) {
              // Emit the last chunk of thinking (before </think>)
              const thinkContent = tagBuffer.split('</think>')[0];
              if (thinkContent) onThinkingToken?.(thinkContent);
              // Signal thinking is done
              onThinkingToken?.(null);

              const after = tagBuffer.split('</think>').slice(1).join('</think>');
              insideThink = false;
              tagBuffer = '';
              const cleaned = after.replace(/^\s+/, '');
              if (cleaned) onToken(cleaned);
            } else {
              // Emit thinking tokens as they arrive, keep tail for tag detection
              const safe = tagBuffer.slice(0, -10);
              if (safe) onThinkingToken?.(safe);
              tagBuffer = tagBuffer.slice(-10);
            }
            continue;
          }

          // Normal content — emit when we're sure there's no partial <think
          if (tagBuffer.length > 50 || !tagBuffer.includes('<')) {
            onToken(tagBuffer);
            tagBuffer = '';
          }
        } catch {
          // Skip malformed lines
        }
      }
    }

    // Flush remaining
    if (tagBuffer && !insideThink) {
      onToken(tagBuffer);
    }

    onDone();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Diff] Chat error:`, msg);
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      onError(new Error(
        `Cannot reach ${OLLAMA_CLOUD_API_URL} — network error. Are you on the right URL?`
      ));
    } else {
      onError(err instanceof Error ? err : new Error(msg));
    }
  }
}
