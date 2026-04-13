/**
 * Tool-call diagnosis — post-hoc analysis of assistant output that looks
 * like a failed tool-call attempt. This module runs *after* the main
 * detectors return null and produces an actionable `ToolCallDiagnosis`
 * that the caller can surface back to the model as a retry hint, or null
 * if the text is genuinely not a tool-call attempt.
 *
 * Extracted from `app/src/lib/tool-dispatch.ts` so the diagnosis helpers
 * live outside the Web-coupled dispatch module. The Web shim in
 * `app/src/lib/tool-dispatch.ts` re-exports every symbol from here so
 * existing call sites (orchestrator, explorer-agent, deep-reviewer-agent,
 * tool-call-recovery) keep their existing imports unchanged.
 */

import { classifyIntent } from './intent-classifier.js';
import { asRecord } from './stream-utils.js';
import {
  detectToolFromText,
  diagnoseJsonSyntaxError,
  extractBareToolJsonObjects,
  repairToolJson,
  detectTruncatedToolCall,
} from './tool-call-parsing.js';
import {
  escapeToolNameForRegex,
  getRecognizedToolNames,
  getToolArgHint,
  getToolPublicName,
  getToolPublicNames,
  getToolSourceFromName,
  isReadOnlyToolName,
  KNOWN_PUBLIC_TOOL_NAMES,
  resolveToolName,
  type ToolRegistrySource,
} from './tool-registry.js';

// ---------------------------------------------------------------------------
// Shared constants — union of all recognized tool names across subsystems,
// plus the public-name list used as a fallback in unknown-tool diagnoses.
// ---------------------------------------------------------------------------

export const KNOWN_TOOL_NAMES = new Set(getRecognizedToolNames());

export const PUBLIC_SANDBOX_TOOL_NAMES = getToolPublicNames({ source: 'sandbox' }).slice().sort();

const IMPLEMENTED_SANDBOX_TOOLS = new Set(getRecognizedToolNames({ source: 'sandbox' }));

// ---------------------------------------------------------------------------
// Tool source resolution — maps a tool name to its subsystem source.
// ---------------------------------------------------------------------------

export function getToolSource(toolName: string | null): ToolRegistrySource {
  if (!toolName) return 'sandbox';
  const source = getToolSourceFromName(toolName);
  if (source) return source;
  return 'sandbox'; // Fallback
}

// ---------------------------------------------------------------------------
// Unimplemented sandbox tool detection — returns the offending tool name,
// or null if the text does not reference an unrecognized `sandbox_*` tool.
// ---------------------------------------------------------------------------

export function detectUnimplementedToolCall(text: string): string | null {
  return detectToolFromText<string>(text, (parsed) => {
    const rawName = asRecord(parsed)?.tool;
    const toolName = typeof rawName === 'string' ? rawName : '';
    if (toolName.startsWith('sandbox_') && !IMPLEMENTED_SANDBOX_TOOLS.has(toolName)) {
      return toolName;
    }
    return null;
  });
}

// ---------------------------------------------------------------------------
// Diagnosis result type
// ---------------------------------------------------------------------------

export interface ToolCallDiagnosis {
  reason: 'truncated' | 'validation_failed' | 'malformed_json' | 'natural_language_intent';
  toolName: string | null;
  errorMessage: string;
  source?: ToolRegistrySource;
  /** When true, record the metric but do not inject an error or trigger a retry. */
  telemetryOnly?: boolean;
}

// ---------------------------------------------------------------------------
// diagnoseToolCallFailure — replaces detectMalformedToolAttempt
// Multi-phase check, only runs when detectAnyToolCall returned null.
// ---------------------------------------------------------------------------

/**
 * Diagnose why a tool call was not detected. Returns a specific error
 * message if the text looks like a failed tool call attempt, or null
 * if the text is genuinely not a tool call.
 */
