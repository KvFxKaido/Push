/**
 * Recovery for XML-wrapped tool-call output.
 *
 * Some models — particularly Hermes / Qwen / Nous-tuned open-weight
 * finetunes — emit tool calls inside `<tool_call>` XML tags rather than
 * Push's documented fenced-JSON contract. Two shapes show up in the
 * wild:
 *
 *   Shape A (Hermes 2 Pro / Qwen / Nous JSON-inside-tag):
 *     <tool_call>
 *     {"name": "read_file", "arguments": {"path": "TODO.md"}}
 *     </tool_call>
 *
 *   Shape B (param-pair variant captured in the mobile-app bug report
 *   that motivated this module — the model emits the tool name as text
 *   right after the opening tag, then alternating key/value child tags):
 *     <tool_call>read_file
 *     <arg_key>path</arg_key>
 *     <arg_value>TODO.md</arg_value>
 *     </tool_call>
 *
 * Mirrors the role `recoverNamespacedToolCalls` plays for OpenAI-style
 * `functions.<name>:<id> <args>` traces: pair the wrapper with its
 * payload so the shared dispatcher can promote it to a candidate
 * instead of dropping the call silently. Tool-name normalization stays
 * with the dispatcher's source detectors — this module only assembles
 * `{tool, args}` shapes from what the model emitted.
 */

import { applyJsonTextRepairs, escapeRawNewlinesInJsonStrings } from './tool-call-parsing.js';

export interface RecoveredXmlCall {
  /** Tool name as written by the model (no normalization). */
  tool: string;
  /** Parsed args object. `{}` for tag bodies with no recoverable args. */
  args: Record<string, unknown>;
  /** Offset of the opening `<tool_call>` (or `<function_calls>`) tag.
   *  Lets the dispatcher merge these candidates into its textual-order
   *  ordering. For a `<function_calls>` wrapper expanded into multiple
   *  `<invoke>` children, each child carries the offset of its own
   *  `<invoke>` tag, not the wrapper's. */
  offset: number;
  /** Exclusive end offset — one past the last character of the
   *  enclosing tag. For `<tool_call>` blocks this is `</tool_call>` + 1.
   *  For `<invoke>` children expanded from a `<function_calls>` wrapper,
   *  this is `</invoke>` + 1.
   *
   *  Lets callers detect when a bare JSON object found by their own
   *  scanner is actually the args portion of a recovered call —
   *  without that signal, bare-args inference would double-claim the
   *  same intent. */
  endOffset: number;
}

// Shape D — namespace-token-wrapped tags. Some models (DeepSeek-family
// finetunes in particular) emit the Anthropic invoke/parameter shape but
// wrap each tag in a chat-template namespace token, so the call leaks
// into the content stream as literal text like
//   <｜DSML｜tool_calls><｜DSML｜invoke name="web_search">
//     <｜DSML｜parameter name="query">…</｜DSML｜parameter>
//   </｜DSML｜invoke></｜DSML｜tool_calls>
// where the delimiter `｜` is either the ASCII pipe `|` (U+007C) or the
// full-width pipe `｜` (U+FF5C) common in open-weight templates. The
// prefix sits between `<` (or `</`) and the tag name. DeepSeek V4 Pro
// has also emitted the doubled delimiter form (`<｜｜DSML｜｜tool_calls>`).
// We tolerate the prefix *in place* — woven into each tag regex rather
// than stripped in a pre-pass — so recovered offsets stay anchored to
// the original text (the dispatcher merges these against bare-JSON
// candidates by offset). `NS` is optional, so every plain-tag shape
// below keeps matching too.
const NS = String.raw`(?:[|｜]{1,2}[\w.\-]+[|｜]{1,2})?`;

