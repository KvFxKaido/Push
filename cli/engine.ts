import process from 'node:process';
import { promises as fs } from 'node:fs';
import nodePath from 'node:path';
import {
  detectAllToolCalls,
  ensureInsideWorkspace,
  executeToolCall,
  isFileMutationToolCall,
  isReadOnlyToolCall,
  truncateText,
  TOOL_PROTOCOL,
} from './tools.js';
import {
  appendSessionEvent as appendSessionEventRaw,
  saveSessionState,
  makeRunId,
} from './session-store.js';
import { streamCompletion, type StreamCompletionOptions } from './provider.js';
import {
  createFileLedger,
  getLedgerSummary,
  updateFileLedger,
  resetTurnBudget,
} from './file-ledger.js';
import { FileAwarenessLedger, type EditGuardVerdict } from '../lib/file-awareness-ledger.js';
import { recordMalformedToolCall } from './tool-call-metrics.js';
import { recordWriteFile } from './edit-metrics.js';
import { recordContextTrim } from './context-metrics.js';
import { computeAdaptation } from './harness-adaptation.js';
import {
  buildWorkspaceSnapshot,
  loadProjectInstructions,
  loadMemory,
} from './workspace-context.js';
import {
  trimContext,
  distillContext,
  estimateContextTokens,
  getContextBudget,
  isToolResultMessage,
  isParseErrorMessage,
} from './context-manager.js';
import { transformContextBeforeLLM, type DistillResult } from '../lib/context-transformer.ts';
import { getDefaultMemoryStore } from '../lib/context-memory-store.ts';
import { deriveUserGoalAnchor } from '../lib/user-goal-anchor.ts';
import { loadUserGoalFile, seedUserGoalFile, extractDigestBody } from './user-goal-file.ts';
import { escapeToolResultBoundaries } from '../lib/untrusted-content.ts';
import { TurnPolicyRegistry, createCoderPolicy } from './turn-policy.js';
import { buildMalformedToolCallEvents, summarizeToolResultPreview } from '../lib/run-events.ts';
import { getDefaultCliHookRegistry, readCliCurrentBranch } from './tool-hooks-default.ts';
import { assertReadyForAssistantTurn } from '../lib/llm-message-invariants.ts';
import {
  SystemPromptBuilder,
  diffSnapshots,
  formatSnapshotDiff,
  type PromptSnapshot,
} from '../lib/system-prompt-builder.ts';
import {
  createWorkingMemory,
  applyWorkingMemoryUpdate,
  shouldInjectCoderStateOnToolResult,
  type CoderWorkingMemory,
} from '../lib/working-memory.ts';
import type { TurnContext } from './turn-policy.js';

import type { SessionState } from './session-store.js';
import type { ProviderConfig } from './provider.js';
import type { Message, TrimResult } from './context-manager.js';
import type { FileLedger } from './file-ledger.js';

// ─── Interfaces ──────────────────────────────────────────────────

export interface EngineEvent {
  type: string;
  payload: unknown;
  runId: string;
  sessionId: string;
}

export interface RunOptions {
  approvalFn?: (tool: string, detail: unknown) => Promise<boolean>;
  askUserFn?: (prompt: string) => Promise<string>;
  signal?: AbortSignal;
  emit?: (event: EngineEvent) => void;
  runId?: string;
  allowExec?: boolean;
  safeExecPatterns?: string[];
  execMode?: string;
  // CLI tool names blocked at `executeToolCall` dispatch. Empty/undefined
  // means no tools are blocked.
  disabledTools?: string[];
  // CLI tool names that bypass approval prompts in their gate
  // (today: `exec`, `exec_start`).
  alwaysAllow?: string[];
  // Skip the terminal `run_complete` append + dispatch. Callers that run
  // `runAssistantLoop` as a sub-step of a larger turn (delegation per-node)
  // set this so the parent scope is the only writer of `run_complete` —
  // otherwise each node writes its own record and `aggregateStats` in
  // `cli/stats.ts` overcounts runs per delegated turn.
  suppressRunComplete?: boolean;
  // Skip persisting per-event `appendSessionEvent` writes for this run.
  // Delegation passes this alongside `emit: null` on per-node runs so that
  // internal node tool/assistant events are kept out of the session event
  // log on disk — otherwise a client reconnecting via `attach_session`
  // would see node-level events on replay that were intentionally hidden
  // from live fan-out, producing a transcript diverging from what attached
  // clients originally saw. The delegation wrapper is the authoritative
  // writer of the parent-visible `delegation.*` lifecycle + `run_complete`
  // envelopes for this turn.
  suppressEventPersist?: boolean;
}

export interface RunResult {
  outcome: 'success' | 'aborted' | 'error' | 'max_rounds';
  finalAssistantText: string;
  rounds: number;
  runId: string;
}

interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
  source?: string;
}

interface ToolResult {
  ok: boolean;
  text: string;
  meta?: Record<string, unknown> | null;
  structuredError?: {
    code: string;
    message: string;
    retryable: boolean;
  } | null;
}

interface DetectedToolCalls {
  calls: ToolCall[];
  malformed: { reason: string; sample: string }[];
}

interface MetaEnvelope {
  runId: string;
  round: number;
  contextChars: number;
  trimmed: boolean;
  estimatedTokens: number;
  ledger: unknown;
  workingMemory?: unknown;
}

interface ProjectInstructions {
  file: string;
  content: string;
}

type WorkingMemory = CoderWorkingMemory;

// ─── Constants ───────────────────────────────────────────────────

export const DEFAULT_MAX_ROUNDS: number = 30;

// Sentinel appended to the base prompt — signals that workspace context
// (git status, project instructions, memory) still needs to be loaded.
const NEEDS_ENRICHMENT: string = '[WORKSPACE_PENDING]';

const DEBUG_PROMPTS: boolean = process.env.PUSH_DEBUG === '1' || process.env.PUSH_DEBUG === 'true';

// ─── Context Distillation ─────────────────────────────────────────

/**
 * Determine if mid-session context distillation is needed.
 * Only distill if we're past round 4, have a plan, and are over half the token budget.
 */
export function shouldDistillMidSession(
  messages: Message[],
  workingMemory: WorkingMemory | undefined,
  round: number,
  providerId: string,
  model: string,
): boolean {
  if (round <= 4) return false;
  if (!workingMemory?.plan?.trim().length) return false;
  const budget = getContextBudget(providerId, model);
  return estimateContextTokens(messages) > budget.targetTokens / 2;
}

/**
 * Canonicalize a file path for awareness-ledger lookup. The CLI tool executor
 * sets `result.meta.path` to an absolute resolved path (via
 * `ensureInsideWorkspace`), while the model passes `call.args.path` as a
 * relative path. Without canonicalization the guard and recorder use
 * different keys and a successfully-read file looks unread to the next write.
 *
 * Stable key: workspace-relative POSIX path with forward slashes.
 */
export function canonicalizeAwarenessPath(rawPath: string, workspaceRoot: string): string {
  const absolute = nodePath.isAbsolute(rawPath)
    ? rawPath
    : nodePath.resolve(workspaceRoot, rawPath);
  const relative = nodePath.relative(workspaceRoot, absolute);
  // Force POSIX separators so Windows and POSIX paths resolve to the same key.
  return relative.split(nodePath.sep).join('/');
}

/**
 * Synthesize a "what the model is writing" content blob from an edit_file
 * call's hashline edits. Used by the symbolic edit check to detect whether
 * the edit declares/redeclares symbols (e.g. renaming a function), which
 * triggers a deeper coverage check than the plain `checkWriteAllowed`.
 *
 * Body-internal edits without symbol declarations produce empty content here,
 * which the canonical `checkSymbolicEditAllowed` falls back to a line-based
 * check for. That fallback is what auto-recovery handles.
 */
function synthesizeEditContent(call: ToolCall): string {
  const edits = Array.isArray(call.args?.edits) ? call.args.edits : [];
  const parts: string[] = [];
  for (const edit of edits) {
    if (edit && typeof edit === 'object') {
      const content = (edit as Record<string, unknown>).content;
      if (typeof content === 'string') parts.push(content);
    }
  }
  return parts.join('\n');
}

/** Run the appropriate verdict check for the given tool call. */
function checkAwarenessVerdict(
  call: ToolCall,
  key: string,
  ledger: FileAwarenessLedger,
): EditGuardVerdict {
  if (call.tool === 'edit_file') {
    return ledger.checkSymbolicEditAllowed(key, synthesizeEditContent(call));
  }
  return ledger.checkWriteAllowed(key);
}