export function diagnoseToolCallFailure(text: string): ToolCallDiagnosis | null {
  // Phase 1: Truncation — JSON cut off mid-stream
  const truncated = detectTruncatedToolCall(text);
  if (truncated) {
    return {
      reason: 'truncated',
      toolName: truncated.toolName,
      source: getToolSource(truncated.toolName),
      errorMessage: `Your tool call for "${getToolPublicName(truncated.toolName)}" was truncated (JSON cut off). Please retry with the complete JSON block.`,
    };
  }

  // Phase 2: Validation failure — JSON parses (or repairs), has a known tool name,
  // but the subsystem validator rejected it (wrong/missing args)
  const fenceRegex =
    /(?:`{3,}|~{3,})(?:json[c5]?|tool|javascript)?\s*\n?([\s\S]*?)\n?\s*(?:`{3,}|~{3,})/g;
  let fenceMatch;
  while ((fenceMatch = fenceRegex.exec(text)) !== null) {
    const toolName = extractKnownToolName(fenceMatch[1].trim());
    if (toolName) {
      return {
        reason: 'validation_failed',
        toolName,
        errorMessage: buildValidationErrorMessage(toolName),
        source: getToolSource(toolName),
      };
    }
  }

  for (const parsed of extractBareToolJsonObjects(text)) {
    const obj = asRecord(parsed);
    const toolName = typeof obj?.tool === 'string' ? (resolveToolName(obj.tool) ?? obj.tool) : null;
    if (toolName && KNOWN_TOOL_NAMES.has(toolName)) {
      return {
        reason: 'validation_failed',
        toolName,
        errorMessage: buildValidationErrorMessage(toolName),
        source: getToolSource(toolName),
      };
    }
  }

  // Phase 2.5: Unknown tool name — well-formed JSON with {"tool": "<name>", "args": {...}}
  // but the tool name isn't in KNOWN_TOOL_NAMES. This happens when models hallucinate
  // tools (e.g. "edit" instead of "sandbox_edit_file"). Return actionable feedback
  // listing the correct tools so the model can retry.
  const unknownToolDiagnosis = detectUnknownToolName(text);
  if (unknownToolDiagnosis) return unknownToolDiagnosis;

  // Phase 3: Malformed JSON — the text contains something that looks like a tool call
  // (has "tool": "<known_name>" or similar) but is structurally broken JSON that
  // repair couldn't fix. Return a specific syntax-error diagnosis so the model
  // gets actionable feedback like "missing opening brace" instead of silence.
  const malformedDiagnosis = diagnoseMalformedToolJson(text);
  if (malformedDiagnosis) return malformedDiagnosis;

  // Phase 3.5: Bare JSON args — telemetry only. Records the metric so we can track
  // how often models emit bare args, but does NOT trigger a retry (too imprecise).
  const bareObjects = extractAllBareJsonObjects(text);
  for (const obj of bareObjects) {
    if (typeof obj.tool === 'string') continue; // already handled by earlier phases
    const inferred = inferToolFromArgs(obj);
    if (inferred) {
      return {
        reason: 'validation_failed',
        toolName: inferred,
        errorMessage:
          `Your response contains what looks like "${getToolPublicName(inferred)}" arguments but is missing the required wrapper format. Use this structure:\n\n` +
          '```json\n' +
          `{"tool": "${getToolPublicName(inferred)}", "args": ${JSON.stringify(obj)}}\n` +
          '```\n\n' +
          'Always wrap tool calls in {"tool": "...", "args": {...}} format.',
        telemetryOnly: true,
      };
    }
  }

  // Phase 4: Natural language tool intent — actionable. These are high-signal
  // cases ("I'll use sandbox_exec...") where the model clearly intended a tool
  // call but emitted prose instead of JSON; return a diagnosis so the caller can
  // inject a correction and retry.
  // 4. Bias toward discovery intent (Prose describes investigation without tool call)
  const explorerDiagnosis = diagnoseMissingExplorerCall(text);
  if (explorerDiagnosis) return explorerDiagnosis;

  const nlIntent = detectNaturalLanguageToolIntent(text);
  if (nlIntent) return nlIntent;

  return null;
}

