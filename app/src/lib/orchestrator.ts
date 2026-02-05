import type { ChatMessage } from '@/types';
import { TOOL_PROTOCOL } from './github-tools';
import { SANDBOX_TOOL_PROTOCOL } from './sandbox-tools';
import { SCRATCHPAD_TOOL_PROTOCOL, buildScratchpadContext } from './scratchpad-tools';
import { getMoonshotKey } from '@/hooks/useMoonshotKey';

// ---------------------------------------------------------------------------
// Kimi For Coding config
// ---------------------------------------------------------------------------

// Dev: Vite proxy avoids CORS. Prod: Cloudflare Worker proxy at /api/kimi/chat.
const KIMI_API_URL = import.meta.env.DEV
  ? '/kimi/coding/v1/chat/completions'
  : '/api/kimi/chat';
const KIMI_MODEL = 'k2p5';

// Rolling window config — keeps context focused and latency low
const MAX_HISTORY_MESSAGES = 30;

// ---------------------------------------------------------------------------
// Rolling Window — trims old messages while keeping tool call/result pairs intact
// ---------------------------------------------------------------------------

/**
 * Trim messages to a rolling window, preserving tool call/result pairs.
 *
 * Tool calls and their results are a logical unit — splitting them causes
 * the LLM to hallucinate about what tool was called or misinterpret results.
 *
 * Algorithm: Walk backwards, keeping messages until we hit the limit.
 * If we include a tool result, also include the preceding tool call.
 */
function trimToRollingWindow(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= MAX_HISTORY_MESSAGES) {
    return messages;
  }

  const kept: ChatMessage[] = [];
  let count = 0;
  let i = messages.length - 1;

  while (i >= 0 && count < MAX_HISTORY_MESSAGES) {
    const msg = messages[i];

    // If this is a tool result, we must also keep the preceding assistant message (tool call)
    if (msg.isToolResult && i > 0) {
      const toolCall = messages[i - 1];
      // Add both: tool call first, then result
      kept.unshift(msg);
      kept.unshift(toolCall);
      count += 2;
      i -= 2;
    } else {
      kept.unshift(msg);
      count++;
      i--;
    }
  }

  // Log when we truncate (helpful for debugging)
  if (messages.length > kept.length) {
    console.log(`[Push] Rolling window: ${messages.length} → ${kept.length} messages`);
  }

  return kept;
}

// ---------------------------------------------------------------------------
// Shared: system prompt, demo text, message builder
// ---------------------------------------------------------------------------

export const ORCHESTRATOR_SYSTEM_PROMPT = `Push is a mobile AI coding agent with direct GitHub repo access. You are its conversational interface — helping developers review PRs, understand codebases, and ship changes from their phone.

Voice:
- Concise but warm. Short paragraphs, clear structure — this is mobile.
- Explain your reasoning briefly. Don't just state conclusions.
- Light personality is fine. You're helpful, not robotic.
- Use markdown for code snippets. Keep responses scannable.
- Vary your openings. Never start with "I".

Boundaries:
- If you don't know something, say so. Don't guess.
- You only know about the active repo. Never mention other repos — the user controls that via UI.
- All questions about "the repo", PRs, or changes refer to the active repo. Period.`;

const DEMO_WELCOME = `Welcome to **Push** — your AI coding agent with direct repo access.

Here's what I can help with:

- **Review PRs** — paste a GitHub PR link and I'll analyze it
- **Explore repos** — ask about any repo's structure, recent changes, or open issues
- **Ship changes** — describe what you want changed and I'll draft the code
- **Monitor pipelines** — check CI/CD status and deployment health

Connect your GitHub account in settings to get started, or just ask me anything about code.`;

// Multimodal content types (OpenAI-compatible)
interface LLMMessageContentText {
  type: 'text';
  text: string;
}

interface LLMMessageContentImage {
  type: 'image_url';
  image_url: { url: string };
}

