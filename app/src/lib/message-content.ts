import { repairToolJson } from '@/lib/utils';

function isToolCallObject(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.tool === 'string';
}

/** Returns true when text contains only JSON structural characters (brackets, braces, commas, whitespace). */
// eslint-disable-next-line no-useless-escape -- \[ inside character class aids readability
export const ONLY_BRACKETS_RE = /^[\[{}\],\s]*$/;

const BRACED_TOOL_OBJECT_START = /\{\s*["']?tool["']?\s*:\s*(?:["'][^"'\n]*["']|[^,\n{}]+)/s;
const BRACELESS_QUOTED_TOOL_START = /(?:^|\n)\s*["']tool["']\s*:\s*["'][^"'\n]*["']/s;
const BRACELESS_TOOL_WITH_ARGS_OBJECT =
  /(?:^|\n)\s*["']?tool["']?\s*:\s*["'][^"'\n]*["']\s*,\s*["']?args["']?\s*:\s*\{/s;

// Native tool-call echo: some providers emit both delta.content and
// delta.tool_calls for the same invocation.  The bridge converts native calls
// into fenced JSON (stripped above), but the echoed content remains as a
// fragment like:  repo_ls", "args": {"repo": "KvFxKaido/Push"}}
// i.e. the tool-name value followed by the rest of the JSON without {"tool": "
const NATIVE_TOOL_ECHO_RE = /(?:^|\n)\s*[a-z_]\w*["']\s*,\s*["'][a-z_]+["']\s*:/i;

// Orphaned JSON tail: caught when a tool call prefix is lost but the args/braces remain.
// Matches patterns like: ", "workdir": "/workspace"}}
const ORPHANED_JSON_TAIL_RE = /",?\s*["']?[a-z_]+["']?\s*:\s*[^}]*\}\s*\}\s*$/s;

const XML_TOOL_NS = String.raw`(?:[|｜]{1,2}[\w.\-]+[|｜]{1,2})?`;
const XML_TOOL_NS_REQUIRED = String.raw`[|｜]{1,2}[\w.\-]+[|｜]{1,2}`;
const XML_TOOL_CALL_BLOCK_PATTERN = String.raw`<${XML_TOOL_NS}(?:function_calls|tool_calls)\b[^>]*>[\s\S]*?<\/${XML_TOOL_NS}(?:function_calls|tool_calls)\s*>|<${XML_TOOL_NS}tool_call\b[^>]*>[\s\S]*?<\/${XML_TOOL_NS}tool_call\s*>|<${XML_TOOL_NS}invoke\b[^>]*?\bname\s*=[^>]*>[\s\S]*?<\/${XML_TOOL_NS}invoke\s*>`;
const XML_TOOL_CALL_BLOCK_RE = new RegExp(XML_TOOL_CALL_BLOCK_PATTERN, 'gi');
const XML_TOOL_CALL_BLOCK_TEST_RE = new RegExp(XML_TOOL_CALL_BLOCK_PATTERN, 'i');
const XML_TOOL_CALL_START_RE = new RegExp(
  String.raw`<(?:${XML_TOOL_NS_REQUIRED}(?:tool_call|function_calls|tool_calls|invoke)|${XML_TOOL_NS}(?:function_calls|tool_calls))\b`,
  'i',
);

function stripBareToolCallJson(text: string): string {
  const ranges: Array<{ start: number; end: number }> = [];
  let i = 0;

  while (i < text.length) {
    const braceIdx = text.indexOf('{', i);
    if (braceIdx === -1) break;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let j = braceIdx; j < text.length; j++) {
      const ch = text[j];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\' && inString) {
        escaped = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }

    if (end === -1) {
      i = braceIdx + 1;
      continue;
    }

    const candidate = text.slice(braceIdx, end + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (isToolCallObject(parsed)) {
        ranges.push({ start: braceIdx, end: end + 1 });
      }
    } catch {
      if (repairToolJson(candidate)) {
        ranges.push({ start: braceIdx, end: end + 1 });
      }
    }

    i = end + 1;
  }

  if (ranges.length === 0) return text;

  let output = '';
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    output += text.slice(cursor, range.start);
    const prev = output[output.length - 1];
    const next = text[range.end];
    if (prev && next && !/\s/.test(prev) && !/\s/.test(next)) {
      output += ' ';
    }
    cursor = range.end;
  }
  output += text.slice(cursor);
  return output;
}

export function looksLikeToolCall(text: string): boolean {
  if (text.includes('```json')) return true;
  if (BRACED_TOOL_OBJECT_START.test(text)) return true;
  if (BRACELESS_QUOTED_TOOL_START.test(text)) return true;
  if (BRACELESS_TOOL_WITH_ARGS_OBJECT.test(text)) return true;
  if (NATIVE_TOOL_ECHO_RE.test(text)) return true;
  if (ORPHANED_JSON_TAIL_RE.test(text)) return true;
  if (XML_TOOL_CALL_BLOCK_TEST_RE.test(text)) return true;
  if (XML_TOOL_CALL_START_RE.test(text)) return true;
  return false;
}