/**
 * Diagnoses a response that contains prose about wanting to explore or trace
 * without emitting the explorer tool. Bias toward investigation intent.
 */
function diagnoseMissingExplorerCall(text: string): ToolCallDiagnosis | null {
  if (
    extractBareToolJsonObjects(text).some((parsed) =>
      isReadOnlyToolName(asRecord(parsed)?.tool as string),
    )
  ) {
    return null;
  }
  const classification = classifyIntent(text);
  if (classification !== 'discovery') return null;
  const directIntentPattern =
    /\b(I\s+(?:should|will|need to|must|have to|want to)|Let\s+me|I'm\s+(?:going to|about to)|should\s+I)\b/i;
  const quotedPattern =
    /^\s*(?:feat:|fix:|refactor:|chore:|docs:|test:|The\s|You\s|This\s|Here\s)/im;
  if (!directIntentPattern.test(text) || quotedPattern.test(text)) return null;
  return {
    reason: 'natural_language_intent',
    toolName: 'delegate_explorer',
    errorMessage:
      `Your response describes an investigation or discovery process but you didn't include the \`explorer\` tool call. ` +
      `To explore the codebase, include a fenced JSON block like this:\n\n` +
      '```json\n' +
      '{"tool": "explorer", "args": {"task": "Trace the auth flow and summarize where session refresh happens", "files": ["src/auth.ts"]}}\n' +
      '```\n\n' +
      `A brief sentence before or after the block is fine, but the JSON block must be present.`,
  };
}

// ---------------------------------------------------------------------------
// Arg hints for common tools — shown in validation error messages
// ---------------------------------------------------------------------------

/** Build an actionable validation error message, including arg hints when available. */
function buildValidationErrorMessage(toolName: string): string {
  const publicName = getToolPublicName(toolName);
  const hint = getToolArgHint(toolName);
  if (hint) {
    return (
      `Your call to "${publicName}" has invalid or missing arguments. Expected format:\n\n` +
      '```json\n' +
      `${hint}\n` +
      '```\n\n' +
      'Check required fields and retry.'
    );
  }
  return `Your call to "${publicName}" has invalid or missing arguments. Check the tool protocol and retry with the correct argument format.`;
}

// ---------------------------------------------------------------------------
// Phase 3: Malformed JSON diagnosis — catches structurally broken tool calls
// that repair couldn't fix and returns a pinpointed syntax error.
// ---------------------------------------------------------------------------

/**
 * Scan text for fragments that look like tool calls (contain `"tool": "<known_name>"`)
 * but are structurally broken JSON. Uses `diagnoseJsonSyntaxError()` to pinpoint
 * the specific problem (missing brace, unterminated string, unbalanced brackets, etc.).
 *
 * Returns a diagnosis with `reason: 'malformed_json'` and an actionable error message,
 * or null if no such fragment is found.
 */
function diagnoseMalformedToolJson(text: string): ToolCallDiagnosis | null {
  // Strategy: find regions of text that contain a known tool name in a
  // tool-call-like pattern but failed to parse. We look for:
  //   1. Fenced code blocks containing tool-like content that isn't valid JSON
  //   2. Bare text containing `"tool": "<name>"` patterns outside valid JSON

  // Check fenced blocks first (higher signal)
  const fenceRegex =
    /(?:`{3,}|~{3,})(?:json[c5]?|tool|javascript)?\s*\n?([\s\S]*?)\n?\s*(?:`{3,}|~{3,})/g;
  let fenceMatch;
  while ((fenceMatch = fenceRegex.exec(text)) !== null) {
    const content = fenceMatch[1].trim();
    const diagnosis = tryDiagnoseFragment(content);
    if (diagnosis) return diagnosis;
  }

  // Check for bare tool-call-like patterns in the text
  // Match regions that contain "tool": "<name>" (with various quoting styles)
  const toolPattern = /["']?tool["']?\s*:\s*["'](\w+)["']/g;
  let toolMatch;
  while ((toolMatch = toolPattern.exec(text)) !== null) {
    const toolName = resolveToolName(toolMatch[1]) ?? toolMatch[1];
    if (!KNOWN_TOOL_NAMES.has(toolName)) continue;

    // Skip matches inside inline code (backticks) — these are explanatory prose
    if (isInsideInlineCode(text, toolMatch.index)) continue;

    // Extract a reasonable region around this match (find enclosing braces or context)
    const regionStart = findPrecedingBrace(text, toolMatch.index);
    const regionEnd = findFollowingBrace(text, toolMatch.index + toolMatch[0].length);

    // Skip if no preceding '{' was found (match is in plain prose, not a JSON fragment)
    if (regionStart === toolMatch.index) continue;

    const region = text.slice(regionStart, regionEnd + 1);

    // Skip if this region is already valid JSON (handled by earlier phases)
    try {
      JSON.parse(region);
      continue;
    } catch {
      /* expected — this is broken JSON */
    }

    // Skip if repair succeeds (handled by normal detection pipeline)
    if (repairToolJson(region)) continue;

    const diagnosis = tryDiagnoseFragment(region);
    if (diagnosis) return diagnosis;
  }

  return null;
}

/**
 * Try to diagnose a single text fragment as malformed tool JSON.
 * Returns a diagnosis or null if the fragment isn't recognizable as a tool call.
 */
function tryDiagnoseFragment(fragment: string): ToolCallDiagnosis | null {
  // Skip if it parses cleanly
  try {
    JSON.parse(fragment);
    return null;
  } catch {
    /* expected */
  }

  // Skip if repair succeeds (the normal pipeline will handle it)
  if (repairToolJson(fragment)) return null;

  // Extract tool name from the fragment
  const nameMatch = fragment.match(/["']?tool["']?\s*:\s*["'](\w+)["']/);
  if (!nameMatch) return null;
  const toolName = resolveToolName(nameMatch[1]) ?? nameMatch[1];
  if (!KNOWN_TOOL_NAMES.has(toolName)) return null;

  // Get the specific syntax error
  const syntaxError = diagnoseJsonSyntaxError(fragment);
  if (!syntaxError) return null;

  const hint = getToolArgHint(toolName);
  const hintBlock = hint ? `\n\nExpected format:\n\`\`\`json\n${hint}\n\`\`\`` : '';

  return {
    reason: 'malformed_json',
    toolName,
    errorMessage: `Your call to "${getToolPublicName(toolName)}" has a JSON syntax error: ${syntaxError.message}${hintBlock}\n\nPlease output a valid JSON block with balanced braces and proper quoting.`,
    source: getToolSource(toolName),
  };
}

/**
 * Check if position `pos` in `text` is inside an inline code span (single backticks).
 * Counts unescaped backticks before the position — odd count means inside inline code.
 * Ignores fenced code blocks (triple backticks) which are handled separately.
 */
function isInsideInlineCode(text: string, pos: number): boolean {
  let backtickCount = 0;
  for (let i = 0; i < pos; i++) {
    if (text[i] === '`') {
      // Skip fenced code blocks (triple backticks)
      if (text[i + 1] === '`' && text[i + 2] === '`') {
        const closeIdx = text.indexOf('```', i + 3);
        if (closeIdx !== -1 && closeIdx < pos) {
          i = closeIdx + 2; // Skip past closing fence
          continue;
        }
        return false; // Inside a fenced block — handled by the fenced block scanner
      }
      backtickCount++;
    }
  }
  return backtickCount % 2 === 1;
}

/**
 * Find the position of the nearest `{` before `pos` in text (for region extraction).
 * Returns `pos` if no preceding brace is found within a reasonable distance.
 */
function findPrecedingBrace(text: string, pos: number): number {
  const searchStart = Math.max(0, pos - 200);
  for (let i = pos - 1; i >= searchStart; i--) {
    if (text[i] === '{') return i;
  }
  return pos;
}

/**
 * Find the position of the nearest balanced `}` after `pos` in text (for region extraction).
 * Falls back to end-of-line or end-of-text if no closing brace is found.
 */
function findFollowingBrace(text: string, pos: number): number {
  const searchEnd = Math.min(text.length, pos + 2000);
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = pos; i < searchEnd; i++) {
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
    if (ch === '{') depth++;
    if (ch === '}') {
      if (depth === 0) return i;
      depth--;
    }
  }
  // No balanced brace found — return end of current line or end of search
  const newlineIdx = text.indexOf('\n', pos);
  return newlineIdx !== -1 && newlineIdx < searchEnd ? newlineIdx : searchEnd - 1;
}

/**
 * Try to extract a known tool name from a JSON-like string.
 * Attempts JSON.parse first, then repair.
 */
function extractKnownToolName(text: string): string | null {
  // Try direct parse
  try {
    const parsed = JSON.parse(text);
    const obj = asRecord(parsed);
    const toolName = typeof obj?.tool === 'string' ? (resolveToolName(obj.tool) ?? obj.tool) : null;
    if (toolName && KNOWN_TOOL_NAMES.has(toolName)) {
      return toolName;
    }
  } catch {
    // Try repair
    const repaired = repairToolJson(text);
    const toolName =
      typeof repaired?.tool === 'string' ? (resolveToolName(repaired.tool) ?? repaired.tool) : null;
    if (toolName && KNOWN_TOOL_NAMES.has(toolName)) {
      return toolName;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Phase 2.5: Unknown tool name detection — catches well-formed JSON tool
// calls where the tool name isn't recognized. Suggests the closest match.
// ---------------------------------------------------------------------------

/** Common aliases models use for tools that don't exist, mapped to suggestions. */
const TOOL_NAME_SUGGESTIONS: Record<string, string[]> = {
  edit_file: ['edit', 'replace'],
  write_file: ['write'],
  run: ['exec'],
  execute: ['exec'],
  grep: ['repo_grep', 'search'],
  list: ['ls', 'repo_ls'],
  download: ['download'],
};

function detectUnknownToolName(text: string): ToolCallDiagnosis | null {
  // Only check fenced code blocks — these are high-signal tool-call contexts.
  // Bare JSON with unknown tool names in prose (docs, examples, spec output)
  // should not trigger retry loops.
  const fenceRegex =
    /(?:`{3,}|~{3,})(?:json[c5]?|tool|javascript)?\s*\n?([\s\S]*?)\n?\s*(?:`{3,}|~{3,})/g;
  let fenceMatch;
  while ((fenceMatch = fenceRegex.exec(text)) !== null) {
    const result = extractUnknownToolName(fenceMatch[1].trim());
    if (result) return buildUnknownToolDiagnosis(result);
  }

  return null;
}

function extractUnknownToolName(text: string): string | null {
  try {
    const parsed = JSON.parse(text);
    const obj = asRecord(parsed);
    if (
      obj &&
      typeof obj.tool === 'string' &&
      !KNOWN_TOOL_NAMES.has(obj.tool) &&
      obj.args !== undefined
    ) {
      return obj.tool;
    }
  } catch {
    const repaired = repairToolJson(text);
    if (
      repaired &&
      typeof repaired.tool === 'string' &&
      !KNOWN_TOOL_NAMES.has(repaired.tool) &&
      repaired.args !== undefined
    ) {
      return repaired.tool;
    }
  }
  return null;
}

function buildUnknownToolDiagnosis(toolName: string): ToolCallDiagnosis {
  const suggestions = TOOL_NAME_SUGGESTIONS[toolName.toLowerCase()];
  const suggestionBlock = suggestions
    ? `\n\nDid you mean one of these?\n${suggestions
        .map((s) => {
          const hint = getToolArgHint(s);
          const publicName = getToolPublicName(s);
          return hint ? `- ${publicName}: \`${hint}\`` : `- ${publicName}`;
        })
        .join('\n')}`
    : `\n\nAvailable tools: ${KNOWN_PUBLIC_TOOL_NAMES.slice().sort().join(', ')}`;

  return {
    reason: 'validation_failed',
    toolName,
    errorMessage: `Tool "${toolName}" does not exist.${suggestionBlock}`,
    source: 'sandbox',
  };
}

// ---------------------------------------------------------------------------
// Bare JSON recovery helpers — shared by Phase 3.5 of diagnoseToolCallFailure
// and the Web-side tryRecoverBareToolArgs/detectAllToolCalls.
// ---------------------------------------------------------------------------

/**
 * Extract ALL top-level JSON objects from text, regardless of whether they
 * have a 'tool' key. Used for bare-args recovery.
 */
export function extractAllBareJsonObjects(text: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
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

    try {
      const parsed = JSON.parse(text.slice(braceIdx, end + 1));
      const obj = asRecord(parsed);
      if (obj) results.push(obj);
    } catch {
      /* not valid JSON — skip */
    }

    i = end + 1;
  }
  return results;
}

/**
 * Infer which tool a bare JSON args object belongs to, based on its keys.
 * Returns the tool name, or null if the args don't match any known pattern.
 */
export function inferToolFromArgs(args: Record<string, unknown>): string | null {
  const hasRepo = typeof args.repo === 'string';
  const hasPath = typeof args.path === 'string';
  const hasCommand = typeof args.command === 'string';
  const hasContent = typeof args.content === 'string';
  const hasPattern = typeof args.pattern === 'string';
  const hasQuery = typeof args.query === 'string';
  const hasPr = args.pr !== undefined;
  const hasSha = typeof args.sha === 'string';
  const hasRef = typeof args.ref === 'string';
  const hasEdits = Array.isArray(args.edits);
  const hasMessage = typeof args.message === 'string';
  const hasFilePath = typeof args.file_path === 'string';
  const hasWorkflow = typeof args.workflow === 'string';
  const hasRunId = args.run_id !== undefined;

  const hasCount = args.count !== undefined;
  const hasState = typeof args.state === 'string';
  const hasBranchName = typeof args.branch_name === 'string';
  const hasTitle = typeof args.title === 'string';
  const hasHead = typeof args.head === 'string';
  const hasBase = typeof args.base === 'string';
  const hasPrNumber = args.pr_number !== undefined;
  const hasHeadBranch = typeof args.head_branch === 'string';

  // GitHub tools — identified by the 'repo' key
  if (hasRepo) {
    if (hasPath && hasPattern) return 'grep_file';
    if (hasPath) return 'read_file';
    if (hasQuery) return 'search_files';
    if (hasPr) return 'fetch_pr';
    if (hasSha) return 'list_commit_files';
    if (hasRef && hasWorkflow) return null; // ambiguous
    if (hasRef) return 'fetch_checks';
    if (hasWorkflow && hasRunId) return 'get_workflow_logs';
    if (hasWorkflow) return 'trigger_workflow';
    // Disambiguate repo-only patterns using secondary keys
    if (hasCount && !hasState) return 'list_commits';
    if (hasState) return 'list_prs';
    if (hasBranchName && hasTitle) return 'create_pr';
    if (hasPrNumber && typeof args.merge_method === 'string') return 'merge_pr';
    if (hasPrNumber) return 'check_pr_mergeable';
    if (hasHeadBranch) return 'find_existing_pr';
    if (hasTitle && hasHead && hasBase) return 'create_pr';
    // Still ambiguous (list_directory, list_branches, list_commits w/o count) — skip
    return null;
  }

  // Sandbox tools — no 'repo' key
  if (hasCommand) return 'sandbox_exec';
  if ((hasPath || hasFilePath) && hasEdits) return 'sandbox_edit_file';
  if ((hasPath || hasFilePath) && hasContent) return 'sandbox_write_file';
  if ((hasPath || hasFilePath) && !hasContent && !hasMessage) return 'sandbox_read_file';
  if (hasQuery && !hasRepo) return 'web_search';
  if (hasMessage && !hasRepo) return 'sandbox_prepare_commit';

  return null;
}

// ---------------------------------------------------------------------------
// Natural language tool intent detection
// ---------------------------------------------------------------------------
// Some models (e.g. Codex via OpenRouter) describe wanting to use a tool in
// prose without emitting the JSON block. This detector catches common
// phrasing patterns and nudges the model to emit proper tool-call JSON.

/** Intent action verbs that signal the model wants to do something NOW. */
const INTENT_VERBS = `(?:I(?:'ll|\\s+will|\\s+am\\s+going\\s+to|\\s+should)|Let\\s+me|I'm\\s+going\\s+to|Going\\s+to|Now\\s+I(?:'ll|\\s+will)|First\\s+I(?:'ll|\\s+will|\\s+should))`;

interface NLIntentPattern {
  regex: RegExp;
  toolName: string;
  exampleJson: string;
}

/**
 * Patterns that match natural language expressions of tool-use intent.
 * Each includes the tool name and an example JSON to nudge the model.
 *
 * We use case-insensitive matching. The patterns require an action-verb
 * prefix (e.g. "I'll", "Let me") to avoid false-positives when the model
 * is merely explaining what a tool does.
 */
const NL_INTENT_PATTERNS: NLIntentPattern[] = [
  // delegate_coder — most common failure case (e.g. Codex says "I'll delegate to the coder")
  {
    regex: new RegExp(
      `${INTENT_VERBS}\\s+delegat(?:e|ing)\\s+(?:this\\s+)?(?:to\\s+)?(?:the\\s+)?coder`,
      'i',
    ),
    toolName: 'delegate_coder',
    exampleJson:
      getToolArgHint('delegate_coder') ??
      '{"tool": "coder", "args": {"task": "describe the task here"}}',
  },
  {
    regex: new RegExp(
      `${INTENT_VERBS}\\s+delegat(?:e|ing)\\s+(?:this\\s+)?(?:task\\s+)?(?:to\\s+)?(?:the\\s+)?coder(?:\\s+agent)?`,
      'i',
    ),
    toolName: 'delegate_coder',
    exampleJson:
      getToolArgHint('delegate_coder') ??
      '{"tool": "coder", "args": {"task": "describe the task here"}}',
  },
  {
    regex: new RegExp(
      `${INTENT_VERBS}\\s+delegat(?:e|ing)\\s+(?:this\\s+)?(?:to\\s+)?(?:the\\s+)?explorer`,
      'i',
    ),
    toolName: 'delegate_explorer',
    exampleJson:
      getToolArgHint('delegate_explorer') ??
      '{"tool": "explorer", "args": {"task": "describe what to investigate"}}',
  },
  {
    regex: new RegExp(
      `${INTENT_VERBS}\\s+delegat(?:e|ing)\\s+(?:this\\s+)?(?:task\\s+)?(?:to\\s+)?(?:the\\s+)?explorer(?:\\s+agent)?`,
      'i',
    ),
    toolName: 'delegate_explorer',
    exampleJson:
      getToolArgHint('delegate_explorer') ??
      '{"tool": "explorer", "args": {"task": "describe what to investigate"}}',
  },
  // Action-phrase patterns — catch natural descriptions of tool actions
  // (e.g. "I'll fetch the recent commits") without requiring exact tool names.
  // Each requires INTENT_VERBS prefix to avoid matching conversational text.
  // Word boundaries (\b) on key nouns prevent false matches on substrings
  // (e.g. "filename" won't match the "file" pattern).
  {
    regex: new RegExp(
      `${INTENT_VERBS}\\s+(?:fetch|get|pull|check|grab|look\\s+at|retrieve|show)\\s+(?:the\\s+)?(?:recent\\s+|latest\\s+)?commits\\b`,
      'i',
    ),
    toolName: 'list_commits',
    exampleJson:
      getToolArgHint('list_commits') ?? '{"tool": "commits", "args": {"repo": "owner/repo"}}',
  },
  {
    regex: new RegExp(
      `${INTENT_VERBS}\\s+(?:read|open|look\\s+at|check|view|inspect|pull\\s+up|examine)\\s+(?:the\\s+|that\\s+)?file\\b`,
      'i',
    ),
    toolName: 'read_file',
    exampleJson:
      getToolArgHint('read_file') ??
      '{"tool": "repo_read", "args": {"repo": "owner/repo", "path": "src/app.ts"}}',
  },
  {
    regex: new RegExp(
      `${INTENT_VERBS}\\s+(?:search|find|look\\s+for|grep|scan)\\s+(?:the\\s+|for\\s+)?(?:code|repo|codebase|files)\\b`,
      'i',
    ),
    toolName: 'search_files',
    exampleJson:
      getToolArgHint('search_files') ??
      '{"tool": "repo_search", "args": {"repo": "owner/repo", "query": "searchTerm"}}',
  },
  {
    regex: new RegExp(
      `${INTENT_VERBS}\\s+(?:fetch|get|check|pull|grab|look\\s+at|retrieve|show)\\s+(?:the\\s+)?(?:open\\s+|recent\\s+|latest\\s+)?(?:PRs?|pull\\s+requests?)\\b`,
      'i',
    ),
    toolName: 'list_prs',
    exampleJson: getToolArgHint('list_prs') ?? '{"tool": "prs", "args": {"repo": "owner/repo"}}',
  },
  {
    regex: new RegExp(
      `${INTENT_VERBS}\\s+(?:fetch|get|check|list|pull|grab|look\\s+at|retrieve|show)\\s+(?:the\\s+)?branches\\b`,
      'i',
    ),
    toolName: 'list_branches',
    exampleJson:
      getToolArgHint('list_branches') ?? '{"tool": "branches", "args": {"repo": "owner/repo"}}',
  },
  // Generic: model mentions a known tool name by its exact name without JSON
  // e.g. "I'll use sandbox_exec to run the tests"
  // This is safe because it requires the actual tool identifier in the text.
  {
    regex: new RegExp(
      `${INTENT_VERBS}\\s+(?:use|call|invoke|try)\\s+(${getRecognizedToolNames().map(escapeToolNameForRegex).join('|')})`,
      'i',
    ),
    toolName: '', // filled dynamically from capture group
    exampleJson: '', // filled dynamically
  },
];

/**
 * Detect natural language expressions of tool-call intent.
 * Returns a diagnosis when the model described wanting to use a tool
 * but didn't emit a JSON block.
 */
function detectNaturalLanguageToolIntent(text: string): ToolCallDiagnosis | null {
  // Skip if text already contains JSON-like structures — those are handled
  // by the earlier phases (truncation, validation, malformed).
  if (/\{\s*"?'?tool/.test(text)) return null;

  const normalized = text.trim();
  // Don't match very short responses — too likely to false-positive
  if (normalized.length < 15) return null;

  for (const pattern of NL_INTENT_PATTERNS) {
    const match = pattern.regex.exec(normalized);
    if (!match) continue;

    // For the generic "I'll use <tool_name>" pattern, extract the tool name
    let toolName = pattern.toolName;
    let exampleJson = pattern.exampleJson;
    if (!toolName && match[1]) {
      toolName = resolveToolName(match[1]) ?? match[1];
      // Build a generic example for the matched tool
      if (KNOWN_TOOL_NAMES.has(toolName)) {
        exampleJson =
          getToolArgHint(toolName) ?? `{"tool": "${getToolPublicName(toolName)}", "args": {}}`;
      } else {
        continue; // Not a real tool name — skip
      }
    }

    if (!toolName) continue;

    return {
      reason: 'natural_language_intent',
      toolName,
      errorMessage:
        `You described wanting to use "${getToolPublicName(toolName)}" but didn't include the required JSON tool block. ` +
        `To call a tool, include a fenced JSON block like this:\n\n` +
        '```json\n' +
        `${exampleJson}\n` +
        '```\n\n' +
        `A brief sentence before or after the block is fine, but the JSON block must be present.`,
    };
  }

  return null;
}
