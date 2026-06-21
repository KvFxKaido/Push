/**
 * Memory tools — let agents search and recall persisted typed-memory records
 * (prior decisions, findings, verification output) verbatim.
 *
 * Detection + protocol only. Execution routes through the shared
 * `lib/memory-tool-exec.ts` (called from `web-tool-execution-runtime.ts`), so
 * the behavior is identical on web and CLI. Scope (repo/branch/chat) is injected
 * by the executor from session context — never from these model args.
 */

import { detectToolFromText } from './utils';
import { getToolArgHint, getToolPublicName, resolveToolName } from './tool-registry';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryGrepToolCall {
  tool: 'memory_grep';
  args: { pattern: string; kinds?: string[]; limit?: number };
}

export interface MemoryExpandToolCall {
  tool: 'memory_expand';
  args: { ids?: string[]; refs?: string[] };
}

export type MemoryToolCall = MemoryGrepToolCall | MemoryExpandToolCall;

// ---------------------------------------------------------------------------
// Protocol prompt
// ---------------------------------------------------------------------------

export const MEMORY_TOOL_PROTOCOL = `
## Memory Recall

Past work on this repo/branch is persisted as typed memory records (decisions,
findings, verification output). Retrieved-memory blocks show short summaries with
a \`[mem_…]\` id on each line. You can search and recall the full verbatim text:

\`\`\`json
${getToolArgHint('memory_grep')}
\`\`\`

\`\`\`json
${getToolArgHint('memory_expand')}
\`\`\`

**When to use:**
- A retrieved-memory summary is truncated and you need the exact prior text
- You need to recall a decision, finding, or verification result from earlier work
- You suspect relevant prior context exists but isn't in the current window

**Rules:**
- \`${getToolPublicName('memory_grep')}\` takes a case-insensitive substring \`pattern\`
  (optional \`kinds\`, \`limit\`); it returns matches with their \`[mem_…]\` id and a
  short text **snippet** — not the whole record.
- To read in full, call \`${getToolPublicName('memory_expand')}\` with \`ids\` (records,
  from a grep result or a \`[mem_…]\` tag) and/or \`refs\` (verbatim \`vb_…\` handles
  shown in a reduced tool result's recall marker); it returns the full verbatim text.
- These are read-only and scoped to the current repo/branch automatically.
`;

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string') return [value];
  return [];
}

/**
 * Detect a memory_grep / memory_expand tool call in the model's output text.
 */
export function detectMemoryToolCall(text: string): MemoryToolCall | null {
  return detectToolFromText<MemoryToolCall>(text, (parsed) => {
    if (typeof parsed !== 'object' || parsed === null || !('tool' in parsed)) return null;
    const canonical = resolveToolName((parsed as { tool: string }).tool);
    const args = (parsed as { args?: unknown }).args;
    const argObj =
      typeof args === 'object' && args !== null ? (args as Record<string, unknown>) : {};

    if (canonical === 'memory_grep') {
      if (typeof argObj.pattern !== 'string') return null;
      const call: MemoryGrepToolCall = { tool: 'memory_grep', args: { pattern: argObj.pattern } };
      const kinds = toStringArray(argObj.kinds);
      if (kinds.length > 0) call.args.kinds = kinds;
      if (typeof argObj.limit === 'number') call.args.limit = argObj.limit;
      return call;
    }

    if (canonical === 'memory_expand') {
      const ids = toStringArray(argObj.ids);
      const refs = toStringArray(argObj.refs);
      if (ids.length === 0 && refs.length === 0) return null;
      const call: MemoryExpandToolCall = { tool: 'memory_expand', args: {} };
      if (ids.length > 0) call.args.ids = ids;
      if (refs.length > 0) call.args.refs = refs;
      return call;
    }

    return null;
  });
}