/**
 * Pre-execution awareness guard for write/edit tools. Returns a synthetic
 * blocked tool result when the canonical FileAwarenessLedger denies the call,
 * after attempting transparent auto-recovery. Returns null when the call may
 * proceed. Surfaces verdict codes through the structured-error channel so the
 * model can recover programmatically if auto-recovery itself fails.
 *
 * Auto-recovery: when the initial verdict blocks, the harness validates the
 * path is inside the workspace and confirms it exists on disk, then refreshes
 * the ledger to fully_read and retries the verdict before returning a block.
 * Mirrors the web app's `sandbox-write-handlers` flow.
 *
 * Security: path validation goes through `ensureInsideWorkspace` so `..`
 * traversal, absolute paths outside the root, and symlink escapes fail
 * closed (verdict propagates without any I/O on the out-of-scope target).
 *
 * Special-case: when auto-recovery's existence check fails with ENOENT,
 * write_file is allowed through (creation), edit_file remains blocked
 * (hashline edits need existing content). Other errors propagate the
 * original verdict — the downstream tool will hit the same I/O error and
 * surface a more informative message than a guard block would.
 *
 * Symbolic precision: edit_file uses `checkSymbolicEditAllowed`, which
 * compares symbols declared in the edit content against symbols the model has
 * read. When the edit content has no symbol declarations, the canonical falls
 * back to `checkWriteAllowed` — which auto-recovery then handles.
 */
export async function awarenessGuardForCall(
  call: ToolCall,
  ledger: FileAwarenessLedger,
  workspaceRoot: string,
): Promise<ToolResult | null> {
  if (call.tool !== 'write_file' && call.tool !== 'edit_file') return null;
  const rawPath = typeof call.args?.path === 'string' ? call.args.path : null;
  if (!rawPath) return null;

  const key = canonicalizeAwarenessPath(rawPath, workspaceRoot);
  const verdict = checkAwarenessVerdict(call, key, ledger);
  if (verdict.allowed) return null;

  // Auto-recovery: validate path stays inside the workspace, confirm the
  // target exists, refresh the ledger to fully_read, retry.
  let absolute: string;
  try {
    absolute = await ensureInsideWorkspace(workspaceRoot, rawPath);
  } catch {
    // Path escapes workspace (`..` traversal, absolute outside root, symlink
    // escape). Fail closed — propagate the original guard verdict without
    // touching the filesystem on the out-of-scope target. The downstream
    // tool's own ensureInsideWorkspace call will surface the path error.
    return {
      ok: false,
      text: `[Awareness guard — ${call.tool}] ${verdict.reason}`,
      structuredError: {
        code: verdict.code,
        message: verdict.reason,
        retryable: true,
      },
    };
  }

  try {
    // Existence + regular-file check. recordRead with no start/end/truncated
    // already marks the entry fully_read regardless of totalLines, so loading
    // the file content here would be wasted I/O (and unbounded for large
    // files). Non-regular-file targets (directories, devices) cannot be
    // edited and are treated as "auto-recovery can't help" — propagate the
    // original verdict so the downstream tool's own error surfaces.
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) {
      return {
        ok: false,
        text: `[Awareness guard — ${call.tool}] ${verdict.reason}`,
        structuredError: {
          code: verdict.code,
          message: verdict.reason,
          retryable: true,
        },
      };
    }
    ledger.recordRead(key);

    const retryVerdict = checkAwarenessVerdict(call, key, ledger);
    if (retryVerdict.allowed) return null;

    return {
      ok: false,
      text: `[Awareness guard — ${call.tool}] ${retryVerdict.reason}`,
      structuredError: {
        code: retryVerdict.code,
        message: retryVerdict.reason,
        retryable: true,
      },
    };
  } catch (err) {
    const errno = (err as NodeJS.ErrnoException | null)?.code;
    if (errno === 'ENOENT' && call.tool === 'write_file') {
      // File doesn't exist — write_file creates it. edit_file is intentionally
      // not granted this exception: hashline edits require existing content.
      return null;
    }
    // Other auto-recovery errors (EACCES, EPERM, etc.) surface the original
    // guard verdict. The actual write/edit will hit the same I/O error and
    // surface a more informative message than the guard block.
    return {
      ok: false,
      text: `[Awareness guard — ${call.tool}] ${verdict.reason}`,
      structuredError: {
        code: verdict.code,
        message: verdict.reason,
        retryable: true,
      },
    };
  }
}

/**
 * Update the awareness ledger from a successful tool result. Reads grow
 * coverage; successful writes/edits become model_authored so an immediate
 * follow-up edit doesn't deadlock. The ledger only mutates on `result.ok`,
 * so guard-blocked synthetic results (which are `ok:false`) are skipped.
 *
 * Paths are canonicalized to the same workspace-relative key the guard uses.
 */
export function recordAwarenessFromCall(
  call: ToolCall,
  result: ToolResult,
  ledger: FileAwarenessLedger,
  workspaceRoot: string,
): void {
  if (!result.ok) return;
  const meta = result.meta;
  if (!meta || typeof meta.path !== 'string') return;
  const key = canonicalizeAwarenessPath(meta.path, workspaceRoot);

  if (call.tool === 'read_file' || call.tool === 'read_symbol') {
    ledger.recordRead(key, {
      startLine: typeof meta.start_line === 'number' ? meta.start_line : undefined,
      endLine: typeof meta.end_line === 'number' ? meta.end_line : undefined,
      truncated: typeof meta.truncated === 'boolean' ? meta.truncated : undefined,
      totalLines: typeof meta.total_lines === 'number' ? meta.total_lines : undefined,
    });
    return;
  }

  if (call.tool === 'write_file' || call.tool === 'edit_file') {
    // Treat post-write/edit content as model_authored. v1 limitation: edit_file
    // only modifies a portion of the file, so this is slightly permissive on
    // subsequent edits to unread regions of the same file. The conservative
    // alternative (leave prior partial_read state in place) deadlocks immediate
    // follow-up edits. Auto re-read after edits is a follow-up (the web app
    // does it via its sandbox handlers).
    ledger.recordCreation(key);
  }
}

function applyWorkingMemoryUpdateToState(
  state: SessionState,
  args: Partial<WorkingMemory>,
  round: number,
): WorkingMemory {
  if (!state.workingMemory || typeof state.workingMemory !== 'object') {
    state.workingMemory = createWorkingMemory();
  }

  const mem = state.workingMemory as WorkingMemory;
  applyWorkingMemoryUpdate(mem, args, round);
  return mem;
}

function cloneWorkingMemory(mem: WorkingMemory): WorkingMemory {
  return JSON.parse(JSON.stringify(mem)) as WorkingMemory;
}

// ─── System Prompt ───────────────────────────────────────────────

function buildCliIdentity(workspaceRoot: string): string {
  return `You are a coding assistant running in a local workspace.
Workspace root: ${workspaceRoot}`;
}

function buildCliGuidelines(): string {
  const explainBlock: string =
    process.env.PUSH_EXPLAIN_MODE === 'true'
      ? `Explain mode is active. After each significant action, add a brief [explain] note (2–3 lines) describing the pattern or architectural convention at play — not what you just did, but why this approach fits the codebase. Focus on patterns the user can recognize next time (e.g. "this follows the hook factory pattern used across all provider configs" or "edit expressed as hashline ops to avoid line-number drift"). Keep it concise and skip it for trivial changes.`
      : '';

  return [
    'You can read files, run commands, and write files using tools.',
    'Use tools for facts; do not invent file contents or command outputs.',
    "If the user's message does not require reading files or running commands, respond directly without tool calls.",
    'Each tool-loop round is expensive — plan before acting, batch related reads, and avoid exploratory browsing unless the user asks for it.',
    'Use coder_update_state to keep a concise working plan; it is persisted and reinjected.',
    'Use save_memory to persist learnings across sessions (build commands, project patterns, conventions).',
    explainBlock,
  ]
    .filter(Boolean)
    .join('\n');
}

function buildCliBaseBuilder(workspaceRoot: string): SystemPromptBuilder {
  return new SystemPromptBuilder()
    .set('identity', buildCliIdentity(workspaceRoot))
    .set('guidelines', buildCliGuidelines())
    .set('tool_instructions', TOOL_PROTOCOL);
}

async function enrichCliBuilder(
  builder: SystemPromptBuilder,
  workspaceRoot: string,
): Promise<void> {
  const [snapshot, instructions, memory] = await Promise.all([
    buildWorkspaceSnapshot(workspaceRoot).catch((): string => ''),
    loadProjectInstructions(workspaceRoot).catch((): null => null),
    loadMemory(workspaceRoot).catch((): null => null),
  ]);

  if (snapshot) {
    builder.set('environment', snapshot);
  }
  if (instructions) {
    builder.set(
      'project_context',
      `[PROJECT_INSTRUCTIONS source="${instructions.file}"]\n${instructions.content}\n[/PROJECT_INSTRUCTIONS]`,
    );
  }
  if (memory) {
    builder.set('memory', `[MEMORY]\n${memory}\n[/MEMORY]`);
  }
}

function logPromptBuilderDebug(
  workspaceRoot: string,
  builder: SystemPromptBuilder,
  previousSnapshot?: PromptSnapshot | null,
): void {
  if (!DEBUG_PROMPTS) return;

  const sizes = builder.sizes();
  const metrics = Object.entries(sizes)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  console.error(`[Prompt:${workspaceRoot}] ${metrics}`);

  if (!previousSnapshot) return;
  const diff = formatSnapshotDiff(diffSnapshots(previousSnapshot, builder.snapshot()));
  if (diff) {
    console.error(diff);
  }
}

