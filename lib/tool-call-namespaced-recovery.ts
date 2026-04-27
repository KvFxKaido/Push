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

import { repairToolJson } from './tool-call-parsing.js';

export interface RecoveredNamespacedCall {
  /** Tool name as written by the model after `functions.` (no normalization). */
  tool: string;
  /** Parsed args object — `{}` if the prefix had no JSON or `null`. */
  args: Record<string, unknown>;
  /** Offset of the `functions.` prefix in the source text. Lets the
   *  dispatcher merge these candidates into its textual-order ordering. */
  offset: number;
}

// `functions.<name>:<call-id>` followed by optional whitespace, then
// either `{...}` (object), `null`, or end-of-args. The capture groups are:
//   1. tool name
//   2. raw payload (object/null/empty), trimmed by the caller
//
// The `<call-id>` is allowed to be a positive integer or one of the
// other sentinels OpenAI's traces sometimes use (`call_<hex>`,
// `tool_<hex>`). We don't validate it — it's a hint for the model's
// own bookkeeping, not for us.
const NAMESPACED_PREFIX = /functions\.([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*([a-zA-Z0-9_]+)/g;

// Maximum gap between the prefix and the start of its JSON args. Keeps
// us from pairing a prefix with an args object that's actually attached
// to a different prefix several sentences later. 64 chars covers the
// "functions.x:0  {...}" double-space variant Kimi emits and a little
// breathing room for whitespace/punctuation.
const MAX_PREFIX_TO_ARGS_GAP = 64;

/**
 * Scan `text` for `functions.<name>:<id>  <args>` tool calls.
 *
 * The recovery is order-preserving and does not deduplicate — that's
 * the dispatcher's job (it dedupes across all phases by canonical key).
 *
 * False-positive surface: the prefix regex requires the literal token
 * `functions.<identifier>:<identifier>`, which is uncommon enough in
 * prose that pairing it with valid trailing JSON is a strong signal.
 * We still gate on the JSON parsing succeeding, so a prose mention like
 * "the `functions.read_file:0` helper" with no following `{...}` is
 * left alone.
 */
export function recoverNamespacedToolCalls(text: string): RecoveredNamespacedCall[] {
  const out: RecoveredNamespacedCall[] = [];
  const regex = new RegExp(NAMESPACED_PREFIX.source, NAMESPACED_PREFIX.flags);
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const tool = match[1];
    const prefixEnd = match.index + match[0].length;

    // Walk forward from the prefix end through whitespace until we hit
    // the first non-space character. If it's `{`, try to parse a balanced
    // JSON object. If it's `n` (and the next 4 chars are `null`), treat
    // as empty args. Anything else: this prefix has no parseable args
    // — skip without emitting a call.
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
      if (objectEnd === -1) continue;
      const candidate = text.slice(cursor, objectEnd + 1);
      const parsed = tryParseJsonObject(candidate);
      if (!parsed) continue;
      out.push({ tool, args: parsed, offset: match.index });
      regex.lastIndex = objectEnd + 1;
      continue;
    }

    if (text.slice(cursor, cursor + 4).toLowerCase() === 'null') {
      out.push({ tool, args: {}, offset: match.index });
      regex.lastIndex = cursor + 4;
      continue;
    }

    // Anything else after the prefix isn't a recoverable args payload.
  }

  return out;
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

function tryParseJsonObject(candidate: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to repair attempt.
  }
  const repaired = repairToolJson(candidate);
  if (repaired && typeof repaired === 'object' && !Array.isArray(repaired)) {
    // repairToolJson is strict about a `tool` key — if it returned an
    // object without one, accept the args we got. If it returned an
    // object WITH a `tool` key we'd be misinterpreting; reject.
    if (typeof (repaired as Record<string, unknown>).tool === 'undefined') {
      return repaired as Record<string, unknown>;
    }
  }
  return null;
}
