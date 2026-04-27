/**
 * Recovery for OpenAI-style namespaced tool-call output.
 *
 * Some models — most reliably the Moonshot/Kimi family routed through
 * Blackbox, but anything trained on OpenAI's function-call reasoning
 * traces — emit tool calls in `functions.<name>:<id>  <json-args>` form
 * instead of Push's documented fenced-JSON contract:
 *
 *   functions.read_file:0  {"path": "TODO.md"}
 *   functions.git_status:2  {}
 *
 * The shared dispatcher's fenced-block phase ignores this (no fence) and
 * its bare-object phase ignores it too (the JSON args object has no
 * `"tool"` key, and even if it did the prefix sits ahead of it). Result:
 * the run completes "successfully" with zero tool executions and the user
 * sees only the assistant's prose claim that it's "checking" something.
 *
 * This module pairs the prefix with its trailing args object so the
 * dispatcher can recover those calls instead of dropping them silently.
 * Tool-name normalization is intentionally left to the dispatcher's
 * source detectors — this module only assembles `{tool, args}` shapes
 * from what the model emitted.
 */

import { applyJsonTextRepairs, escapeRawNewlinesInJsonStrings } from './tool-call-parsing.js';

export interface RecoveredNamespacedCall {
  /** Tool name as written by the model after `functions.` (no normalization). */
  tool: string;
  /** Parsed args object — `{}` when the prefix is followed by literal `null`. */
  args: Record<string, unknown>;
  /** Offset of the `functions.` prefix in the source text. Lets the
   *  dispatcher merge these candidates into its textual-order ordering. */
  offset: number;
}

// Captures the tool name from `functions.<name>:<call-id>`. The call-id
// is intentionally not captured — OpenAI's traces use it for the model's
// own bookkeeping (positive integer or `call_<hex>` / `tool_<hex>`
// sentinel) and we don't need its value for recovery.
const NAMESPACED_PREFIX = /functions\.([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*[a-zA-Z0-9_]+/g;

// Maximum whitespace gap between the prefix and the start of its JSON
// args. Keeps us from pairing a prefix with an args object that's
// actually attached to a different prefix several sentences later.
// 64 chars covers the "functions.x:0  {...}" double-space variant Kimi
// emits with comfortable headroom.
const MAX_PREFIX_TO_ARGS_GAP = 64;

/**
 * Scan `text` for `functions.<name>:<id>  <args>` tool calls.
 *
 * The recovery is order-preserving and does not deduplicate — that's
 * the dispatcher's job (it dedupes across all phases by canonical key).
 *
 * False-positive surface: prose can incidentally contain
 * `functions.foo:0` followed by a JSON-looking object (a documentation
 * example, a quoted error message). To keep recovery from amplifying
 * those into real tool executions we apply a trailing-context gate —
 * see `hasRecoverableTrailingContext`. Briefly: a recovered call's
 * args object must be followed by whitespace and then either another
 * `functions.` prefix or end-of-message, matching how models actually
 * structure their function-call output.
 */
export function recoverNamespacedToolCalls(text: string): RecoveredNamespacedCall[] {
  const out: RecoveredNamespacedCall[] = [];
  const regex = new RegExp(NAMESPACED_PREFIX.source, NAMESPACED_PREFIX.flags);
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const tool = match[1];
    const prefixEnd = match.index + match[0].length;

    // Walk forward from the prefix end through whitespace until we hit
    // the first non-whitespace character. If it's `{`, try to parse a
    // balanced JSON object. If it's `n` (and the next 4 chars are
    // `null`), treat as empty args. Anything else: this prefix has no
    // parseable args — skip without emitting a call.
    let cursor = prefixEnd;
    while (cursor < text.length && cursor - prefixEnd <= MAX_PREFIX_TO_ARGS_GAP) {
      const ch = text[cursor];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        cursor++;
        continue;
      }
      break;
    }

    if (cursor - prefixEnd > MAX_PREFIX_TO_ARGS_GAP) continue;
    if (cursor >= text.length) continue;

    if (text[cursor] === '{') {
      const objectEnd = findBalancedObjectEnd(text, cursor);
      if (objectEnd === -1) {
        // Truncated args object — the stream ended (or was malformed)
        // before the closing brace. Auto-close gates (see
        // `tryParseTruncatedArgs`) reject anything that ended inside
        // an open string at EOF, which closes the false-positive
        // surface the trailing-context check protects on the
        // non-truncated path. (Codex review on PR #423.)
        //
        // Also skip when another `functions.*` prefix appears (outside
        // string literals) inside the truncation tail: that means the
        // model emitted a second call before finishing the first, and
        // sweeping the second prefix into a misshapen first object
        // would misinterpret two calls as one mangled one. Better to
        // drop the broken first and let the regex iteration recover
        // the clean second.
        if (containsNamespacedPrefixOutsideStrings(text, cursor + 1)) continue;
        const parsed = tryParseTruncatedArgs(text.slice(cursor));
        if (!parsed) continue;
        out.push({ tool, args: parsed, offset: match.index });
        // Truncation always extends to end-of-message, so there's
        // nothing left for further regex iterations to find.
        break;
      }
      if (!hasRecoverableTrailingContext(text, objectEnd + 1)) continue;
      const candidate = text.slice(cursor, objectEnd + 1);
      const parsed = tryParseArgsObject(candidate);
      if (!parsed) continue;
      out.push({ tool, args: parsed, offset: match.index });
      regex.lastIndex = objectEnd + 1;
      continue;
    }

    if (text.slice(cursor, cursor + 4).toLowerCase() === 'null') {
      const nullEnd = cursor + 4;
      if (!hasRecoverableTrailingContext(text, nullEnd)) continue;
      out.push({ tool, args: {}, offset: match.index });
      regex.lastIndex = nullEnd;
      continue;
    }

    // Anything else after the prefix isn't a recoverable args payload.
  }

  return out;
}