type LLMMessageContent = LLMMessageContentText | LLMMessageContentImage;

interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | LLMMessageContent[];
}

function toLLMMessages(
  messages: ChatMessage[],
  workspaceContext?: string,
  hasSandbox?: boolean,
  systemPromptOverride?: string,
  scratchpadContent?: string,
): LLMMessage[] {
  // Build system prompt: base + workspace context + tool protocol + optional sandbox tools + scratchpad
  let systemContent = systemPromptOverride || ORCHESTRATOR_SYSTEM_PROMPT;
  if (workspaceContext) {
    systemContent += '\n\n' + workspaceContext + '\n' + TOOL_PROTOCOL;
    if (hasSandbox) {
      systemContent += '\n' + SANDBOX_TOOL_PROTOCOL;
    }
  }

  // Always include scratchpad context and tools (even if empty)
  systemContent += '\n' + SCRATCHPAD_TOOL_PROTOCOL;
  if (scratchpadContent !== undefined) {
    systemContent += '\n\n' + buildScratchpadContext(scratchpadContent);
  }

  const llmMessages: LLMMessage[] = [
    { role: 'system', content: systemContent },
  ];

  // Apply rolling window to keep context focused
  const windowedMessages = trimToRollingWindow(messages);

  for (const msg of windowedMessages) {
    // Check for attachments (multimodal message)
    if (msg.attachments && msg.attachments.length > 0) {
      const contentParts: LLMMessageContent[] = [];

      // Add text first (if any)
      if (msg.content) {
        contentParts.push({ type: 'text', text: msg.content });
      }

      // Add attachments
      for (const att of msg.attachments) {
        if (att.type === 'image') {
          // Image: use image_url format with base64 data URL
          contentParts.push({
            type: 'image_url',
            image_url: { url: att.content },
          });
        } else {
          // Code/document: embed as text block
          contentParts.push({
            type: 'text',
            text: `[Attached file: ${att.filename}]\n\`\`\`\n${att.content}\n\`\`\``,
          });
        }
      }

      llmMessages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: contentParts,
      });
    } else {
      // Simple text message (existing behavior)
      llmMessages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content,
      });
    }
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
// Smart Chunking — reduces UI updates on mobile by batching tokens
// ---------------------------------------------------------------------------

interface ChunkedEmitter {
  push(token: string): void;
  flush(): void;
}

/**
 * Creates a chunked emitter that batches tokens for smoother mobile UI.
 *
 * Tokens are buffered and emitted when:
 * 1. A word boundary (space/newline) is encountered
 * 2. Buffer reaches MIN_CHUNK_SIZE characters
 * 3. FLUSH_INTERVAL_MS passes without emission
 *
 * This reduces React setState calls from per-character to per-word,
 * dramatically improving performance on slower mobile devices.
 */
function createChunkedEmitter(
  emit: (chunk: string) => void,
  options?: { minChunkSize?: number; flushIntervalMs?: number },
): ChunkedEmitter {
  const MIN_CHUNK_SIZE = options?.minChunkSize ?? 4;  // Min chars before emitting
  const FLUSH_INTERVAL_MS = options?.flushIntervalMs ?? 50; // Max time to hold tokens

  let buffer = '';
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const doEmit = () => {
    if (buffer) {
      emit(buffer);
      buffer = '';
    }
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
  };

  const scheduleFlush = () => {
    if (!flushTimer) {
      flushTimer = setTimeout(doEmit, FLUSH_INTERVAL_MS);
    }
  };

  return {
    push(token: string) {
      buffer += token;

      // Emit on word boundaries (space, newline) if we have enough content
      const hasWordBoundary = /[\s\n]/.test(token);
      if (hasWordBoundary && buffer.length >= MIN_CHUNK_SIZE) {
        doEmit();
        return;
      }

      // Emit if buffer is getting large (long word without spaces)
      if (buffer.length >= MIN_CHUNK_SIZE * 4) {
        doEmit();
        return;
      }

      // Otherwise, schedule a flush to ensure tokens don't get stuck
      scheduleFlush();
    },

    flush() {
      doEmit();
    },
  };
}