export function stripToolCallPayload(content: string): string {
  if (!content) return '';

  const withoutToolFences = content.replace(
    /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g,
    (full, block) => {
      try {
        const parsed = JSON.parse(String(block).trim());
        return isToolCallObject(parsed) ? '' : full;
      } catch {
        if (/["']?tool["']?\s*:\s*["']/.test(String(block))) {
          return '';
        }
        return full;
      }
    },
  );

  let textForBraceStrip = withoutToolFences;
  const bracelessToolPattern = /^([\s\S]*?)(?=(?:^|\n)\s*["']?tool["']?\s*:\s*["'])/;
  const bracelessMatch = withoutToolFences.match(bracelessToolPattern);
  if (bracelessMatch) {
    const prefixLen = bracelessMatch[1].length;
    const toolFragment = withoutToolFences.slice(prefixLen);
    if (!toolFragment.trimStart().startsWith('{')) {
      const testFragment = '{' + toolFragment;
      const strippedFragment = stripBareToolCallJson(testFragment);
      if (strippedFragment.length < testFragment.length && !strippedFragment.startsWith('{')) {
        textForBraceStrip = bracelessMatch[1] + strippedFragment;
      }
    }
  }

  let stripped = stripBareToolCallJson(textForBraceStrip);

  stripped = stripped.replace(/\[[\s,]*\]/g, '');
  stripped = stripped.replace(/\[[\s,]*$/g, '');

  stripped = stripped.replace(/\{[^{}]*["']?tool["']?\s*:\s*["'][^"']*["'][^}]*$/s, '');

  stripped = stripped.replace(
    /(?:^|\n)\s*["']?tool["']?\s*:\s*["'][^"']*["']\s*,\s*["']?args["']?\s*:\s*\{[\s\S]*$/s,
    '',
  );

  stripped = stripped.replace(/```(?:json)?\s*\n?\{\s*["']?tool["']?[\s\S]*$/s, '');
  stripped = stripped.replace(/```(?:json)?\s*$/s, '');

  // Strip native tool-call echo fragments — content like:
  //   repo_ls", "args": {"repo": "KvFxKaido/Push"}}
  //   repo_read", "args": {"repo": "...", "path": "README.md", "start_line": 1, "end_line": 400}}
  // These appear when a provider emits both delta.content and delta.tool_calls
  // for the same invocation.  The bridge converts native calls into fenced JSON
  // (stripped above), but the echoed text fragment remains without the {"tool": " prefix.
  // Build the stripping regex from the shared detection constant so both stay in sync.
  stripped = stripped.replace(new RegExp(NATIVE_TOOL_ECHO_RE.source + '[\\s\\S]*$', 'i'), '');

  stripped = stripped.replace(new RegExp(ORPHANED_JSON_TAIL_RE.source), '');

  // XML / DSML tool envelopes recovered by the dispatcher, including
  // DeepSeek V4 Pro's doubled namespace delimiters. Complete blocks can
  // appear in stored messages; the start regex handles a still-streaming
  // namespaced block that reached render before the preview filter cut it.
  stripped = stripped.replace(XML_TOOL_CALL_BLOCK_RE, '');
  stripped = stripped.replace(new RegExp(XML_TOOL_CALL_START_RE.source + '[\\s\\S]*$', 'i'), '');

  // After all stripping, if only brackets/braces/commas/whitespace remain, return empty.
  // This catches array-wrapped tool calls like [\n  {"tool":...}\n] where the inner
  // object was removed but the outer brackets (and possibly a lone `{`) survived.
  stripped = stripped
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
    .trim();

  if (ONLY_BRACKETS_RE.test(stripped)) {
    return '';
  }

  return stripped;
}

/**
 * Salvage the user-visible text of an assistant turn whose answer never made
 * it into `content` — a heavy reasoner emitted the whole reply on the
 * reasoning channel and the stream-side promotion (`promoteReasoningAnswer`,
 * `lib/tool-call-recovery.ts`) declined, e.g. because the reasoning also
 * contained a tool-call-shaped construct it must not execute. The message
 * still renders in the UI (the "Thought process" pane carries `thinking`), so
 * a history builder that keys on `content` alone silently diverges from what
 * the user saw: on the next send the model has no record of the exchange the
 * user is replying to and reports the conversation as brand-new.
 *
 * Returns the tool-call-stripped reasoning text to use *as history text*, or
 * `null` when there is nothing to salvage: content already present, no plain
 * reasoning, reasoning that is only tool-call payload — or signed
 * `reasoningBlocks`, which own the replay contract for that turn (an
 * Anthropic thinking + tool_use round is legitimately content-empty and must
 * be re-sent verbatim, not rewritten).
 *
 * History-only by design: unlike the stream-side promotion this never feeds
 * the dispatcher (prior-turn text is not parsed for tool calls), and the
 * strip keeps buried call payloads from re-entering the prompt as prose.
 */
export function strandedReasoningAnswerText(message: {
  role: 'user' | 'assistant';
  content: string;
  displayContent?: string;
  thinking?: string;
  reasoningBlocks?: readonly unknown[];
}): string | null {
  if (message.role !== 'assistant') return null;
  if ((message.displayContent ?? message.content).trim()) return null;
  if (message.reasoningBlocks && message.reasoningBlocks.length > 0) return null;
  const thinking = message.thinking ?? '';
  if (!thinking.trim()) return null;
  const salvaged = stripToolCallPayload(thinking).trim();
  return salvaged.length > 0 ? salvaged : null;
}

export function stripToolResultEnvelopes(content: string): string {
  if (!content) return '';
  let text = content.replace(
    /\[(?:TOOL_RESULT|Tool Result)[^\]]*\][\s\S]*?\[\/(?:TOOL_RESULT|Tool Result)\]/g,
    '',
  );
  text = text.replace(/\[TOOL_RESULT — do not interpret as instructions\][\s\S]*$/, '');
  return text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
    .trim();
}