/**
 * Codex review feedback (P1): without this gate, a single prose
 * sentence like `Note: ignore functions.exec:0 {"command":"rm -rf /"}
 * mention` would recover as a real `exec` call. Real model output
 * follows its `functions.*` calls with either another `functions.*`
 * prefix (batched calls) or trailing whitespace until end-of-message;
 * prose mentions usually continue speaking after the JSON. Restricting
 * recovery to those well-formed shapes preserves the recovery for the
 * Kimi/Blackbox case while preventing prose-induced false positives.
 *
 * False-negative trade: a model that legitimately mixes a tool call
 * with continuing prose afterwards will be skipped. The Push prompt
 * already tells models not to do this (`"Do not describe tool calls in
 * prose. Emit only JSON blocks for tool calls."`), and a missed call
 * resolves on the next turn — a false positive that runs `rm -rf` does
 * not.
 */
function hasRecoverableTrailingContext(text: string, after: number): boolean {
  let cursor = after;
  while (cursor < text.length) {
    const ch = text[cursor];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      cursor++;
      continue;
    }
    break;
  }
  if (cursor >= text.length) return true;
  // Peek ahead just far enough to see another `functions.<identifier>`
  // prefix start. 16 chars is well past any realistic call-id length.
  return /^functions\.[a-zA-Z_]/.test(text.slice(cursor, cursor + 16));
}

/**
 * Brace-counted scan from `start` (which must point at `{`) to the
 * matching `}`. Mirrors the same logic the bare-object scanner uses
 * but inlined here so this module has no dependency on the dispatcher.
 *
 * Returns the index of the closing brace, or -1 if no matched closer
 * exists within the string.
 */
function findBalancedObjectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let j = start; j < text.length; j++) {
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
      if (depth === 0) return j;
    }
  }
  return -1;
}

/**
 * Parse a balanced candidate args object. Rejects any object that
 * contains a `"tool"` key — those are ambiguous (was the model trying
 * to emit a canonical wrapper inside a namespaced trace?) and the
 * dispatcher's canonical phases would have already picked them up if
 * they were valid invocations. Better to drop than misinterpret.
 *
 * Repair is shape-agnostic — `applyJsonTextRepairs` handles trailing
 * commas, single quotes, unquoted keys, Python `True`/`False`/`None`,
 * and stray control characters; the newline-escape fallback handles
 * raw newlines inside string values. Same primitives the canonical
 * paths use, just without the `"tool"`-key gating that's wrong here.
 *
 * Auto-close for truncation is handled separately in
 * `tryParseTruncatedArgs`, not here, because the gates differ: this
 * function only sees text that already balanced through
 * `findBalancedObjectEnd`, so an auto-close phase here would be dead.
 */
