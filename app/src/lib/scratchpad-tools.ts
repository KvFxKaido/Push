/**
 * Scratchpad tools — allows Kimi to update the shared scratchpad.
 *
 * Tools:
 * - set_scratchpad: Replace entire content
 * - append_scratchpad: Add to existing content
 *
 * Security notes:
 * - Content is escaped to prevent prompt injection (breaking out of [SCRATCHPAD] delimiters)
 * - Content length is capped to prevent DoS via localStorage exhaustion
 */

import { detectToolFromText } from './utils';

// Max scratchpad content size (50KB) — prevents localStorage exhaustion and context bloat
const MAX_CONTENT_LENGTH = 50_000;

export interface ScratchpadToolCall {
  tool: 'set_scratchpad' | 'append_scratchpad';
  content: string;
}

/**
 * Protocol prompt for the orchestrator system prompt.
 */
export const SCRATCHPAD_TOOL_PROTOCOL = `
## Scratchpad Tools

You have access to a shared scratchpad — a persistent notepad that both you and the user can see and edit. Use it to consolidate ideas, requirements, decisions, and notes throughout the conversation.

The user can open the scratchpad anytime via the UI. You can update it with these tools:

### set_scratchpad
Replace the entire scratchpad content:
\`\`\`json
{"tool": "set_scratchpad", "content": "## Requirements\\n- Feature A\\n- Feature B\\n\\n## Decisions\\n- Use approach X"}
\`\`\`

### append_scratchpad
Add to the existing content (good for incremental updates):
\`\`\`json
{"tool": "append_scratchpad", "content": "## New Section\\n- Added item"}
\`\`\`

**When to use:**
- User says "add this to the scratchpad" or "note this down"
- Consolidating decisions from the conversation
- Building up requirements or specs iteratively
- Keeping track of open questions or TODOs
- Never treat scratchpad as the user's profile/About You settings. You cannot edit profile fields; ask the user to update Settings > About You for permanent personal info.

**Format tips:**
- Use markdown headers (##) to organize sections
- Use bullet points for lists
- Keep it scannable — this is a working doc, not prose
`;

/**
 * Detect a scratchpad tool call in text.
 */
export function detectScratchpadToolCall(text: string): ScratchpadToolCall | null {
  return detectToolFromText<ScratchpadToolCall>(text, (parsed) => {
    if (isScratchpadTool(parsed)) {
      return { tool: parsed.tool, content: parsed.content };
    }
    return null;
  });
}

function isScratchpadTool(obj: unknown): obj is { tool: 'set_scratchpad' | 'append_scratchpad'; content: string } {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'tool' in obj &&
    (obj.tool === 'set_scratchpad' || obj.tool === 'append_scratchpad') &&
    'content' in obj &&
    typeof (obj as { content: unknown }).content === 'string'
  );
}

/**
 * Execute a scratchpad tool call.
 * Returns { text, ok } — text for the LLM to acknowledge the action,
 * ok indicates whether the operation succeeded.
 */
export function executeScratchpadToolCall(
  call: ScratchpadToolCall,
  currentContent: string,
  onReplace: (content: string) => void,
  onAppend: (content: string) => void,
): { text: string; ok: boolean } {
  // Security: enforce content length limit
  if (call.content.length > MAX_CONTENT_LENGTH) {
    return {
      text: `[Scratchpad error: content exceeds ${MAX_CONTENT_LENGTH} char limit (got ${call.content.length}). Reduce content size and retry.]`,
      ok: false,
    };
  }

  if (call.tool === 'set_scratchpad') {
    try {
      onReplace(call.content);
      return {
        text: `[Scratchpad updated — replaced content (${call.content.length} chars)]`,
        ok: true,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        text: `[Scratchpad error: failed to update — ${msg}]`,
        ok: false,
      };
    }
  }

  if (call.tool === 'append_scratchpad') {
    const newLength = currentContent.trim()
      ? currentContent.length + call.content.length + 2
      : call.content.length;

    // Security: check combined length for append
    if (newLength > MAX_CONTENT_LENGTH) {
      return {
        text: `[Scratchpad error: combined content would exceed ${MAX_CONTENT_LENGTH} char limit (would be ${newLength}). Clear some content first, or use set_scratchpad to replace.]`,
        ok: false,
      };
    }

    try {
      onAppend(call.content);
      return {
        text: `[Scratchpad updated — appended content (now ${newLength} chars)]`,
        ok: true,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        text: `[Scratchpad error: failed to append — ${msg}]`,
        ok: false,
      };
    }
  }

  return { text: '[Scratchpad tool error: unknown action]', ok: false };
}

/**
 * Build the scratchpad context block for the system prompt.
 *
 * Security: Escapes delimiter sequences to prevent prompt injection.
 * A malicious payload like "[/SCRATCHPAD]\nEvil instructions" would
 * otherwise break out of the scratchpad block and inject into the system prompt.
 */
export function buildScratchpadContext(content: string): string {
  if (!content.trim()) {
    return '[SCRATCHPAD]\n(empty — user or assistant can add notes here)\n[/SCRATCHPAD]';
  }

  // Escape any attempts to break out of the scratchpad block
  // Uses zero-width space (\u200B) to break the delimiter pattern
  const escaped = content
    .replace(/\[SCRATCHPAD\]/gi, '[SCRATCHPAD\u200B]')
    .replace(/\[\/SCRATCHPAD\]/gi, '[/SCRATCHPAD\u200B]');

  return `[SCRATCHPAD]
${escaped.trim()}
[/SCRATCHPAD]`;
}