// ---------------------------------------------------------------------------
// Kimi For Coding streaming (SSE — OpenAI-compatible)
// ---------------------------------------------------------------------------

// --- Usage data from streaming responses ---

export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export async function streamMoonshotChat(
  messages: ChatMessage[],
  onToken: (token: string) => void,
  onDone: (usage?: StreamUsage) => void,
  onError: (error: Error) => void,
  onThinkingToken?: (token: string | null) => void,
  workspaceContext?: string,
  hasSandbox?: boolean,
  modelOverride?: string,
  systemPromptOverride?: string,
  scratchpadContent?: string,
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
    console.log(`[Push] POST ${KIMI_API_URL} (model: ${model})`);

    const response = await fetch(KIMI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: toLLMMessages(messages, workspaceContext, hasSandbox, systemPromptOverride, scratchpadContent),
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
      console.error(`[Push] Moonshot error: ${response.status}`, detail);
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

    // Smart chunking: batch tokens for smoother mobile UI
    const chunker = createChunkedEmitter(onToken);
    const parser = createThinkTokenParser((token) => chunker.push(token), onThinkingToken);

    // Track usage from response
    let usage: StreamUsage | undefined;

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
          chunker.flush();
          onDone(usage);
          return;
        }

        // SSE data lines: "data: {...}" or "data:{...}" (with or without space)
        if (!trimmed.startsWith('data:')) continue;
        const jsonStr = trimmed[5] === ' ' ? trimmed.slice(6) : trimmed.slice(5);

        try {
          const parsed = JSON.parse(jsonStr);

          // Extract usage data if present (usually in final chunk)
          if (parsed.usage) {
            usage = {
              inputTokens: parsed.usage.prompt_tokens || 0,
              outputTokens: parsed.usage.completion_tokens || 0,
              totalTokens: parsed.usage.total_tokens || 0,
            };
          }

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
            chunker.flush();
            onDone(usage);
            return;
          }
        } catch {
          // Skip malformed SSE data
        }
      }
    }

    // If we reach here without [DONE], still flush and finish
    parser.flush();
    chunker.flush();
    onDone(usage);
  } catch (err) {
    // Cleanup timers on error path
    clearTimeout(connectTimer);
    clearTimeout(idleTimer);

    // Handle abort errors with specific messages
    if (err instanceof DOMException && err.name === 'AbortError') {
      const timeoutMsg = abortReason === 'connect'
        ? `Kimi API didn't respond within ${CONNECT_TIMEOUT_MS / 1000}s — server may be down.`
        : `Kimi API stream stalled — no data for ${IDLE_TIMEOUT_MS / 1000}s.`;
      console.error(`[Push] Moonshot timeout (${abortReason}):`, timeoutMsg);
      onError(new Error(timeoutMsg));
      return;
    }

    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Push] Moonshot chat error:`, msg);
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
  onDone: (usage?: StreamUsage) => void,
  onError: (error: Error) => void,
  onThinkingToken?: (token: string | null) => void,
  workspaceContext?: string,
  hasSandbox?: boolean,
  scratchpadContent?: string,
): Promise<void> {
  // Demo mode: no API key in dev → show welcome message
  if (import.meta.env.DEV && !getMoonshotKey()) {
    const words = DEMO_WELCOME.split(' ');
    for (let i = 0; i < words.length; i++) {
      await new Promise((r) => setTimeout(r, 12));
      onToken(words[i] + (i < words.length - 1 ? ' ' : ''));
    }
    onDone(); // No usage data in demo mode
    return;
  }

  return streamMoonshotChat(messages, onToken, onDone, onError, onThinkingToken, workspaceContext, hasSandbox, undefined, undefined, scratchpadContent);
}
