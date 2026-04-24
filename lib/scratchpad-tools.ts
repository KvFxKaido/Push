/**
 * Scratchpad tools — allows the LLM to update the shared scratchpad.
 *
 * Tools:
 * - set_scratchpad: Replace entire content
 * - append_scratchpad: Add to existing content
 *
 * Security notes:
 * - Content is escaped to prevent prompt injection (breaking out of [SCRATCHPAD] delimiters)
 * - Content length is capped to prevent DoS via localStorage exhaustion
 */

import { detectToolFromText } from './tool-call-parsing.js';
import { getToolArgHint, getToolPublicName, resolveToolName } from './tool-registry.js';

// Max scratchpad content size (50KB) — prevents localStorage exhaustion and context bloat
const MAX_CONTENT_LENGTH = 50_000;

export interface ScratchpadToolCall {
  tool: 'set_scratchpad' | 'append_scratchpad' | 'read_scratchpad';
  content: string;
}

/**
 * Protocol prompt for the orchestrator system prompt.
 */
export const SCRATCHPAD_TOOL_PROTOCOL = `
## Scratchpad Tools

The scratchpad is your shared working memory with the user for this repo. It persists across chats on this repo — treat it as your continuity layer, not a one-shot note. Concrete step plans for the current effort belong in the todo list (see Todo Tools), not here.

The user can open the scratchpad anytime via the UI. Update it with these tools:

### ${getToolPublicName('set_scratchpad')}
Replace the entire scratchpad content:
\`\`\`json
${getToolArgHint('set_scratchpad')}
\`\`\`

### ${getToolPublicName('append_scratchpad')}
Add to the existing content (good for incremental updates):
\`\`\`json
${getToolArgHint('append_scratchpad')}
\`\`\`

### ${getToolPublicName('read_scratchpad')}
Read the current scratchpad content (usually unnecessary — the content is already in the [SCRATCHPAD] block above):
\`\`\`json
${getToolArgHint('read_scratchpad')}
\`\`\`

Legacy long names still work for compatibility, but prefer the short names above.

**What belongs here:**
- Current focus and why (what problem are we solving, for whom)
- Decisions made and their rationale — so future turns don't re-litigate them
- Relevant context from the user (constraints, preferences, domain facts)
- Open questions or blockers waiting on the user
- Links, file paths, or snippets worth keeping close

**What does NOT belong here:**
- Step-by-step task plans — those go in the todo list via ${getToolPublicName('todo_write')}
- The user's profile/About You settings. You cannot edit profile fields; point them at Settings > About You for permanent personal info.
- Long pasted logs or raw tool output — summarize instead.

**Suggested structure** (adapt as the work evolves):
\`\`\`markdown
## Current Focus
## Decisions
## Open Questions
## Context from User
\`\`\`

**Format tips:**
- Markdown headers (##) for sections, bullets for lists — keep it scannable.
- This is a living doc. When an item is resolved, edit it to reflect the resolution rather than stacking contradictory notes.
`;

/**
 * Detect a scratchpad tool call in text.
 * Handles both flat format: {"tool": "set_scratchpad", "content": "..."}
 * and args-wrapped format: {"tool": "set_scratchpad", "args": {"content": "..."}}
 */
export function detectScratchpadToolCall(text: string): ScratchpadToolCall | null {
  return detectToolFromText<ScratchpadToolCall>(text, (parsed) => {
    const rawTool =
      typeof parsed === 'object' && parsed !== null && 'tool' in parsed
        ? (parsed as { tool?: unknown }).tool
        : undefined;
    const resolvedTool = resolveToolName(typeof rawTool === 'string' ? rawTool : undefined);
    // read_scratchpad — no content needed
    if (resolvedTool === 'read_scratchpad' || isReadScratchpadTool(parsed)) {
      return { tool: 'read_scratchpad', content: '' };
    }
    if (isScratchpadTool(parsed)) {
      return {
        tool: (resolveToolName(parsed.tool) as ScratchpadToolCall['tool']) ?? parsed.tool,
        content: parsed.content,
      };
    }
    // Handle args-wrapped format: {"tool": "set_scratchpad", "args": {"content": "..."}}
    if (isScratchpadToolWrapped(parsed)) {
      return {
        tool: (resolveToolName(parsed.tool) as ScratchpadToolCall['tool']) ?? parsed.tool,
        content: (parsed.args as { content: string }).content,
      };
    }
    return null;
  });
}

function isScratchpadTool(
  obj: unknown,
): obj is { tool: 'set_scratchpad' | 'append_scratchpad'; content: string } {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'tool' in obj &&
    (resolveToolName((obj as { tool?: string }).tool) === 'set_scratchpad' ||
      resolveToolName((obj as { tool?: string }).tool) === 'append_scratchpad') &&
    'content' in obj &&
    typeof (obj as { content: unknown }).content === 'string'
  );
}

function isReadScratchpadTool(obj: unknown): obj is { tool: 'read_scratchpad' } {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    'tool' in obj &&
    resolveToolName((obj as { tool?: string }).tool) === 'read_scratchpad'
  );
}

function isScratchpadToolWrapped(
  obj: unknown,
): obj is { tool: 'set_scratchpad' | 'append_scratchpad'; args: { content: string } } {
  if (typeof obj !== 'object' || obj === null) return false;
  const toolName = !('tool' in obj) ? null : resolveToolName((obj as { tool?: string }).tool);
  if (toolName !== 'set_scratchpad' && toolName !== 'append_scratchpad') return false;
  if (
    !('args' in obj) ||
    typeof (obj as { args: unknown }).args !== 'object' ||
    (obj as { args: unknown }).args === null
  )
    return false;
  const args = (obj as { args: { content?: unknown } }).args;
  return typeof args.content === 'string';
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
  // read_scratchpad — return current content (capped to avoid duplicating the
  // full scratchpad that's already in the system prompt and blowing context)
  if (call.tool === 'read_scratchpad') {
    if (!currentContent.trim()) {
      return { text: '[Scratchpad is empty — no content yet]', ok: true };
    }
    const READ_CAP = 2_000;
    const preview =
      currentContent.length > READ_CAP
        ? currentContent.slice(0, READ_CAP) +
          `\n\n[...truncated at ${READ_CAP} chars — full content (${currentContent.length} chars) is in the system prompt]`
        : currentContent;
    return { text: `[Scratchpad content (${currentContent.length} chars)]\n${preview}`, ok: true };
  }

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