// Match a `<tool_call>` element. The `\b[^>]*` allows attributes the
// model occasionally adds (e.g. `<tool_call id="0">`) — we ignore the
// attribute list. Non-greedy so a sequence of calls in one message each
// resolve to their own tag pair instead of one giant match. `tool_call\b`
// won't match the plural `tool_calls` wrapper (no word boundary between
// `l` and `s`), so the two shapes never collide.
const TOOL_CALL_TAG_REGEX = new RegExp(
  String.raw`<${NS}tool_call\b[^>]*>([\s\S]*?)<\/${NS}tool_call\s*>`,
  'gi',
);

// Anthropic's documented tool-use wrapper. Models trained on the public
// Claude API protocol (and copies of it) emit
//   <function_calls>
//     <invoke name="read">
//       <parameter name="path">/foo</parameter>
//     </invoke>
//   </function_calls>
// for each tool call. `tool_calls` (plural) is accepted as an alias —
// the namespace-wrapped Shape D variant uses it as its wrapper name —
// since both carry `<invoke>` children with identical semantics.
// Distinct from `<tool_call>` (singular, used by Hermes / Qwen / Nous
// finetunes) — captured separately so the per-shape inner parser stays
// focused. A single wrapper can contain multiple `<invoke>` children:
// each becomes its own recovered call.
const FUNCTION_CALLS_TAG_REGEX = new RegExp(
  String.raw`<${NS}(?:function_calls|tool_calls)\b[^>]*>([\s\S]*?)<\/${NS}(?:function_calls|tool_calls)\s*>`,
  'gi',
);

// Inner-block patterns for the Anthropic shape. `name` may use either
// quote style or no quotes; everything inside the attribute set up to
// the closing `>` is ignored so models that add stray attributes
// (`<invoke name="x" id="0">`, or Shape D's `<parameter name="q"
// string="true">`) still match.
const INVOKE_TAG_REGEX = new RegExp(
  String.raw`<${NS}invoke\b[^>]*?\bname\s*=\s*["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/${NS}invoke\s*>`,
  'gi',
);
const PARAMETER_TAG_REGEX = new RegExp(
  String.raw`<${NS}parameter\b[^>]*?\bname\s*=\s*["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/${NS}parameter\s*>`,
  'gi',
);

// `<arg_key>K</arg_key>` followed by `<arg_value>V</arg_value>`. Both
// child tags are required and must appear in order — a stray key
// without a matching value (or vice versa) is dropped, mirroring the
// dispatcher's "drop ambiguous" stance elsewhere.
//
// Key body is `[^<]*?` rather than `[\s\S]*?` on purpose: keys are
// identifiers and shouldn't contain `<`, so disallowing `<` prevents
// the regex from backtracking across a stray orphan close-tag and
// swallowing the next valid pair into a "wider" malformed match.
// Value body is `[\s\S]*?` so JSON-encoded values that happen to
// contain `<` (e.g. `"a < b"`) survive intact.
const ARG_PAIR_REGEX = new RegExp(
  String.raw`<${NS}arg_key\b[^>]*>([^<]*?)<\/${NS}arg_key\s*>\s*<${NS}arg_value\b[^>]*>([\s\S]*?)<\/${NS}arg_value\s*>`,
  'gi',
);

// Conservative identifier shape — matches `recoverNamespacedToolCalls`'
// tool-name capture. Anything outside this is either prose noise or a
// tool name the registry wouldn't accept anyway.
const TOOL_NAME_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const ARG_KEY_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// Eligibility gate for the whole-message context — mirrors
// `isBareBlockEligible` in the dispatcher. The prefix before the first
// `<tool_call>`, every gap between consecutive blocks, and the suffix
// after the last block must each consist only of whitespace and
// optional fence/language markers (after stripping well-formed fenced
// blocks, which are legitimate sibling tool-call output). Without
// this gate, a prose mention like `Do not run <tool_call>exec ...
// </tool_call>` would be promoted to a real exec call by the
// dispatcher's phase-4 fallback. Codex review on PR #558.
const XML_GAP_REGEX =
  /^\s*(?:`{3,}|~{3,})?\s*(?:json[c5]?|tool|xml|javascript)?\s*(?:`{3,}|~{3,})?\s*$/i;