async function buildEnrichedCliPrompt(
  workspaceRoot: string,
): Promise<{ prompt: string; snapshot: PromptSnapshot }> {
  const builder = buildCliBaseBuilder(workspaceRoot);
  const baseSnapshot = builder.snapshot();
  await enrichCliBuilder(builder, workspaceRoot);
  logPromptBuilderDebug(workspaceRoot, builder, baseSnapshot);
  return {
    prompt: builder.build(),
    snapshot: builder.snapshot(),
  };
}

/**
 * Instant (sync, no I/O) base system prompt — enough to create a session
 * and render the UI without blocking on git or filesystem.
 */
export function buildSystemPromptBase(workspaceRoot: string): string {
  return `${buildCliBaseBuilder(workspaceRoot).build()}\n${NEEDS_ENRICHMENT}`;
}

/**
 * Full system prompt with workspace context (git status, project instructions,
 * memory). Async — requires I/O. Used for enrichment and the legacy sync path.
 */
export async function buildSystemPrompt(workspaceRoot: string): Promise<string> {
  const { prompt } = await buildEnrichedCliPrompt(workspaceRoot);
  return prompt;
}

/**
 * Ensure the system prompt is fully enriched with workspace context.
 * No-op for resumed sessions or already-enriched prompts. Returns the
 * snapshot of the enriched prompt for downstream emission (e.g. the
 * `assistant.prompt_snapshot` run event), or null when no enrichment
 * ran. The promise itself is deduped per-state so concurrent callers
 * see the same outcome.
 *
 * Per-state consume-on-peek storage: the snapshot is also stashed in
 * `_pendingEnrichmentSnapshots` so `consumeEnrichmentSnapshot` can
 * hand it to a single emitter even when multiple `runAssistantLoop`
 * calls concurrently await the same enrichment promise. Without this,
 * each awaiter would receive the same `PromptSnapshot` from the shared
 * promise and emit a duplicate `assistant.prompt_snapshot` event.
 */
const _enrichmentMap: WeakMap<SessionState, Promise<PromptSnapshot | null>> = new WeakMap();
const _pendingEnrichmentSnapshots: WeakMap<SessionState, PromptSnapshot> = new WeakMap();
export function ensureSystemPromptReady(state: SessionState): Promise<PromptSnapshot | null> {
  const sysMsg = (state.messages as Message[])[0];
  if (
    !sysMsg ||
    sysMsg.role !== 'system' ||
    !(sysMsg.content as string).includes(NEEDS_ENRICHMENT)
  ) {
    return Promise.resolve(null);
  }
  if (_enrichmentMap.has(state)) return _enrichmentMap.get(state)!;
  const promise: Promise<PromptSnapshot | null> = buildEnrichedCliPrompt(state.cwd).then(
    ({ prompt, snapshot }: { prompt: string; snapshot: PromptSnapshot }): PromptSnapshot => {
      sysMsg.content = prompt;
      _enrichmentMap.delete(state);
      _pendingEnrichmentSnapshots.set(state, snapshot);
      return snapshot;
    },
  );
  _enrichmentMap.set(state, promise);
  return promise;
}

/**
 * Consume the most recent enrichment snapshot for this state, returning
 * it exactly once. Subsequent calls (and calls for a state whose
 * enrichment hasn't completed yet, or which was already resumed) return
 * null. Used by `runAssistantLoop` to emit `assistant.prompt_snapshot`
 * exactly once per session even when multiple loops concurrently await
 * the same enrichment promise.
 */
export function consumeEnrichmentSnapshot(state: SessionState): PromptSnapshot | null {
  const snap = _pendingEnrichmentSnapshots.get(state);
  if (!snap) return null;
  _pendingEnrichmentSnapshots.delete(state);
  return snap;
}

// ─── Tool Result Messages ────────────────────────────────────────

export function buildToolResultMessage(
  call: ToolCall,
  result: ToolResult,
  metaEnvelope: MetaEnvelope | null = null,
): string {
  const payload: Record<string, unknown> = {
    tool: call.tool,
    ok: result.ok,
    output: result.text,
    meta: result.meta || null,
    structuredError: result.structuredError || null,
  };

  const metaLine: string = metaEnvelope ? `\n[meta] ${JSON.stringify(metaEnvelope)}` : '';
  // Escape across the whole assembled body so metaEnvelope (which can carry
  // attacker-controlled paths/branch names/commit messages) cannot terminate
  // the envelope early either.
  const safeBody = escapeToolResultBoundaries(`${JSON.stringify(payload, null, 2)}${metaLine}`);
  return `[TOOL_RESULT]\n${safeBody}\n[/TOOL_RESULT]`;
}

export function buildParseErrorMessage(malformed: { reason: string; sample: string }[]): string {
  return `[TOOL_CALL_PARSE_ERROR]\n${JSON.stringify(
    {
      reason: 'malformed_tool_call',
      malformed,
      guidance: 'Emit strict JSON fenced blocks: {"tool":"name","args":{...}}',
    },
    null,
    2,
  )}\n[/TOOL_CALL_PARSE_ERROR]`;
}

export function buildMaxRoundsFinalizationMessage(
  maxRounds: number,
  toolsUsed: Iterable<string>,
): string {
  const tools = [...toolsUsed].join(', ') || 'none';
  return `[MAX_ROUNDS_REACHED]
Reached the tool-loop round cap (${maxRounds}). Tools used: ${tools}.

Do not call any more tools. Return a concise plain-text answer using only the information already in this conversation:
- Summarize what you found or changed.
- Be explicit about what may be incomplete.
- Give the next best command or request if more work is needed.
[/MAX_ROUNDS_REACHED]`;
}

export function buildEmptySuccessFinalizationMessage(toolsUsed: Iterable<string>): string {
  const tools = [...toolsUsed].join(', ') || 'none';
  return `[FINAL_SUMMARY_REQUEST]
You signaled completion (no further tool calls), but your final message was empty. Tools used during this run: ${tools}.

Do not call any more tools. Return a concise plain-text summary (no JSON, no fenced blocks) using only the information already in this conversation:
- What you investigated or changed.
- The key finding(s) or outcome(s).
- Any caveats or remaining work.

This summary will be persisted for retrieval by future related runs, so make it self-contained.
[/FINAL_SUMMARY_REQUEST]`;
}

// ─── Main Loop ───────────────────────────────────────────────────

/**
 * Run the assistant loop. Options:
 * - approvalFn: async (tool, detail) => boolean — gate for high-risk operations
 * - signal: AbortSignal — external abort (e.g. Ctrl+C)
 * - emit: (event) => void — callback for streaming events (replaces stdout writing)
 * - runId: string — optional run id override (used by pushd for ack/event correlation)
 */
