import type { ChatMessage } from '@/types';
import { TOOL_PROTOCOL } from './github-tools';
import { SANDBOX_TOOL_PROTOCOL } from './sandbox-tools';
import { getOpenRouterKey } from '@/hooks/useOpenRouterKey';
import { getOllamaKey } from '@/hooks/useOllamaKey';

// ---------------------------------------------------------------------------
// Ollama Cloud config
// ---------------------------------------------------------------------------

// Dev: Vite proxy avoids CORS. Prod: Vercel Edge function at /api/chat holds the key.
const OLLAMA_CLOUD_API_URL =
  import.meta.env.VITE_OLLAMA_CLOUD_API_URL ||
  (import.meta.env.DEV ? '/ollama/api/chat' : '/api/chat');

const OLLAMA_ORCHESTRATOR_MODEL = 'kimi-k2.5:cloud';

// ---------------------------------------------------------------------------
// OpenRouter config
// ---------------------------------------------------------------------------

const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'nvidia/nemotron-3-nano-30b-a3b:free';

// ---------------------------------------------------------------------------
// Shared: system prompt, demo text, message builder
// ---------------------------------------------------------------------------

export const ORCHESTRATOR_SYSTEM_PROMPT = `You are Diff, a concise AI coding assistant with direct GitHub repo access. You help developers review PRs, understand codebases, and ship changes from their phone.

Rules:
- Be conversational but concise. No walls of text.
- When the user asks about repos or PRs, describe what you see and offer next steps.
- Use markdown for code snippets. Keep responses scannable.
- You're mobile-first — short paragraphs, clear structure.
- If you don't know something, say so. Don't guess.
- Never start with "I" — vary your openings.
- FOCUS: You only know about and operate on the currently active repo. Never mention, suggest, or offer to switch to other repos — the user controls that via the UI. All questions about "the repo", "PRs", "recent changes" refer to the active repo. Period.`;

const DEMO_WELCOME = `Welcome to **Diff** — your AI coding agent with direct repo access.

Here's what I can help with:

- **Review PRs** — paste a GitHub PR link and I'll analyze it
- **Explore repos** — ask about any repo's structure, recent changes, or open issues
- **Ship changes** — describe what you want changed and I'll draft the code
- **Monitor pipelines** — check CI/CD status and deployment health

Connect your GitHub account in settings to get started, or just ask me anything about code.`;

interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function toLLMMessages(
  messages: ChatMessage[],
  workspaceContext?: string,
  hasSandbox?: boolean,
  systemPromptOverride?: string,
): LLMMessage[] {
  // Build system prompt: base + workspace context + tool protocol + optional sandbox tools
  let systemContent = systemPromptOverride || ORCHESTRATOR_SYSTEM_PROMPT;
  if (workspaceContext) {
    systemContent += '\n\n' + workspaceContext + '\n' + TOOL_PROTOCOL;
    if (hasSandbox) {
      systemContent += '\n' + SANDBOX_TOOL_PROTOCOL;
    }
  }

  const llmMessages: LLMMessage[] = [
    { role: 'system', content: systemContent },
  ];

  for (const msg of messages) {
    llmMessages.push({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content,
    });
  }

  return llmMessages;
}

// ---------------------------------------------------------------------------
// Shared: <think> tag parser
// ---------------------------------------------------------------------------

interface ThinkTokenParser {
  push(token: string): void;
  flush(): void;
}

function createThinkTokenParser(
  onToken: (token: string) => void,
  onThinkingToken?: (token: string | null) => void,
): ThinkTokenParser {
  let insideThink = false;
  let tagBuffer = '';

  return {
    push(token: string) {
      tagBuffer += token;

      // Detect <think> opening
      if (!insideThink && tagBuffer.includes('<think>')) {
        const before = tagBuffer.split('<think>')[0];
        if (before) onToken(before);
        insideThink = true;
        tagBuffer = '';
        return;
      }

      // Inside thinking — emit thinking tokens, watch for </think>
      if (insideThink) {
        if (tagBuffer.includes('</think>')) {
          const thinkContent = tagBuffer.split('</think>')[0];
          if (thinkContent) onThinkingToken?.(thinkContent);
          onThinkingToken?.(null); // signal thinking done

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
        return;
      }

      // Normal content — emit when we're sure there's no partial <think
      if (tagBuffer.length > 50 || !tagBuffer.includes('<')) {
        onToken(tagBuffer);
        tagBuffer = '';
      }
    },

    flush() {
      if (tagBuffer && !insideThink) {
        onToken(tagBuffer);
      }
      tagBuffer = '';
    },
  };
}

// ---------------------------------------------------------------------------
// Ollama Cloud streaming (ndjson)
// ---------------------------------------------------------------------------

async function streamOllamaChat(
  messages: ChatMessage[],
  onToken: (token: string) => void,
  onDone: () => void,
  onError: (error: Error) => void,
  onThinkingToken?: (token: string | null) => void,
  workspaceContext?: string,
  hasSandbox?: boolean,
): Promise<void> {
  try {
    console.log(`[Diff] POST ${OLLAMA_CLOUD_API_URL} (model: ${OLLAMA_ORCHESTRATOR_MODEL})`);

    const ollamaKey = getOllamaKey();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (ollamaKey) {
      headers['Authorization'] = `Bearer ${ollamaKey}`;
    }

    const response = await fetch(OLLAMA_CLOUD_API_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: OLLAMA_ORCHESTRATOR_MODEL,
        messages: toLLMMessages(messages, workspaceContext, hasSandbox),
        stream: true,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
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

    const decoder = new TextDecoder();
    let buffer = '';
    const parser = createThinkTokenParser(onToken, onThinkingToken);

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
            parser.flush();
            onDone();
            return;
          }
          if (!token) continue;
          parser.push(token);
        } catch {
          // Skip malformed lines
        }
      }
    }

    parser.flush();
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

