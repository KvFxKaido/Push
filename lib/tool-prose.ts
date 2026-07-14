import { repairToolJson } from './tool-call-parsing.js';

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
const NATIVE_TOOL_ECHO_RE = /(?:^|\n)\s*[a-z_]\w*["']\s*,\s*["'][a-z_]+["']\s*:/i;
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
      if (ch === '}' && --depth === 0) {
        end = j;
        break;
      }
    }
    if (end === -1) {
      i = braceIdx + 1;
      continue;
    }
    const candidate = text.slice(braceIdx, end + 1);
    try {
      if (isToolCallObject(JSON.parse(candidate))) ranges.push({ start: braceIdx, end: end + 1 });
    } catch {
      if (repairToolJson(candidate)) ranges.push({ start: braceIdx, end: end + 1 });
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
    if (prev && next && !/\s/.test(prev) && !/\s/.test(next)) output += ' ';
    cursor = range.end;
  }
  return output + text.slice(cursor);
}

export function looksLikeToolCall(text: string): boolean {
  return (
    text.includes('```json') ||
    BRACED_TOOL_OBJECT_START.test(text) ||
    BRACELESS_QUOTED_TOOL_START.test(text) ||
    BRACELESS_TOOL_WITH_ARGS_OBJECT.test(text) ||
    NATIVE_TOOL_ECHO_RE.test(text) ||
    ORPHANED_JSON_TAIL_RE.test(text) ||
    XML_TOOL_CALL_BLOCK_TEST_RE.test(text) ||
    XML_TOOL_CALL_START_RE.test(text)
  );
}

/** Remove model-facing tool-call syntax while retaining its prose prefix. */
export function stripToolCallPayload(content: string): string {
  if (!content) return '';
  const withoutToolFences = content.replace(
    /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g,
    (full, block) => {
      try {
        return isToolCallObject(JSON.parse(String(block).trim())) ? '' : full;
      } catch {
        return /["']?tool["']?\s*:\s*["']/.test(String(block)) ? '' : full;
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
  stripped = stripped.replace(new RegExp(NATIVE_TOOL_ECHO_RE.source + '[\\s\\S]*$', 'i'), '');
  stripped = stripped.replace(new RegExp(ORPHANED_JSON_TAIL_RE.source), '');
  stripped = stripped.replace(XML_TOOL_CALL_BLOCK_RE, '');
  stripped = stripped.replace(new RegExp(XML_TOOL_CALL_START_RE.source + '[\\s\\S]*$', 'i'), '');
  stripped = stripped
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
    .trim();
  return ONLY_BRACKETS_RE.test(stripped) ? '' : stripped;
}

/**
 * Split an accumulated provider round at the first structural tool-call
 * construct. The untouched text still goes to the kernel; this projection is
 * only for user-visible streaming and settled narration.
 */
export function splitVisibleContent(text: string): { visible: string; toolCallActive: boolean } {
  let cut = -1;
  const mark = (idx: number) => {
    if (idx >= 0 && (cut === -1 || idx < cut)) cut = idx;
  };
  const fencedTool = /```[^\n`]*\r?\n[ \t]*\[?\s*\{\s*['"]?tool['"]?\s*:/.exec(text);
  if (fencedTool) mark(fencedTool.index);
  const bareTool = /\[?\s*\{\s*['"]?tool['"]?\s*:/.exec(text);
  if (bareTool) mark(bareTool.index);
  const xmlBlock = new RegExp(XML_TOOL_CALL_BLOCK_PATTERN, 'i').exec(text);
  if (xmlBlock) mark(xmlBlock.index);
  const xmlTool = XML_TOOL_CALL_START_RE.exec(text);
  if (xmlTool) mark(xmlTool.index);
  if (((text.match(/```/g) ?? []).length & 1) === 1) mark(text.lastIndexOf('```'));
  if (cut === -1) return { visible: text, toolCallActive: false };
  return { visible: text.slice(0, cut).replace(/\s+$/, ''), toolCallActive: true };
}

/** Settled narration for a round that contains at least one executable tool call. */
export function extractToolProse(content: string): string {
  return stripToolCallPayload(splitVisibleContent(content).visible);
}