export async function runAssistantLoop(
  state: SessionState,
  providerConfig: ProviderConfig,
  apiKey: string,
  maxRounds: number,
  options: RunOptions = {},
): Promise<RunResult> {
  const {
    approvalFn,
    askUserFn,
    signal,
    emit,
    runId: providedRunId,
    allowExec,
    safeExecPatterns,
    execMode,
    disabledTools,
    alwaysAllow,
    suppressRunComplete = false,
    suppressEventPersist = false,
  } = options;
  const runId: string = providedRunId || makeRunId();

  // Built once per run — hook callbacks read live state via injected
  // providers (e.g. `getCurrentBranch` is per-call), so the registry
  // doesn't need to be rebuilt as state changes.
  const defaultCliHookRegistry = getDefaultCliHookRegistry();

  async function appendSessionEvent(
    stateArg: SessionState,
    type: string,
    payload: unknown,
    rid: string | null = null,
  ): Promise<void> {
    if (suppressEventPersist) return;
    await appendSessionEventRaw(stateArg, type, payload, rid);
  }

  async function appendRunCompleteEvent(payload: Record<string, unknown>): Promise<void> {
    if (suppressRunComplete) return;
    await appendSessionEvent(state, 'run_complete', payload, runId);
  }
  let finalAssistantText: string = '';
  const repeatedCalls: Map<string, number> = new Map();
  const toolsUsed: Set<string> = new Set();
  // The CLI runs two complementary ledgers per turn:
  //   - promptLedger (cli/file-ledger.ts): owns prompt budgeting, search-hit
  //     relevance, read/write counters. Surfaced in the metaEnvelope so the
  //     model sees its own read budget and recently-touched files.
  //   - awarenessLedger (lib/file-awareness-ledger.ts): owns edit safety —
  //     line-range coverage, read/edit verdicts, model-authored state. Used
  //     to block blind writes/edits on files the model never read.
  const promptLedger: FileLedger = createFileLedger();
  const awarenessLedger = new FileAwarenessLedger({
    readToolName: 'read_file',
    writeToolName: 'write_file',
  });
  let toolExecutionCounter = 0;

  // Lazily enrich system prompt with workspace context (git status,
  // project instructions, memory) if it hasn't been loaded yet.
  // Emit `assistant.prompt_snapshot` exactly once per session when a
  // fresh enrichment ran, so an operator can answer "what went to the
  // CLI orchestrator on this session?" from the run-event journal.
  // Resumed sessions return null here (the prompt is preserved across
  // reload but the snapshot for that build is not reconstructable —
  // skipping emission is preferable to forging a fake hash). The CLI
  // prompt is built once and reused across rounds, so the event is
  // tagged with `round: 0`; per-turn granularity belongs to the web
  // orchestrator where the prompt rebuilds on each round.
  //
  // `consumeEnrichmentSnapshot` returns the snapshot exactly once per
  // state — protects against concurrent `runAssistantLoop` calls for
  // the same state both receiving the same snapshot from the shared
  // enrichment promise and emitting duplicate events.
  await ensureSystemPromptReady(state);
  const enrichmentSnapshot = consumeEnrichmentSnapshot(state);
  if (enrichmentSnapshot) {
    const sysMsg = (state.messages as Message[])[0];
    const totalChars = sysMsg && typeof sysMsg.content === 'string' ? sysMsg.content.length : 0;
    await appendSessionEvent(
      state,
      'assistant.prompt_snapshot',
      { round: 0, role: 'orchestrator', totalChars, sections: enrichmentSnapshot },
      runId,
    );
    dispatchEvent('assistant.prompt_snapshot', {
      round: 0,
      role: 'orchestrator',
      totalChars,
      sections: enrichmentSnapshot,
    });
  }
  // Long-session distillation now runs through the per-round pipeline
  // below (see the `length > 40` clause). state.messages is no longer
  // mutated at session entry — distillation is a per-hop transformation,
  // leaving the canonical transcript append-only so resume-from-disk
  // sees the full history. The append-only invariant is also what makes
  // provider-prefix caching effective: `transformed.cacheBreakpointIndices`
  // is threaded into `streamCompletion` and tagged at the wire boundary
  // in `cli/openai-stream.ts` (OpenRouter only today). Persistence is
  // O(diff): saveSessionState appends new messages to messages.jsonl
  // instead of rewriting state.json's full transcript per round
  // (cli/session-store.ts).

  if (!state.workingMemory || typeof state.workingMemory !== 'object') {
    state.workingMemory = createWorkingMemory();
  }
  let lastInjectedWorkingMemory: WorkingMemory | null = null;
  let lastWorkingMemoryInjectionRound: number | null = null;
  let workingMemoryInjectedThisRound: boolean = false;

  // --- Turn policy layer ---
  const policyRegistry = new TurnPolicyRegistry();
  policyRegistry.register(createCoderPolicy());
  const turnCtx: TurnContext = {
    role: 'coder',
    round: 0,
    maxRounds,
    phase: (state.workingMemory as WorkingMemory)?.currentPhase || undefined,
  };

  function dispatchEvent(type: string, payload: unknown): void {
    if (suppressRunComplete && type === 'run_complete') return;
    if (typeof emit === 'function') {
      emit({
        type,
        payload,
        runId,
        sessionId: state.sessionId,
      });
    }
  }

  function nextToolExecutionId(round: number): string {
    toolExecutionCounter += 1;
    return `${runId}_r${Math.max(0, round - 1)}_${toolExecutionCounter.toString(36)}`;
  }

  function takeWorkingMemoryForInjection(round: number): WorkingMemory | null {
    if (workingMemoryInjectedThisRound) return null;
    const current = state.workingMemory as WorkingMemory;
    const budget = getContextBudget(providerConfig.id, state.model);
    const maxContextChars = Math.max(1, Math.round(budget.targetTokens * 3.5));
    const shouldInject = shouldInjectCoderStateOnToolResult(
      current,
      lastInjectedWorkingMemory,
      round,
      contextChars,
      maxContextChars,
      lastWorkingMemoryInjectionRound,
    );
    if (!shouldInject) return null;
    workingMemoryInjectedThisRound = true;
    lastInjectedWorkingMemory = cloneWorkingMemory(current);
    lastWorkingMemoryInjectionRound = round;
    return current;
  }

  async function executeOneToolCall(
    call: ToolCall,
    round: number,
    includeMemory: boolean = true,
  ): Promise<ToolResult> {
    const toolStart: number = Date.now();
    const executionId = nextToolExecutionId(round);
    const toolSource = call.source || 'sandbox';
    const turnIndex = Math.max(0, round - 1);

    await appendSessionEvent(
      state,
      'tool.execution_start',
      {
        round: turnIndex,
        executionId,
        toolName: call.tool,
        toolSource,
        args: call.args,
      },
      runId,
    );

    dispatchEvent('tool.execution_start', {
      round: turnIndex,
      executionId,
      toolName: call.tool,
      toolSource,
      args: call.args,
    });

    // Awareness guard: block write_file / edit_file before they hit the
    // filesystem if the model hasn't read the target. The synthetic blocked
    // result short-circuits the dispatcher and surfaces the verdict code so
    // the model can recover by reading the file and retrying.
    const awarenessBlock = await awarenessGuardForCall(call, awarenessLedger, state.cwd);
    const rawResult = awarenessBlock
      ? awarenessBlock
      : await executeToolCall(call, state.cwd, {
          // The CLI engine's main loop runs as orchestrator. Required
          // by `executeToolCall`'s kernel-level role check so the
          // capability gate fires unconditionally (audit item #3).
          // Delegated paths (Coder/Explorer/Reviewer in cli/pushd.ts)
          // pass their own role.
          role: 'orchestrator',
          approvalFn,
          askUserFn,
          signal,
          allowExec,
          safeExecPatterns,
          execMode,
          disabledTools,
          alwaysAllow,
          providerId: providerConfig?.id,
          providerApiKey: apiKey,
          runId,
          // Shared PreToolUse hooks (see `lib/default-pre-hooks.ts`).
          // The default CLI registry registers Protect Main; the hook
          // is a no-op until the CLI surfaces an isMainProtected
          // toggle (not exposed today), but the seam is wired so the
          // rule lands by default the moment it does.
          hooks: defaultCliHookRegistry,
          getCurrentBranch: () => readCliCurrentBranch(state.cwd),
        });
    const result: ToolResult = rawResult ?? { ok: false, text: 'Tool returned no result' };
    recordAwarenessFromCall(call, result, awarenessLedger, state.cwd);
    const durationMs: number = Date.now() - toolStart;
    const preview = summarizeToolResultPreview(result.text);

    await appendSessionEvent(
      state,
      'tool.execution_complete',
      {
        round: turnIndex,
        executionId,
        toolName: call.tool,
        toolSource,
        durationMs,
        isError: !result.ok,
        preview,
        text: result.text.slice(0, 500),
        structuredError: result.structuredError || null,
      },
      runId,
    );

    if (call.tool === 'write_file' || call.tool === 'edit_file') {
      const isStale = result.structuredError?.code === 'STALE_WRITE';
      recordWriteFile(state.sessionId, {
        error: !result.ok && !isStale,
        stale: isStale,
      });
    }

    updateFileLedger(promptLedger, call, result);

    dispatchEvent('tool.execution_complete', {
      round: turnIndex,
      executionId,
      toolName: call.tool,
      toolSource,
      durationMs,
      isError: !result.ok,
      preview,
      text: result.text,
      structuredError: result.structuredError || null,
    });

    const injectedWorkingMemory = includeMemory ? takeWorkingMemoryForInjection(round) : null;
    const metaEnvelope: MetaEnvelope = {
      runId,
      round,
      contextChars,
      trimmed: lastTrimResult?.trimmed || false,
      estimatedTokens: lastTrimResult?.afterTokens || 0,
      ledger: getLedgerSummary(promptLedger),
      ...(injectedWorkingMemory ? { workingMemory: injectedWorkingMemory } : {}),
    };

    (state.messages as Message[]).push({
      role: 'user',
      content: buildToolResultMessage(call, result, metaEnvelope),
    });
    toolsUsed.add(call.tool);
    return result;
  }

  let contextChars: number = 0;
  let lastTrimResult: TrimResult | null = null;

  for (let round = 1; round <= maxRounds; round++) {
    const turnIndex = Math.max(0, round - 1);
    resetTurnBudget(promptLedger);
    awarenessLedger.advanceRound();
    workingMemoryInjectedThisRound = false;
    contextChars = (state.messages as Message[]).reduce(
      (sum: number, m: Message) => sum + (typeof m.content === 'string' ? m.content.length : 0),
      0,
    );
    if (signal?.aborted) {
      await saveSessionState(state);
      await appendSessionEvent(
        state,
        'assistant.turn_end',
        { round: turnIndex, outcome: 'aborted' },
        runId,
      );
      await appendRunCompleteEvent({ runId, outcome: 'aborted', summary: 'Aborted by user.' });
      dispatchEvent('assistant.turn_end', { round: turnIndex, outcome: 'aborted' });
      dispatchEvent('run_complete', { outcome: 'aborted', summary: 'Aborted by user.' });
      return { outcome: 'aborted', finalAssistantText: 'Aborted.', rounds: round - 1, runId };
    }

    await appendSessionEvent(state, 'assistant.turn_start', { round: turnIndex }, runId);
    dispatchEvent('assistant.turn_start', { round: turnIndex });

    // Adaptive round-budget check: shrink maxRounds when in-session signals
    // (malformed calls, edit errors) accumulate. Mirrors the web side's
    // computeAdaptiveProfile. Never raises the ceiling — only reduces it.
    // Each rule is one-shot per session, so calling this every round is safe.
    const adaptation = computeAdaptation(state.sessionId, maxRounds);
    if (adaptation.wasAdapted) {
      const previousMaxRounds = maxRounds;
      maxRounds = adaptation.adjustedMaxRounds;
      turnCtx.maxRounds = maxRounds;
      await appendSessionEvent(
        state,
        'harness.adaptation',
        {
          round: turnIndex,
          previousMaxRounds,
          newMaxRounds: maxRounds,
          reasons: adaptation.reasons,
          signals: adaptation.signals,
        },
        runId,
      );
      dispatchEvent('harness.adaptation', {
        round: turnIndex,
        previousMaxRounds,
        newMaxRounds: maxRounds,
        reasons: adaptation.reasons,
      });
      // If the new cap is already exceeded by the current round, exit the
      // loop immediately instead of running one more provider call on a
      // budget we just decided was exhausted.
      if (round > maxRounds) {
        break;
      }
    }

    // Build the per-hop view of state.messages: filter (no-op for CLI) →
    // distill (when triggered) → trim. state.messages itself is never
    // mutated — distillation is a transient compression for this LLM call.
    // The long-session trigger (length > 40) fires on every round, not
    // just round 1, so multi-round runs that started long stay distilled
    // throughout. shouldDistillMidSession layers the smarter token-budget
    // gate on top once the agent has a working-memory plan.
    const beforeDistillCount = (state.messages as Message[]).length;
    const shouldDistill =
      beforeDistillCount > 40 ||
      shouldDistillMidSession(
        state.messages as Message[],
        state.workingMemory as WorkingMemory,
        round,
        providerConfig.id,
        state.model,
      );
    let capturedDistill: DistillResult<Message> | null = null;
    let capturedTrim: TrimResult | null = null;
    // First non-tool-result, non-parse-error user turn — the seed for the
    // `[USER_GOAL]` anchor that gets injected near the tail after
    // compaction. The ordered list of all such turns also feeds the
    // anchor's redirect-detection so `currentWorkingGoal` tracks where
    // the conversation has moved. See `lib/user-goal-anchor.ts` for the
    // format pin.
    const userTurnContents = (state.messages as Message[])
      .filter(
        (m) =>
          m.role === 'user' &&
          !isToolResultMessage(m as { role: string; content: string }) &&
          !isParseErrorMessage(m as { role: string; content: string }),
      )
      .map((m) => (typeof m.content === 'string' ? m.content : ''));
    const firstUserTurnStr = userTurnContents[0] ?? null;
    // v2: prefer a user-owned `.push/goal.md` when present. Falls back to
    // verbatim derivation when the file is absent or unparseable so the
    // anchor still injects on first compaction (auto-seed below catches
    // up on the next turn). Redirect-detection only runs on the fallback —
    // a user-authored goal.md is the source of truth.
    const goalFileAnchor = await loadUserGoalFile(state.cwd);
    const userGoalAnchor =
      goalFileAnchor ??
      deriveUserGoalAnchor({
        firstUserTurn: firstUserTurnStr,
        recentUserTurns: userTurnContents,
      }) ??
      undefined;
    // Session-digest record materialization: scope-filter via `store.list()`
    // narrowed to the sync case. Mirrors `app/src/lib/orchestrator.ts` —
    // the CLI's default memory store is per-process and the digest is only
    // injected when this conversation's compactor fires, so cross-session
    // leakage requires reusing a single CLI process across repos *and*
    // hitting compaction in the second. When `MemoryScope` gets plumbed
    // through CLI session context, narrow the predicate here.
    const cliMemoryStore = getDefaultMemoryStore();
    const cliMemoryListed = cliMemoryStore.list();
    const cliScopedRecords = Array.isArray(cliMemoryListed) ? cliMemoryListed : [];
    const cliContextBudget = getContextBudget(providerConfig.id, state.model);
    const transformed = transformContextBeforeLLM<Message>(state.messages as Message[], {
      surface: 'cli',
      enableFilterVisible: false,
      enableDistillation: shouldDistill,
      distill: (msgs) => {
        const result = distillContext(msgs);
        capturedDistill = result;
        return result;
      },
      manageContext: (msgs) => {
        const result = trimContext(msgs, providerConfig.id, state.model);
        capturedTrim = result;
        return { messages: result.messages, compactionApplied: result.trimmed };
      },
      userGoalAnchor,
      createGoalMessage: (content): Message => ({ role: 'user', content }),
      // Session digest (Hermes item 2). CLI carries `state.workingMemory`
      // (Coder's per-delegation state) which feeds `plan` / `openTasks` /
      // etc into the digest's structured fields. The goal flows from the
      // active user-goal anchor so the digest and anchor agree.
      sessionDigestInputs: {
        records: cliScopedRecords,
        workingMemory: state.workingMemory as WorkingMemory | undefined,
        goal: userGoalAnchor?.currentWorkingGoal ?? userGoalAnchor?.initialAsk,
      },
      createSessionDigestMessage: (content): Message => ({ role: 'user', content }),
      // 85% gateway safety net — last-line-of-defense if `trimContext`
      // overshot. CLI's hard fallback in `applyHardFallback` already fires
      // at 100% (maxTokens); this earlier net catches the case before the
      // provider truncates.
      safetyNet: {
        estimateTokens: (msgs) => estimateContextTokens(msgs as Message[]),
        budget: cliContextBudget.maxTokens,
        threshold: 0.85,
        preserveTail: 4,
      },
    });
    // Cast through the closure-mutable ref. TS narrows `capturedDistill`
    // to its declared null because it doesn't track the synchronous
    // callback assignment; the explicit type assertion restores the
    // possibly-set view.
    const distillResult = capturedDistill as DistillResult<Message> | null;
    const trimResult: TrimResult = (capturedTrim as TrimResult | null) ?? {
      messages: transformed.messages,
      trimmed: false,
      beforeTokens: 0,
      afterTokens: 0,
      removedCount: 0,
    };
    if (distillResult && distillResult.distilled) {
      dispatchEvent('status', {
        source: 'orchestrator',
        phase: 'context_distillation',
        detail: `Round ${round}: history distilled from ${beforeDistillCount} to ${distillResult.messages.length} essential messages.`,
      });
    }
    lastTrimResult = trimResult;
    recordContextTrim(state.sessionId, trimResult);
    if (trimResult.trimmed) {
      dispatchEvent('status', {
        source: 'orchestrator',
        phase: 'context_trimming',
        detail: `${trimResult.beforeTokens} → ${trimResult.afterTokens} tokens (${trimResult.removedCount} msgs removed)`,
      });
    }

    // v2 auto-seed: write `.push/goal.md` once on the first compaction in a
    // session where no file exists yet. Fire-and-forget — the write is
    // best-effort and must not block the LLM call. Idempotent against an
    // existing file via O_EXCL inside `seedUserGoalFile`, so concurrent
    // rounds + double-fires are safe.
    if (transformed.rewriteApplied && !goalFileAnchor && firstUserTurnStr) {
      const digestMsg = transformed.messages.find(
        (m) => typeof m.content === 'string' && m.content.includes('[CONTEXT DIGEST]'),
      );
      const workingGoalSeed =
        digestMsg && typeof digestMsg.content === 'string'
          ? extractDigestBody(digestMsg.content)
          : '';
      void seedUserGoalFile(state.cwd, {
        firstUserTurn: firstUserTurnStr,
        workingGoalSeed,
      }).catch(() => {});
    }

    // After the per-hop transform, refresh the round-scoped metrics that
    // downstream consumers (working-memory pressure check, TUI footer
    // meter) rely on. state.messages is now the full append-only
    // transcript, so deriving these from it would over-report. The
    // canonical signal is the post-transform view that actually goes to
    // the LLM.
    const transformedChars = transformed.messages.reduce(
      (sum: number, m: Message) => sum + (typeof m.content === 'string' ? m.content.length : 0),
      0,
    );
    contextChars = transformedChars;
    state.lastPromptTokens = trimResult.afterTokens || estimateContextTokens(transformed.messages);
    state.lastPromptChars = transformedChars;

    const streamOptions: StreamCompletionOptions = {
      onThinkingToken: emit
        ? (token: string | null): void => {
            if (token === null) {
              dispatchEvent('assistant_thinking_done', {});
              return;
            }
            dispatchEvent('assistant_thinking_token', { text: token });
          }
        : undefined,
      sessionId: state.sessionId,
      cacheBreakpointIndices: transformed.cacheBreakpointIndices,
    };

    let assistantText: string;
    try {
      assertReadyForAssistantTurn(transformed.messages, 'cli/runAssistantLoop');
      assistantText = await streamCompletion(
        providerConfig,
        apiKey,
        state.model,
        transformed.messages,
        (token: string): void => {
          dispatchEvent('assistant_token', { text: token });
        },
        undefined,
        signal,
        streamOptions,
      );
    } catch (err: unknown) {
      const isAbort: boolean =
        (err instanceof Error && err.name === 'AbortError') || (signal?.aborted ?? false);
      if (isAbort) {
        await saveSessionState(state);
        await appendSessionEvent(
          state,
          'assistant.turn_end',
          { round: turnIndex, outcome: 'aborted' },
          runId,
        );
        await appendRunCompleteEvent({ runId, outcome: 'aborted', summary: 'Aborted by user.' });
        dispatchEvent('assistant.turn_end', { round: turnIndex, outcome: 'aborted' });
        dispatchEvent('run_complete', { outcome: 'aborted', summary: 'Aborted by user.' });
        return { outcome: 'aborted', finalAssistantText: 'Aborted.', rounds: round - 1, runId };
      }

      const message: string = err instanceof Error ? err.message : String(err);
      await appendSessionEvent(
        state,
        'error',
        {
          code: 'PROVIDER_ERROR',
          message,
          retryable: true,
        },
        runId,
      );
      dispatchEvent('error', { code: 'PROVIDER_ERROR', message });

      await appendSessionEvent(
        state,
        'assistant.turn_end',
        { round: turnIndex, outcome: 'error' },
        runId,
      );
      await appendRunCompleteEvent({
        runId,
        outcome: 'failed',
        summary: message.slice(0, 500),
      });
      dispatchEvent('assistant.turn_end', { round: turnIndex, outcome: 'error' });
      dispatchEvent('run_complete', { outcome: 'failed', summary: message.slice(0, 500) });
      return { outcome: 'error', finalAssistantText: message, rounds: round - 1, runId };
    }

    finalAssistantText = assistantText.trim();
    (state.messages as Message[]).push({ role: 'assistant', content: assistantText });
    state.rounds += 1;
    turnCtx.round = round;

    // --- Turn policy: afterModelCall evaluation ---
    const policyResult = policyRegistry.evaluateAfterModel(finalAssistantText, turnCtx);
    if (policyResult?.action === 'halt') {
      await appendSessionEvent(
        state,
        'assistant.turn_end',
        { round: turnIndex, outcome: 'error' },
        runId,
      );
      await appendRunCompleteEvent({
        runId,
        outcome: 'failed',
        summary: policyResult.summary,
      });
      await saveSessionState(state);
      dispatchEvent('assistant.turn_end', { round: turnIndex, outcome: 'error' });
      dispatchEvent('run_complete', { outcome: 'failed', summary: policyResult.summary });
      return { outcome: 'error', finalAssistantText: policyResult.summary, rounds: round, runId };
    }
    if (policyResult?.action === 'inject') {
      (state.messages as Message[]).push({ role: 'user', content: policyResult.message });
      dispatchEvent('status', {
        source: 'policy',
        phase: 'correction',
        detail: policyResult.message.slice(0, 100),
      });
      await saveSessionState(state);
      continue;
    }

    const messageId: string = `asst_${Date.now().toString(36)}`;
    await appendSessionEvent(
      state,
      'assistant_done',
      {
        messageId,
      },
      runId,
    );
    dispatchEvent('assistant_done', { messageId });

    const detected: DetectedToolCalls = detectAllToolCalls(assistantText);

    if (detected.malformed.length > 0) {
      // Single source of truth for the malformed report → run-event mapping
      // lives in `buildMalformedToolCallEvents`. Reuse it instead of
      // open-coding the same loop, so a new caller can't drift on
      // preview-slicing or forget to emit a report.
      //
      // Contract change vs. the pre-2026-05 inline loop: the in-process
      // `dispatchEvent` now receives the same 500-char-truncated preview
      // that gets persisted, where it previously received the full
      // `malformed.sample`. Today's consumers (`cli/cli.ts`,
      // `cli/tui.ts`) only display `reason`, so this is harmless. If a
      // future consumer needs the full sample, plumb it through the
      // helper rather than reintroducing a divergent dispatch payload.
      const malformedEvents = buildMalformedToolCallEvents(detected.malformed, turnIndex);
      for (const event of malformedEvents) {
        recordMalformedToolCall(event.reason, state.sessionId);
        await appendSessionEvent(
          state,
          'tool.call_malformed',
          {
            round: event.round,
            reason: event.reason,
            preview: event.preview,
          },
          runId,
        );
        dispatchEvent('tool.call_malformed', {
          round: event.round,
          reason: event.reason,
          preview: event.preview,
        });
      }
      await appendSessionEvent(
        state,
        'warning',
        {
          code: 'MALFORMED_TOOL_CALL',
          count: detected.malformed.length,
          reasons: detected.malformed.map((m: { reason: string }) => m.reason),
        },
        runId,
      );
      dispatchEvent('warning', {
        code: 'MALFORMED_TOOL_CALL',
        message: 'Malformed tool calls detected',
        detail: detected.malformed.map((m: { reason: string }) => m.reason).join(', '),
      });
      (state.messages as Message[]).push({
        role: 'user',
        content: buildParseErrorMessage(detected.malformed),
      });
    }

    const memoryCalls: ToolCall[] = detected.calls.filter(
      (call: ToolCall) => call.tool === 'coder_update_state',
    );
    for (const call of memoryCalls) {
      const updated: WorkingMemory = applyWorkingMemoryUpdateToState(
        state,
        (call.args || {}) as Partial<WorkingMemory>,
        round,
      );
      // Sync phase into turn context for policy gating
      if ('currentPhase' in (call.args || {})) {
        turnCtx.phase = updated.currentPhase || undefined;
      }
      await appendSessionEvent(
        state,
        'working_memory_updated',
        {
          keys: Object.keys(updated),
        },
        runId,
      );
      const injectedWorkingMemory = takeWorkingMemoryForInjection(round);
      (state.messages as Message[]).push({
        role: 'user',
        content: buildToolResultMessage(
          call,
          {
            ok: true,
            text: 'Working memory updated.',
            meta: { workingMemory: updated },
          },
          {
            runId,
            round,
            contextChars,
            trimmed: false,
            estimatedTokens: 0,
            ledger: getLedgerSummary(promptLedger),
            ...(injectedWorkingMemory ? { workingMemory: injectedWorkingMemory } : {}),
          },
        ),
      });
      dispatchEvent('tool_result', {
        source: 'memory',
        toolName: call.tool,
        durationMs: 0,
        isError: false,
        text: 'Working memory updated.',
      });
    }

    const toolCalls: ToolCall[] = detected.calls.filter(
      (call: ToolCall) => call.tool !== 'coder_update_state',
    );

    if (toolCalls.length === 0) {
      if (memoryCalls.length > 0 || detected.malformed.length > 0) {
        await appendSessionEvent(
          state,
          'assistant.turn_end',
          { round: turnIndex, outcome: 'continued' },
          runId,
        );
        dispatchEvent('assistant.turn_end', { round: turnIndex, outcome: 'continued' });
        await saveSessionState(state);
        continue;
      }

      // If the model signaled completion with empty/whitespace-only
      // text (Gemini 3 Flash does this on tasks that finish via
      // tool-call-only rounds), ask for a one-shot summary so the
      // session has a real final answer instead of "" propagating
      // out as the run's outcome. Mirrors the max_rounds
      // finalization pattern below. Failures degrade to the
      // pre-fix behavior (empty finalAssistantText). Only fires
      // when finalAssistantText is empty after trim — "Done." or
      // any non-empty short ack flows through unchanged.
      //
      // Note on assistant_done sequencing (Codex P2 review): the
      // pre-finalization assistant_done at line ~800 has already
      // fired by the time we reach this branch, so consumers think
      // the assistant message ended. Streaming finalization tokens
      // after that without a second assistant_done leaves
      // newline-flush handlers (like the basic CLI's) with the
      // finalization text unterminated. Emit a fresh messageId +
      // assistant_done after the finalization stream resolves so
      // the second message appears as a complete unit. Mirrors the
      // max_rounds finalization at engine.ts:~1376.
      if (!finalAssistantText) {
        // Track the prompt so we can roll it back on any failure path.
        // Without rollback, an orphaned [FINAL_SUMMARY_REQUEST] stays
        // in state.messages, gets persisted via saveSessionState
        // downstream, and biases the next turn's context (the model
        // sees a prompt with no response). Codex P2 review on PR #334.
        const finalizationPrompt = buildEmptySuccessFinalizationMessage(toolsUsed);
        (state.messages as Message[]).push({ role: 'user', content: finalizationPrompt });
        let assistantPushed = false;
        try {
          // Re-apply distillation at finalization on long sessions.
          // Pre-migration the in-place state.messages mutation meant
          // finalization always saw the distilled subset; now we have
          // to ask for it explicitly or trim alone might drop preserved
          // bits like coder_update_state results.
          const finalShouldDistill = (state.messages as Message[]).length > 40;
          const finalTransformed = transformContextBeforeLLM<Message>(state.messages as Message[], {
            surface: 'cli',
            enableFilterVisible: false,
            enableDistillation: finalShouldDistill,
            distill: finalShouldDistill ? distillContext : undefined,
            manageContext: (msgs) => {
              const result = trimContext(msgs, providerConfig.id, state.model);
              return { messages: result.messages, compactionApplied: result.trimmed };
            },
          });
          const finalStreamOptions: StreamCompletionOptions = {
            onThinkingToken: emit
              ? (token: string | null): void => {
                  if (token === null) {
                    dispatchEvent('assistant_thinking_done', {});
                    return;
                  }
                  dispatchEvent('assistant_thinking_token', { text: token });
                }
              : undefined,
            sessionId: state.sessionId,
            cacheBreakpointIndices: finalTransformed.cacheBreakpointIndices,
          };
          const finalizationText = await streamCompletion(
            providerConfig,
            apiKey,
            state.model,
            finalTransformed.messages,
            (token: string): void => {
              dispatchEvent('assistant_token', { text: token });
            },
            undefined,
            signal,
            finalStreamOptions,
          );
          const trimmed = finalizationText.trim();
          if (trimmed) {
            finalAssistantText = trimmed;
            (state.messages as Message[]).push({ role: 'assistant', content: finalizationText });
            assistantPushed = true;
            const finalizationMessageId: string = `asst_${Date.now().toString(36)}`;
            await appendSessionEvent(
              state,
              'assistant_done',
              { messageId: finalizationMessageId },
              runId,
            );
            dispatchEvent('assistant_done', { messageId: finalizationMessageId });
          }
        } catch (err: unknown) {
          // Abort propagates; other failures (provider error, timeout)
          // log and continue with the empty finalAssistantText, which
          // matches pre-Fix-2 behavior.
          const isAbort: boolean =
            (err instanceof Error && err.name === 'AbortError') || (signal?.aborted ?? false);
          if (isAbort) {
            // Roll back the prompt before propagating so the partial
            // state isn't persisted with an orphaned request.
            (state.messages as Message[]).pop();
            throw err;
          }
          const message = err instanceof Error ? err.message : String(err);
          await appendSessionEvent(
            state,
            'warning',
            {
              code: 'EMPTY_SUCCESS_FINALIZATION_FAILED',
              message,
              retryable: true,
            },
            runId,
          );
          dispatchEvent('warning', {
            code: 'EMPTY_SUCCESS_FINALIZATION_FAILED',
            message: `Could not get final summary after empty success: ${message}`,
          });
        }
        // Roll back the orphaned prompt if we never pushed an
        // assistant response (stream returned empty OR stream
        // threw a non-abort error). Pre-fix this prompt persisted
        // in state.messages and polluted future turns.
        if (!assistantPushed) {
          (state.messages as Message[]).pop();
        }
      }

      await appendSessionEvent(
        state,
        'assistant.turn_end',
        { round: turnIndex, outcome: 'completed' },
        runId,
      );
      await appendRunCompleteEvent({
        runId,
        outcome: 'success',
        summary: finalAssistantText.slice(0, 500),
      });
      dispatchEvent('assistant.turn_end', { round: turnIndex, outcome: 'completed' });
      dispatchEvent('run_complete', { outcome: 'success', summary: finalAssistantText });
      return { outcome: 'success', finalAssistantText, rounds: round, runId };
    }

    const callKey: string = JSON.stringify(toolCalls);
    const seen: number = (repeatedCalls.get(callKey) || 0) + 1;
    repeatedCalls.set(callKey, seen);
    if (seen >= 3) {
      const loopText: string = `Detected repeated tool call loop (${toolCalls.map((c: ToolCall) => c.tool).join(', ')}). Stopping run.`;
      (state.messages as Message[]).push({
        role: 'user',
        content: `[TOOL_RESULT]\n{"tool":"tool_loop","ok":false,"output":"${loopText}"}\n[/TOOL_RESULT]`,
      });
      await appendSessionEvent(
        state,
        'error',
        {
          code: 'TOOL_LOOP_DETECTED',
          message: loopText,
          retryable: false,
        },
        runId,
      );
      dispatchEvent('error', { code: 'TOOL_LOOP_DETECTED', message: loopText });
      await appendSessionEvent(
        state,
        'assistant.turn_end',
        { round: turnIndex, outcome: 'error' },
        runId,
      );
      dispatchEvent('assistant.turn_end', { round: turnIndex, outcome: 'error' });
      return { outcome: 'error', finalAssistantText: loopText, rounds: round, runId };
    }

    // --- Per-turn mutation transaction grouping (state machine) ---
    // Walk the ordered tool-call list exactly once so we preserve the
    // model's intended ordering (reads first, then the file-mutation
    // batch, then at most one trailing side-effect). This mirrors the
    // web dispatcher (`detectAllToolCalls` in app/src/lib/tool-dispatch.ts)
    // and the daemon wrapper (`wrapCliDetectAllToolCalls` in cli/pushd.ts)
    // so all three runtimes enforce the same contract.
    //
    //   - `readCalls`: contiguous prefix of read-only calls, parallel
    //   - `fileMutationBatch`: contiguous file mutations (write/edit/undo),
    //     executed sequentially with fail-fast on the first error
    //   - `trailingSideEffect`: at most one trailing side-effecting call
    //     (exec, git_commit, save_memory, etc.)
    //   - `rejectedMutations`: overflow — a second side-effect, a read
    //     emitted after the mutation transaction started, or any call
    //     that arrived after the trailing side-effect. Surfaced as
    //     `MULTI_MUTATION_NOT_ALLOWED` below.
    const readCalls: ToolCall[] = [];
    const fileMutationBatch: ToolCall[] = [];
    let trailingSideEffect: ToolCall | null = null;
    const rejectedMutations: ToolCall[] = [];
    let groupingPhase: 'reads' | 'mutations' | 'done' = 'reads';
    for (const call of toolCalls) {
      const isRead = isReadOnlyToolCall(call);
      const isFileMut = !isRead && isFileMutationToolCall(call);

      if (groupingPhase === 'done') {
        rejectedMutations.push(call);
        continue;
      }

      if (isRead) {
        if (groupingPhase === 'reads') {
          readCalls.push(call);
          continue;
        }
        // Read after the mutation transaction started — ordering
        // violation. Push into rejectedMutations and flip to `done` so
        // remaining calls land there too.
        rejectedMutations.push(call);
        groupingPhase = 'done';
        continue;
      }

      if (isFileMut) {
        groupingPhase = 'mutations';
        fileMutationBatch.push(call);
        continue;
      }

      // Side-effecting call. Only one allowed per turn.
      trailingSideEffect = call;
      groupingPhase = 'done';
    }
    const mutateCalls: ToolCall[] = [
      ...fileMutationBatch,
      ...(trailingSideEffect ? [trailingSideEffect] : []),
    ];

    if (readCalls.length > 0) {
      await Promise.all(
        readCalls.map((call: ToolCall, i: number) =>
          executeOneToolCall(call, round, i === readCalls.length - 1 && mutateCalls.length === 0),
        ),
      );
    }

    if (mutateCalls.length > 0) {
      // Phase-aware tool gating — check before executing the first mutation
      const gateResult = policyRegistry.evaluateBeforeTool(
        mutateCalls[0].tool,
        mutateCalls[0].args || {},
        turnCtx,
      );
      if (gateResult?.action === 'deny') {
        const deniedCall: ToolCall = mutateCalls[0];
        const denialMessage: string = gateResult.reason || 'Tool call denied by policy';
        const deniedResult: ToolResult = {
          ok: false,
          text: denialMessage,
          structuredError: {
            code: 'TOOL_DENIED',
            message: denialMessage,
            retryable: false,
          },
        };

        const executionId = nextToolExecutionId(round);
        const deniedSource = deniedCall.source || 'sandbox';
        const preview = summarizeToolResultPreview(deniedResult.text);

        await appendSessionEvent(
          state,
          'tool.execution_start',
          {
            round: turnIndex,
            executionId,
            toolName: deniedCall.tool,
            toolSource: deniedSource,
            args: deniedCall.args,
          },
          runId,
        );
        dispatchEvent('tool.execution_start', {
          round: turnIndex,
          executionId,
          toolName: deniedCall.tool,
          toolSource: deniedSource,
          args: deniedCall.args,
        });

        await appendSessionEvent(
          state,
          'tool.execution_complete',
          {
            round: turnIndex,
            executionId,
            toolName: deniedCall.tool,
            toolSource: deniedSource,
            durationMs: 0,
            isError: true,
            preview,
            text: deniedResult.text,
            structuredError: deniedResult.structuredError,
          },
          runId,
        );

        const injectedWorkingMemory = takeWorkingMemoryForInjection(round);
        (state.messages as Message[]).push({
          role: 'user',
          content: buildToolResultMessage(deniedCall, deniedResult, {
            runId,
            round,
            contextChars,
            trimmed: false,
            estimatedTokens: 0,
            ledger: getLedgerSummary(promptLedger),
            ...(injectedWorkingMemory ? { workingMemory: injectedWorkingMemory } : {}),
          }),
        });
        toolsUsed.add(deniedCall.tool);
        dispatchEvent('tool.execution_complete', {
          round: turnIndex,
          executionId,
          toolName: deniedCall.tool,
          toolSource: deniedSource,
          durationMs: 0,
          isError: true,
          preview,
          text: deniedResult.text,
        });
        await saveSessionState(state);
        await appendSessionEvent(
          state,
          'assistant.turn_end',
          { round: turnIndex, outcome: 'continued' },
          runId,
        );
        dispatchEvent('assistant.turn_end', { round: turnIndex, outcome: 'continued' });
        continue;
      }

      // Execute the mutation transaction sequentially with fail-fast:
      //   1. Every call in the file-mutation batch (write/edit/undo_edit)
      //   2. The trailing side-effect, if any
      // On the first `ok: false` result we break out so later calls —
      // including any trailing exec/git_commit — don't run against
      // partial or incorrect state. The model still sees the results
      // from the calls that ran (they were appended to state.messages
      // inside executeOneToolCall) and can correct on the next turn.
      // All members share the single before-tool gate check above — if
      // the first call was blocked we already bailed out.
      for (let i = 0; i < mutateCalls.length; i++) {
        const call = mutateCalls[i];
        const isLast = i === mutateCalls.length - 1;
        const mutResult = await executeOneToolCall(call, round, isLast);
        if (!mutResult.ok) {
          // Batch short-circuited — stop here so partial state doesn't
          // propagate into a trailing side-effect.
          break;
        }
      }

      // Overflow side-effects (second exec, commit after exec, etc.) are
      // rejected with a structured error so the model can correct on the
      // next turn. File mutations never land here — they were already
      // executed as part of the batch above.
      for (const call of rejectedMutations) {
        const result: ToolResult = {
          ok: false,
          text: `Skipped side-effecting tool call ${call.tool}: a turn may contain at most one side-effect (exec, commit, save_memory) after the file-mutation batch.`,
          structuredError: {
            code: 'MULTI_MUTATION_NOT_ALLOWED',
            message: 'At most one side-effect tool call allowed per turn',
            retryable: true,
          },
        };

        const executionId = nextToolExecutionId(round);
        const skippedSource = call.source || 'sandbox';
        const preview = summarizeToolResultPreview(result.text);

        await appendSessionEvent(
          state,
          'tool.execution_start',
          {
            round: turnIndex,
            executionId,
            toolName: call.tool,
            toolSource: skippedSource,
            args: call.args,
          },
          runId,
        );
        dispatchEvent('tool.execution_start', {
          round: turnIndex,
          executionId,
          toolName: call.tool,
          toolSource: skippedSource,
          args: call.args,
        });

        await appendSessionEvent(
          state,
          'tool.execution_complete',
          {
            round: turnIndex,
            executionId,
            toolName: call.tool,
            toolSource: skippedSource,
            durationMs: 0,
            isError: true,
            preview,
            text: result.text,
            structuredError: result.structuredError,
          },
          runId,
        );

        const injectedWorkingMemory = takeWorkingMemoryForInjection(round);
        (state.messages as Message[]).push({
          role: 'user',
          content: buildToolResultMessage(call, result, {
            runId,
            round,
            contextChars,
            trimmed: false,
            estimatedTokens: 0,
            ledger: getLedgerSummary(promptLedger),
            ...(injectedWorkingMemory ? { workingMemory: injectedWorkingMemory } : {}),
          }),
        });
        toolsUsed.add(call.tool);
        dispatchEvent('tool.execution_complete', {
          round: turnIndex,
          executionId,
          toolName: call.tool,
          toolSource: skippedSource,
          durationMs: 0,
          isError: true,
          preview,
          text: result.text,
        });
      }
    }

    await appendSessionEvent(
      state,
      'assistant.turn_end',
      { round: turnIndex, outcome: 'continued' },
      runId,
    );
    dispatchEvent('assistant.turn_end', { round: turnIndex, outcome: 'continued' });
    await saveSessionState(state);
  }

  const warning: string = `Reached max rounds (${maxRounds}). Tools used: ${[...toolsUsed].join(', ') || 'none'}.`;
  const finalizationPrompt = buildMaxRoundsFinalizationMessage(maxRounds, toolsUsed);
  (state.messages as Message[]).push({ role: 'user', content: finalizationPrompt });
  await appendSessionEvent(
    state,
    'warning',
    {
      code: 'MAX_ROUNDS_REACHED',
      message: `${warning} Asking the assistant for a final no-tool summary.`,
    },
    runId,
  );
  dispatchEvent('warning', {
    code: 'MAX_ROUNDS_REACHED',
    message: `${warning} Asking for a final summary.`,
  });

  let finalSummaryText = warning;
  try {
    // Re-apply distillation at max-rounds finalization on long sessions.
    // Pre-migration the in-place state.messages mutation meant
    // finalization always saw the distilled subset; now we have to ask
    // for it explicitly or trim alone might drop preserved bits like
    // coder_update_state results.
    const finalShouldDistill = (state.messages as Message[]).length > 40;
    let capturedFinalTrim: TrimResult | null = null;
    const finalTransformed = transformContextBeforeLLM<Message>(state.messages as Message[], {
      surface: 'cli',
      enableFilterVisible: false,
      enableDistillation: finalShouldDistill,
      distill: finalShouldDistill ? distillContext : undefined,
      manageContext: (msgs) => {
        const result = trimContext(msgs, providerConfig.id, state.model);
        capturedFinalTrim = result;
        return { messages: result.messages, compactionApplied: result.trimmed };
      },
    });
    const finalTrimResult = capturedFinalTrim as TrimResult | null;
    if (finalTrimResult && finalTrimResult.trimmed) {
      dispatchEvent('status', {
        source: 'orchestrator',
        phase: 'context_trimming',
        detail: `${finalTrimResult.beforeTokens} → ${finalTrimResult.afterTokens} tokens (${finalTrimResult.removedCount} msgs removed)`,
      });
    }
    const finalStreamOptions: StreamCompletionOptions = {
      onThinkingToken: emit
        ? (token: string | null): void => {
            if (token === null) {
              dispatchEvent('assistant_thinking_done', {});
              return;
            }
            dispatchEvent('assistant_thinking_token', { text: token });
          }
        : undefined,
      sessionId: state.sessionId,
      cacheBreakpointIndices: finalTransformed.cacheBreakpointIndices,
    };
    const assistantText = await streamCompletion(
      providerConfig,
      apiKey,
      state.model,
      finalTransformed.messages,
      (token: string): void => {
        dispatchEvent('assistant_token', { text: token });
      },
      undefined,
      signal,
      finalStreamOptions,
    );
    finalSummaryText = assistantText.trim() || warning;
    (state.messages as Message[]).push({ role: 'assistant', content: assistantText });
    const messageId: string = `asst_${Date.now().toString(36)}`;
    await appendSessionEvent(state, 'assistant_done', { messageId }, runId);
    dispatchEvent('assistant_done', { messageId });
  } catch (err: unknown) {
    const isAbort: boolean =
      (err instanceof Error && err.name === 'AbortError') || (signal?.aborted ?? false);
    if (isAbort) {
      await saveSessionState(state);
      await appendRunCompleteEvent({ runId, outcome: 'aborted', summary: 'Aborted by user.' });
      dispatchEvent('run_complete', { outcome: 'aborted', summary: 'Aborted by user.' });
      return { outcome: 'aborted', finalAssistantText: 'Aborted.', rounds: maxRounds, runId };
    }
    const message = err instanceof Error ? err.message : String(err);
    await appendSessionEvent(
      state,
      'error',
      {
        code: 'MAX_ROUNDS_FINALIZATION_FAILED',
        message,
        retryable: true,
      },
      runId,
    );
    dispatchEvent('warning', {
      code: 'MAX_ROUNDS_FINALIZATION_FAILED',
      message: `Could not get final summary after round cap: ${message}`,
    });
  }

  await saveSessionState(state);
  await appendRunCompleteEvent({
    runId,
    outcome: 'max_rounds',
    summary: finalSummaryText.slice(0, 500),
  });
  dispatchEvent('run_complete', { outcome: 'max_rounds', summary: finalSummaryText });
  return { outcome: 'max_rounds', finalAssistantText: finalSummaryText, rounds: maxRounds, runId };
}

