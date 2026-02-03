import type { ChatMessage } from '@/types';
import { TOOL_PROTOCOL } from './github-tools';
import { SANDBOX_TOOL_PROTOCOL } from './sandbox-tools';
import { getMoonshotKey } from '@/hooks/useMoonshotKey';

// ---------------------------------------------------------------------------
// Kimi For Coding config
// ---------------------------------------------------------------------------

// Dev: Vite proxy avoids CORS. Prod: Cloudflare Worker proxy at /api/kimi/chat.
const KIMI_API_URL = import.meta.env.DEV
  ? '/kimi/coding/v1/chat/completions'
  : '/api/kimi/chat';
const KIMI_MODEL = 'k2p5';

// ---------------------------------------------------------------------------
// Shared: system prompt, demo text, message builder
// ---------------------------------------------------------------------------

export const ORCHESTRATOR_SYSTEM_PROMPT = `You are Push, a concise AI coding assistant with direct GitHub repo access. You help developers review PRs, understand codebases, and ship changes from their phone.

Rules:
- Be conversational but concise. No walls of text.
- When the user asks about repos or PRs, describe what you see and offer next steps.
- Use markdown for code snippets. Keep responses scannable.
- You're mobile-first — short paragraphs, clear structure.
- If you don't know something, say so. Don't guess.
- Never start with "I" — vary your openings.
- FOCUS: You only know about and operate on the currently active repo. Never mention, suggest, or offer to switch to other repos — the user controls that via the UI. All questions about "the repo", "PRs", "recent changes" refer to the active repo. Period.`;

const DEMO_WELCOME = `Welcome to **Push** — your AI coding agent with direct repo access.

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
// Kimi For Coding streaming (SSE — OpenAI-compatible)
// ---------------------------------------------------------------------------

export async function streamMoonshotChat(
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
  const apiKey = getMoonshotKey();
  if (!apiKey) {
    onError(new Error('Moonshot API key not configured'));
    return;
  }

  const model = modelOverride || KIMI_MODEL;

  const CONNECT_TIMEOUT_MS = 30_000; // 30s to get initial response headers
  const IDLE_TIMEOUT_MS = 60_000;    // 60s max silence during streaming

  const controller = new AbortController();
  let abortReason: 'connect' | 'idle' | null = null;

  // Connection timeout — abort if server doesn't respond
  let connectTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    abortReason = 'connect';
    controller.abort();
  }, CONNECT_TIMEOUT_MS);

  // Idle timer — reset every time we receive data
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const resetIdleTimer = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      abortReason = 'idle';
      controller.abort();
    }, IDLE_TIMEOUT_MS);
  };

  try {
    console.log(`[Diff] POST ${KIMI_API_URL} (model: ${model})`);

    const response = await fetch(KIMI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: toLLMMessages(messages, workspaceContext, hasSandbox, systemPromptOverride),
        stream: true,
      }),
      signal: controller.signal,
    });

    // Connection established — clear connect timeout, start idle timeout
    clearTimeout(connectTimer);
    connectTimer = undefined;
    resetIdleTimer();

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      let detail = '';
      try {
        const parsed = JSON.parse(body);
        detail = parsed.error?.message || parsed.error || body.slice(0, 200);
      } catch {
        detail = body ? body.slice(0, 200) : 'empty body';
      }
      console.error(`[Diff] Moonshot error: ${response.status}`, detail);
      throw new Error(`Moonshot ${response.status}: ${detail}`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('No response body');
    }

    // SSE format: lines starting with "data:" followed by JSON
    // Kimi sends "data:{...}" (no space); OpenAI sends "data: {...}" (with space)
    // Stream ends with "data: [DONE]" or "data:[DONE]"
    const decoder = new TextDecoder();
    let buffer = '';
    const parser = createThinkTokenParser(onToken, onThinkingToken);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      resetIdleTimer(); // got data — reset idle timeout
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // Check for stream termination: "data: [DONE]" or "data:[DONE]"
        if (trimmed === 'data: [DONE]' || trimmed === 'data:[DONE]') {
          parser.flush();
          onDone();
          return;
        }

        // SSE data lines: "data: {...}" or "data:{...}" (with or without space)
        if (!trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed[5] === ' ' ? trimmed.slice(6) : trimmed.slice(5);

        try {
          const parsed = JSON.parse(jsonStr);
          const choice = parsed.choices?.[0];
          if (!choice) continue;

          // Process tokens BEFORE checking finish_reason — Kimi may
          // bundle the last content token in the same SSE event as
          // finish_reason:"stop", so we must capture it first.

          // Kimi For Coding: reasoning tokens arrive via delta.reasoning_content
          const reasoningToken = choice.delta?.reasoning_content;
          if (reasoningToken) {
            onThinkingToken?.(reasoningToken);
          }

          // Content tokens arrive via delta.content
          const token = choice.delta?.content;
          if (token) {
            parser.push(token);
          }

          // Check finish_reason (after processing any final tokens in this chunk)
          if (choice.finish_reason === 'stop' || choice.finish_reason === 'end_turn' || choice.finish_reason === 'tool_calls') {
            parser.flush();
            onDone();
            return;
          }
        } catch {
          // Skip malformed SSE data
        }
      }
    }

    // If we reach here without [DONE], still flush and finish
    parser.flush();
    onDone();
  } catch (err) {
    // Cleanup timers on error path
    clearTimeout(connectTimer);
    clearTimeout(idleTimer);

    // Handle abort errors with specific messages
    if (err instanceof DOMException && err.name === 'AbortError') {
      const timeoutMsg = abortReason === 'connect'
        ? `Kimi API didn't respond within ${CONNECT_TIMEOUT_MS / 1000}s — server may be down.`
        : `Kimi API stream stalled — no data for ${IDLE_TIMEOUT_MS / 1000}s.`;
      console.error(`[Diff] Moonshot timeout (${abortReason}):`, timeoutMsg);
      onError(new Error(timeoutMsg));
      return;
    }

    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Diff] Moonshot chat error:`, msg);
    if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
      onError(new Error(
        `Cannot reach Moonshot — network error. Check your connection.`
      ));
    } else {
      onError(err instanceof Error ? err : new Error(msg));
    }
  } finally {
    clearTimeout(connectTimer);
    clearTimeout(idleTimer);
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
  // Demo mode: no API key in dev → show welcome message
  if (import.meta.env.DEV && !getMoonshotKey()) {
    const words = DEMO_WELCOME.split(' ');
    for (let i = 0; i < words.length; i++) {
      await new Promise((r) => setTimeout(r, 12));
      onToken(words[i] + (i < words.length - 1 ? ' ' : ''));
    }
    onDone();
    return;
  }

  return streamMoonshotChat(messages, onToken, onDone, onError, onThinkingToken, workspaceContext, hasSandbox);
}