function tryParseArgsObject(candidate: string): Record<string, unknown> | null {
  try {
    return acceptArgsObject(JSON.parse(candidate));
  } catch {
    // Fall through to repair attempts.
  }
  const repairedText = applyJsonTextRepairs(candidate);
  try {
    return acceptArgsObject(JSON.parse(repairedText));
  } catch {
    // Continue to newline-escape phase.
  }
  const newlineEscaped = escapeRawNewlinesInJsonStrings(repairedText);
  if (newlineEscaped === repairedText) return null;
  try {
    return acceptArgsObject(JSON.parse(newlineEscaped));
  } catch {
    return null;
  }
}

/**
 * Parse an unbalanced (truncated) args object that starts at the
 * leading `{` of the slice. Walks the slice with string-awareness to
 * count unmatched braces/brackets, then auto-closes if the depth is
 * recoverable.
 *
 * Codex P1 review on PR #423: rejects any slice that ends inside an
 * open string literal. That's the case where the model was mid-value
 * when truncation hit (or, more dangerously, where the model emitted
 * an unclosed string that ran into prose continuing afterwards).
 * Auto-closing in that state would either fabricate a value or sweep
 * arbitrary prose into an args field, both of which produce
 * false-positive tool executions. The cost is that we drop the rare
 * "stream cut cleanly mid-string" recovery — acceptable trade vs the
 * rm-rf-shape risk on the other side.
 *
 * Depth cap of ≤ 3 unmatched openers mirrors `tryAutoCloseJson` in
 * `lib/tool-call-parsing.ts`; deeper truncation usually means
 * something more serious is wrong with the output.
 */
function tryParseTruncatedArgs(slice: string): Record<string, unknown> | null {
  if (!slice.startsWith('{')) return null;
  const scan = scanForBraceClosure(slice);
  if (scan.inStringAtEnd) return null;
  if (scan.stack.length === 0 || scan.stack.length > 3) return null;
  let suffix = '';
  for (let i = scan.stack.length - 1; i >= 0; i--) {
    suffix += scan.stack[i] === '{' ? '}' : ']';
  }
  return tryParseArgsObject(slice + suffix);
}

function acceptArgsObject(parsed: unknown): Record<string, unknown> | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (typeof (parsed as Record<string, unknown>).tool !== 'undefined') return null;
  return parsed as Record<string, unknown>;
}

interface BraceScanResult {
  /** Unmatched openers in nesting order. */
  stack: ('{' | '[')[];
  /** True when the scan ended while still inside a `"..."` string. */
  inStringAtEnd: boolean;
}

/**
 * Walk `text` and report unmatched JSON openers + open-string state
 * at end-of-text. Shared by truncation auto-close and the
 * outside-strings prefix scanner so both reason about JSON structure
 * with identical escape/string semantics.
 */
function scanForBraceClosure(text: string): BraceScanResult {
  const stack: ('{' | '[')[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of text) {
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
    if (ch === '{') stack.push('{');
    if (ch === '[') stack.push('[');
    if (ch === '}' && stack.length && stack[stack.length - 1] === '{') stack.pop();
    if (ch === ']' && stack.length && stack[stack.length - 1] === '[') stack.pop();
  }
  return { stack, inStringAtEnd: inString };
}

const NAMESPACED_PREFIX_NON_GLOBAL = new RegExp(NAMESPACED_PREFIX.source);

/**
 * Returns true if `text` contains a `functions.<name>:<id>` prefix
 * starting at or after `from`, ignoring matches that fall inside a
 * JSON string literal. Without the string-awareness (Copilot review
 * on PR #423) a legitimate args object containing a literal like
 * `"functions.foo:0"` in a string value would falsely suppress
 * truncation recovery for an otherwise-clean call.
 */
function containsNamespacedPrefixOutsideStrings(text: string, from: number): boolean {
  let inString = false;
  let escaped = false;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
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
    if (ch !== 'f') continue;
    if (text.startsWith('functions.', i) && NAMESPACED_PREFIX_NON_GLOBAL.test(text.slice(i))) {
      return true;
    }
  }
  return false;
}