/**
 * Top-level entry for a user turn.
 *
 * Runs the planner unconditionally (planner-decides policy), then routes:
 *   - If the planner returns null or a ≤1-feature plan → fall back to
 *     `runAssistantLoop` on the existing state.messages. Single-agent UX
 *     is preserved exactly — the caller's pre-appended user message is
 *     what drives the loop.
 *   - Otherwise, invokes the task-graph delegation subsystem in
 *     `cli/delegation-entry.ts`, which emits canonical `subagent.*` /
 *     `task_graph.*` events via `options.emit` and appends its own
 *     synthesized final assistant message.
 *
 * Callers must still append the user message to `state.messages` before
 * calling — the fallback path depends on that, and the delegation path
 * leaves it in place as the turn's input of record.
 */
export async function runAssistantTurn(
  state: SessionState,
  providerConfig: ProviderConfig,
  apiKey: string,
  userText: string,
  maxRounds: number,
  options: RunOptions = {},
): Promise<RunResult> {
  const { runUserTurnWithDelegation } = await import('./delegation-entry.js');

  // Mint a stable runId once for the whole turn. Both the planner `subagent.*`
  // envelopes and the fallback `runAssistantLoop` run share it, so consumers
  // keying on runId (event logs, daemon attach clients) see one correlated
  // stream per user turn instead of two disjoint ones split at the planner
  // → fallback boundary.
  const turnRunId = options.runId ?? makeRunId();
  const turnOptions: RunOptions = { ...options, runId: turnRunId };

  const delegationResult = await runUserTurnWithDelegation(
    state,
    providerConfig,
    apiKey,
    userText,
    maxRounds,
    turnOptions,
  );

  if (delegationResult?.delegated && delegationResult.runResult) {
    return delegationResult.runResult as RunResult;
  }

  return runAssistantLoop(state, providerConfig, apiKey, maxRounds, turnOptions);
}
