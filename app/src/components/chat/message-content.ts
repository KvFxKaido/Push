import { repairToolJson } from '@/lib/utils';

function isToolCallObject(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.tool === 'string';
}

const BRACED_TOOL_OBJECT_START = /\{\s*["']?tool["']?\s*:\s*(?:["'][^"'\n]*["']|[^,\n{}]+)/s;
const BRACELESS_QUOTED_TOOL_START = /(?:^|\n)\s*["']tool["']\s*:\s*["'][^"'\n]*["']/s;
const BRACELESS_TOOL_WITH_ARGS_OBJECT = /(?:^|\n)\s*["']?tool["']?\s*:\s*["'][^"'\n]*["']\s*,\s*["']?args["']?\s*:\s*\{/s;

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

  // After all stripping, if only brackets/braces/commas/whitespace remain, return empty.
  // This catches array-wrapped tool calls like [\n  {"tool":...}\n] where the inner
  // object was removed but the outer brackets (and possibly a lone `{`) survived.
  stripped = stripped
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
    .trim();

  if (/^[[{}\],\s]*$/.test(stripped)) {
    return '';
  }

  return stripped;
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