// ---------------------------------------------------------------------------
// OpenRouter streaming (SSE)
// ---------------------------------------------------------------------------

export async function streamOpenRouterChat(
  messages: ChatMessage[],
  onToken: (token: string) => void,
  onDone: () => void,
  onError: (error: Error) => void,
  onThinkingToken?: (token: string | null) => void,
  workspaceContext?: string,
  hasSandbox?: boolean,
  modelOverride?: string,
  systemPromptOverride?: string,
): Promise<void> {
  const apiKey = getOpenRouterKey();
  if (!apiKey) {
    onError(new Error('OpenRouter API key not configured'));
    return;
  }

  const model = modelOverride || OPENROUTER_MODEL;

  try {
    console.log(`[Diff] POST ${OPENROUTER_API_URL} (model: ${model})`);

    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'HTTP-Referer': window.location.origin,
        'X-Title': 'Diff',
      },
      body: JSON.stringify({
        model,
        messages: toLLMMessages(messages, workspaceContext, hasSandbox, systemPromptOverride),
        stream: true,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      let detail = '';
      try {
        const parsed = JSON.parse(body);
        detail = parsed.error?.message || parsed.error || body.slice(0, 200);
      } catch {
        detail = body ? body.slice(0, 200) : 'empty body';
      }
      console.error(`[Diff] OpenRouter error: ${response.status}`, detail);
      throw new Error(`OpenRouter ${response.status}: ${detail}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    // SSE format: lines starting with "data: " followed by JSON
    // Stream ends with "data: [DONE]"
    const decoder = new TextDecoder();
    let buffer = '';
    const parser = createThinkTokenParser(onToken, onThinkingToken);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') {
          if (trimmed === 'data: [DONE]') {
            parser.flush();
            onDone();
            return;
          }
          continue;
        }

        // SSE lines start with "data: "
        if (!trimmed.startsWith('data: ')) continue;
        const jsonStr = trimmed.slice(6);

        try {
          const parsed = JSON.parse(jsonStr);
          const choice = parsed.choices?.[0];
          if (!choice) continue;

          // Check finish_reason
          if (choice.finish_reason === 'stop' || choice.finish_reason === 'end_turn') {
            parser.flush();
            onDone();
            return;
          }

          const token = choice.delta?.content;
          if (!token) continue;
          parser.push(token);
        } catch {
          // Skip malformed SSE data
        }
      }
    }

    // If we reach here without [DONE], still flush and finish
    parser.flush();
    onDone();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Diff] OpenRouter chat error:`, msg);
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      onError(new Error(
        `Cannot reach OpenRouter — network error. Check your connection.`
      ));
    } else {
      onError(err instanceof Error ? err : new Error(msg));
    }
  }
}

// ---------------------------------------------------------------------------
// Public router — picks the right provider at runtime
// ---------------------------------------------------------------------------

export async function streamChat(
  messages: ChatMessage[],
  onToken: (token: string) => void,
  onDone: () => void,
  onError: (error: Error) => void,
  onThinkingToken?: (token: string | null) => void,
  workspaceContext?: string,
  hasSandbox?: boolean,
): Promise<void> {
  // Check both keys at runtime (not module load) so Settings changes take effect immediately
  if (import.meta.env.DEV && !getOllamaKey() && !getOpenRouterKey()) {
    const words = DEMO_WELCOME.split(' ');
    for (let i = 0; i < words.length; i++) {
      await new Promise((r) => setTimeout(r, 12));
      onToken(words[i] + (i < words.length - 1 ? ' ' : ''));
    }
    onDone();
    return;
  }

  if (getOpenRouterKey()) {
    return streamOpenRouterChat(messages, onToken, onDone, onError, onThinkingToken, workspaceContext, hasSandbox);
  }

  return streamOllamaChat(messages, onToken, onDone, onError, onThinkingToken, workspaceContext, hasSandbox);
}