// Strip well-formed fenced regions (` ``` … ``` ` / `~~~ … ~~~`) and
// namespaced `functions.<name>:<id> {…}` traces so legitimate sibling
// tool-call output doesn't trip the prose gate. Without this, mixed
// emissions (canonical-fenced + XML, or namespaced + XML) would
// reject the XML recovery as prose-bounded. The namespaced strip is
// approximate (a JSON string value containing `}` could close the
// match early) but only matters for the gap check — actual recovery
// is unaffected, and the false-negative side rejects rather than
// over-accepts.
const FENCED_BLOCK_REGEX = /(?:`{3,}|~{3,})[\s\S]*?(?:`{3,}|~{3,})/g;
const NAMESPACED_TRACE_REGEX = /functions\.[a-zA-Z_]\w*\s*:\s*\w+(?:\s*(?:\{[\s\S]*?\}|null))?/g;
function stripSiblingToolCallShapes(text: string): string {
  return text.replace(FENCED_BLOCK_REGEX, '').replace(NAMESPACED_TRACE_REGEX, '');
}

const MAX_ASSISTANT_PREAMBLE_CHARS = 320;
const ACTION_PREAMBLE_REGEX =
  /^(?:let me|i(?:'|’)?ll|i will|i(?:'|’)?m going to|i am going to|i(?:'|’)?m checking|i am checking|checking|fetching|pulling|looking up|reading|opening|searching)\b/i;
const PASTED_EXAMPLE_PREAMBLE_REGEX =
  /\b(?:do not|don't|dont|skip|ignore|example|for example|earlier|previously|literal|verbatim|documentation|docs?)\b/i;

function isAssistantToolPreamble(slice: string): boolean {
  const stripped = stripSiblingToolCallShapes(slice).trim();
  if (!stripped || stripped.length > MAX_ASSISTANT_PREAMBLE_CHARS) return false;
  if (stripped.includes('<') || stripped.includes('>')) return false;
  if (PASTED_EXAMPLE_PREAMBLE_REGEX.test(stripped)) return false;
  return ACTION_PREAMBLE_REGEX.test(stripped);
}

/**
 * Scan `text` for `<tool_call>...</tool_call>` blocks and assemble a
 * `{tool, args}` shape for each. Order-preserving, no dedup — the
 * dispatcher handles dedup across all phases by canonical key.
 *
 * Returns an empty array if `text` has no `<tool_call>` tags or none
 * of them carry a recoverable payload. Tag pairs whose body parses
 * cleanly via one shape AND yields an empty args record under the
 * other are accepted — empty args are valid for tools like
 * `git_status` that take no arguments.
 */
export function recoverXmlToolCalls(text: string): RecoveredXmlCall[] {
  // Collect blocks from both wrapper shapes — `<tool_call>` (Hermes
  // family) and `<function_calls>` (Anthropic format) — into one
  // sorted array so the eligibility gate considers all of them as
  // siblings. A model that mixes shapes in one message still passes
  // the gate; gaps between blocks need to be whitespace regardless of
  // which wrapper sits on either side.
  const matches: Array<{
    kind: 'tool_call' | 'function_calls' | 'invoke';
    blockStart: number;
    blockEnd: number;
    /**
     * Absolute offset (in the outer `text`) at which the captured
     * inner content begins — i.e., one past the close of the opening
     * tag. `match[1]` is the capture group; `innerStart` is where
     * that capture begins in the source. Used by `function_calls`
     * expansion to re-anchor invoke child offsets correctly. For
     * `tool_call` matches we don't currently re-anchor (the outer
     * `[blockStart, blockEnd)` is the call's region), but the field
     * is populated uniformly for both kinds.
     */
    innerStart: number;
    inner: string;
  }> = [];
  // Helper: the regex shapes use `[^>]*` for the opening tag's
  // attribute set, so the FIRST `>` after `match.index` always closes
  // the opening tag — no `>`-containing string values to confuse it.
  const findInnerStart = (m: RegExpExecArray): number => {
    const closeIdx = text.indexOf('>', m.index);
    return closeIdx === -1 ? m.index + m[0].length : closeIdx + 1;
  };
  const toolCallRegex = new RegExp(TOOL_CALL_TAG_REGEX.source, TOOL_CALL_TAG_REGEX.flags);
  let match: RegExpExecArray | null;
  while ((match = toolCallRegex.exec(text)) !== null) {
    matches.push({
      kind: 'tool_call',
      blockStart: match.index,
      blockEnd: match.index + match[0].length,
      innerStart: findInnerStart(match),
      inner: match[1],
    });
  }
  const functionCallsRegex = new RegExp(
    FUNCTION_CALLS_TAG_REGEX.source,
    FUNCTION_CALLS_TAG_REGEX.flags,
  );
  while ((match = functionCallsRegex.exec(text)) !== null) {
    matches.push({
      kind: 'function_calls',
      blockStart: match.index,
      blockEnd: match.index + match[0].length,
      innerStart: findInnerStart(match),
      inner: match[1],
    });
  }

  // Shape E — standalone `<invoke>` elements with no `<function_calls>` /
  // `<tool_calls>` wrapper. Some models (x-ai/grok-code-fast-1 observed in
  // the wild) emit the Anthropic invoke/parameter shape but omit the outer
  // wrapper, so a single call leaks into the content stream as
  //   <invoke name="search"><parameter name="query">…</parameter></invoke>
  // which matches neither the `<tool_call>` regex nor the wrapper regex
  // above and therefore fell through entirely. We scan for `<invoke>`
  // elements at the top level and keep only those that fall OUTSIDE every
  // wrapper block already collected — an invoke that belongs to a
  // function_calls/tool_calls wrapper is expanded by that wrapper's path
  // and must not be double-counted here. The whole-element text is stored
  // as `inner` (with `innerStart` anchored to its start) so the expansion
  // pass below can route it through the same `parseFunctionCallsInner`
  // logic as a wrapped invoke.
  const wrapperRanges = matches.map((m) => [m.blockStart, m.blockEnd] as const);
  const invokeRegex = new RegExp(INVOKE_TAG_REGEX.source, INVOKE_TAG_REGEX.flags);
  while ((match = invokeRegex.exec(text)) !== null) {
    const start = match.index;
    if (wrapperRanges.some(([s, e]) => start >= s && start < e)) continue;
    matches.push({
      kind: 'invoke',
      blockStart: start,
      blockEnd: start + match[0].length,
      innerStart: start,
      inner: match[0],
    });
  }

  matches.sort((a, b) => a.blockStart - b.blockStart);

  // Drop matches that nest inside an earlier (outer) wrapper. This
  // happens when a `<function_calls>...</function_calls>` literal lives
  // inside the args payload of a `<tool_call>` — e.g., documentation
  // strings or example content in an `edit_file` arg. Without this
  // pass, the nested match would slip into the sorted `matches` array,
  // its `blockEnd` would terminate inside the outer wrapper, and the
  // suffix gap check would then read the outer `</tool_call>` text as
  // prose and reject the WHOLE batch — dropping the otherwise-valid
  // outer call that worked before this commit. Codex P1 review on
  // PR #600. The outer wrapper is the real call; the inner string is
  // just content. Sort order guarantees the outer match arrives
  // first, so a simple running `lastEnd` watermark catches every
  // nested case.
  const deduped: typeof matches = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.blockStart < lastEnd) continue;
    deduped.push(m);
    lastEnd = m.blockEnd;
  }
  matches.length = 0;
  matches.push(...deduped);
  if (matches.length === 0) return [];

  // Whole-message eligibility gate — see `XML_GAP_REGEX`. Reject the
  // entire recovery batch if any non-block region contains prose
  // (after stripping well-formed fenced regions, which are legitimate
  // sibling tool-call output). The false-negative trade (a model that
  // legitimately mixes a tool call with continuing prose afterwards
  // is skipped) matches the same trade `hasRecoverableTrailingContext`
  // makes in the namespaced recovery: a missed call resolves on the
  // next turn, a false-positive `<tool_call>exec ...</tool_call>`
  // that executes does not.
  const isAllowedGap = (slice: string): boolean =>
    XML_GAP_REGEX.test(stripSiblingToolCallShapes(slice));
  const leadingGap = text.slice(0, matches[0].blockStart);
  if (!isAllowedGap(leadingGap)) {
    // Models sometimes emit a short action preamble, then the actual
    // Anthropic-style call batch as the final artifact:
    //
    //   Let me check that.
    //
    //   <｜｜DSML｜｜tool_calls>...</｜｜DSML｜｜tool_calls>
    //
    // Keep the broad prose guard for plain `<tool_call>` and standalone
    // `<invoke>` shapes; only the wrapped batch format gets this narrow
    // terminal-preamble tolerance.
    const onlyWrappedBatches = matches.every((m) => m.kind === 'function_calls');
    if (!onlyWrappedBatches || !isAssistantToolPreamble(leadingGap)) return [];
  }
  for (let i = 1; i < matches.length; i++) {
    if (!isAllowedGap(text.slice(matches[i - 1].blockEnd, matches[i].blockStart))) return [];
  }
  if (!isAllowedGap(text.slice(matches[matches.length - 1].blockEnd))) return [];

  const out: RecoveredXmlCall[] = [];
  for (const m of matches) {
    if (m.kind === 'tool_call') {
      const parsed = parseToolCallInner(m.inner);
      if (!parsed) continue;
      out.push({ ...parsed, offset: m.blockStart, endOffset: m.blockEnd });
      continue;
    }
    // `<function_calls>` wrapper (or a standalone `<invoke>`, Shape E) —
    // expand each `<invoke>` child into its own recovered call. Re-anchor
    // each invoke's offsets to the outer text by adding `m.innerStart`
    // (where `m.inner` begins), NOT `m.blockStart` — for the wrapper case
    // the latter would undercount by the opening tag's length and shift
    // recovery regions backward, which lets the legacy bare-object skip
    // miss objects inside the recovered invoke (Copilot review on PR #683).
    // For the standalone `invoke` kind `m.inner` is the whole element and
    // `m.innerStart === m.blockStart`, so the single child resolves back
    // to its own `<invoke>` offset.
    for (const invoke of parseFunctionCallsInner(m.inner)) {
      out.push({
        tool: invoke.tool,
        args: invoke.args,
        offset: m.innerStart + invoke.innerOffset,
        endOffset: m.innerStart + invoke.innerEnd,
      });
    }
  }
  return out;
}

function parseToolCallInner(inner: string): { tool: string; args: Record<string, unknown> } | null {
  const trimmed = inner.trim();
  if (!trimmed) return null;

  // Shape A: the body is a JSON object (Hermes / Qwen).
  if (trimmed.startsWith('{')) {
    const parsedJson = parseJsonShape(trimmed);
    if (parsedJson) return parsedJson;
    // Fall through — a malformed JSON body is unlikely to also parse
    // as Shape B, but we attempt it for robustness rather than
    // returning null mid-way.
  }

  return parseArgPairShape(trimmed);
}

function parseJsonShape(text: string): { tool: string; args: Record<string, unknown> } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const repaired = applyJsonTextRepairs(text);
    try {
      parsed = JSON.parse(repaired);
    } catch {
      const escaped = escapeRawNewlinesInJsonStrings(repaired);
      if (escaped === repaired) return null;
      try {
        parsed = JSON.parse(escaped);
      } catch {
        return null;
      }
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  // Accept both Hermes (`{name, arguments}`) and Push canonical
  // (`{tool, args}`) shapes — different finetunes pick different
  // keys for the same intent.
  const tool =
    typeof obj.name === 'string' && obj.name.trim().length > 0
      ? obj.name.trim()
      : typeof obj.tool === 'string' && obj.tool.trim().length > 0
        ? obj.tool.trim()
        : null;
  if (!tool || !TOOL_NAME_REGEX.test(tool)) return null;
  const argsRaw = obj.arguments ?? obj.args ?? {};
  if (!argsRaw || typeof argsRaw !== 'object' || Array.isArray(argsRaw)) return null;
  return { tool, args: argsRaw as Record<string, unknown> };
}

function parseArgPairShape(text: string): { tool: string; args: Record<string, unknown> } | null {
  // The tool name is the first non-tag token in the body — everything
  // up to the first `<` (or end of string if there are no child tags).
  const firstTagIdx = text.indexOf('<');
  const head = (firstTagIdx === -1 ? text : text.slice(0, firstTagIdx)).trim();
  if (!head || !TOOL_NAME_REGEX.test(head)) return null;

  const args: Record<string, unknown> = {};
  const pairRegex = new RegExp(ARG_PAIR_REGEX.source, ARG_PAIR_REGEX.flags);
  let m: RegExpExecArray | null;
  while ((m = pairRegex.exec(text)) !== null) {
    const key = m[1].trim();
    if (!key || !ARG_KEY_REGEX.test(key)) continue;
    args[key] = coerceArgValue(m[2].trim());
  }
  return { tool: head, args };
}

/**
 * Best-effort coercion for an `<arg_value>` body. JSON.parse handles
 * numbers, booleans, `null`, quoted strings, arrays, and nested
 * objects; anything that fails to parse is treated as a raw string
 * (the common case for bare identifiers like `KvFxKaido/Push`).
 */
function coerceArgValue(raw: string): unknown {
  if (raw === '') return '';
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Expand the inner content of a `<function_calls>` wrapper into one
 * recovered call per `<invoke>` child. Returns `innerOffset` so the
 * caller can re-anchor to the outer text.
 *
 * The hybrid case (a `<function_calls>` wrapper containing bare JSON
 * like `{"tool": "...", "args": {...}}` instead of `<invoke>` children)
 * is intentionally NOT handled here — the dispatcher's bare-JSON scan
 * already finds those candidates via `extractBareToolJsonObjects` and
 * the dropped-candidates surface (PR #599) reports them as parse
 * errors when no source claims the inner `tool` value. Letting this
 * helper also emit them would either duplicate the call or pre-empt
 * the diagnosis.
 */
function parseFunctionCallsInner(inner: string): Array<{
  tool: string;
  args: Record<string, unknown>;
  innerOffset: number;
  innerEnd: number;
}> {
  const out: Array<{
    tool: string;
    args: Record<string, unknown>;
    innerOffset: number;
    innerEnd: number;
  }> = [];
  const invokeRegex = new RegExp(INVOKE_TAG_REGEX.source, INVOKE_TAG_REGEX.flags);
  let invoke: RegExpExecArray | null;
  while ((invoke = invokeRegex.exec(inner)) !== null) {
    const toolName = invoke[1].trim();
    if (!toolName || !TOOL_NAME_REGEX.test(toolName)) continue;
    const args: Record<string, unknown> = {};
    const paramRegex = new RegExp(PARAMETER_TAG_REGEX.source, PARAMETER_TAG_REGEX.flags);
    let param: RegExpExecArray | null;
    while ((param = paramRegex.exec(invoke[2])) !== null) {
      const key = param[1].trim();
      if (!key || !ARG_KEY_REGEX.test(key)) continue;
      args[key] = coerceArgValue(param[2].trim());
    }
    out.push({
      tool: toolName,
      args,
      innerOffset: invoke.index,
      innerEnd: invoke.index + invoke[0].length,
    });
  }
  return out;
}
