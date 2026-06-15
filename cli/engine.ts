import process from 'node:process';
import { promises as fs } from 'node:fs';
import nodePath from 'node:path';
import {
  ensureInsideWorkspace,
  getGitHubToolProtocol,
  getGitHubToolProtocolAsync,
  TOOL_PROTOCOL,
} from './tools.js';
import { makeRunId } from './session-store.js';
import { FileAwarenessLedger, type EditGuardVerdict } from '../lib/file-awareness-ledger.js';
import {
  buildWorkspaceSnapshot,
  loadProjectInstructions,
  loadMemory,
} from './workspace-context.js';
import { formatProjectInstructionsBlock } from '../lib/project-instructions.ts';
import { estimateContextTokens, estimateTokens, getContextBudget } from './context-manager.js';
import { type PromptCompositionCost } from '../lib/prompt-cost-telemetry.ts';
import { escapeToolResultBoundaries } from '../lib/untrusted-content.ts';
import {
  SystemPromptBuilder,
  diffSnapshots,
  formatSnapshotDiff,
  type PromptSnapshot,
} from '../lib/system-prompt-builder.ts';
import { type CoderWorkingMemory } from '../lib/working-memory.ts';

import type { SessionState } from './session-store.js';
import type { ProviderConfig } from './provider.js';
import type { Message } from './context-manager.js';

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
  // Opt-out for the Auditor commit gate. Passed raw (not pre-resolved) to
  // `executeToolCall`, where the `git_commit` case resolves it against
  // `PUSH_AUDITOR_GATE` via the shared `lib/auditor-policy.ts` resolver
  // (default on). `undefined` → resolver falls back to env, then the default.
  auditorGate?: boolean;
  // Skip the terminal `run_complete` append + dispatch. Callers that run
  // `runAssistantTurn`/the kernel lane as a sub-step of a larger turn
  // (delegation per-node) set this so the parent scope is the only writer —
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

interface MetaEnvelope {
  runId: string;
  round: number;
  contextChars: number;
  trimmed: boolean;
  estimatedTokens: number;
  ledger: unknown;
  workingMemory?: unknown;
  /** Most-recent SessionDigest emitted by the per-agent context transformer.
   *  Persisted across rounds so the digest accumulates rather than churning
   *  fresh on every compaction. Set by the `onSessionDigestEmitted` hook on
   *  the digest stage; consumed as `priorSessionDigest` on the next round. */
  lastSessionDigest?: unknown;
}

type WorkingMemory = CoderWorkingMemory;

// ─── Constants ───────────────────────────────────────────────────

export const DEFAULT_MAX_ROUNDS: number = 30;

// Absolute ceiling for the tool-loop round budget. The default stays at 30 as a
// gentle circuit breaker, but big-refactor / long-running sessions can opt into
// more — either explicitly via `--max-rounds`, or implicitly when the adaptive
// harness extends the budget on healthy progress (see harness-adaptation.ts).
// This is the runaway backstop, not the everyday cap.
export const MAX_ALLOWED_ROUNDS: number = 200;

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
  const builder = new SystemPromptBuilder()
    .set('identity', buildCliIdentity(workspaceRoot))
    .set('guidelines', buildCliGuidelines())
    .set('tool_instructions', TOOL_PROTOCOL);
  // Advertise GitHub tools when an env token is configured. This is the
  // instant (sync) base prompt; the async enrichment step
  // (`enrichCliBuilder`) re-checks via the full token chain (incl. `gh auth
  // token`), so a gh-only user still gets the tools in the prompt that
  // reaches the model. Own section so the schema-version marker stays on the
  // core protocol.
  const githubProtocol = getGitHubToolProtocol();
  if (githubProtocol) {
    builder.set('github_tool_instructions', githubProtocol);
  }
  return builder;
}

async function enrichCliBuilder(
  builder: SystemPromptBuilder,
  workspaceRoot: string,
): Promise<void> {
  const [snapshot, instructions, memory, githubProtocol] = await Promise.all([
    buildWorkspaceSnapshot(workspaceRoot).catch((): string => ''),
    loadProjectInstructions(workspaceRoot).catch((): null => null),
    loadMemory(workspaceRoot).catch((): null => null),
    // Authoritative GitHub advertise-time check — honors the `gh auth token`
    // fallback, not just env vars, so gh-only auth surfaces the tools in the
    // enriched prompt. Best-effort: a `gh` spawn failure degrades to no
    // GitHub section rather than failing prompt construction.
    getGitHubToolProtocolAsync().catch((): string => ''),
  ]);

  if (snapshot) {
    builder.set('environment', snapshot);
  }
  // Set (or clear) the GitHub section based on the full token resolution. The
  // sync base builder may have set it from an env token; if the full check now
  // disagrees (neither env nor gh), remove it so we don't advertise unusable
  // tools. When gh supplies a token the env check missed, this adds it.
  if (githubProtocol) {
    builder.set('github_tool_instructions', githubProtocol);
  } else {
    builder.remove('github_tool_instructions');
  }
  if (instructions) {
    builder.set(
      'project_context',
      formatProjectInstructionsBlock(instructions.content, { source: instructions.file }),
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
): Promise<{ prompt: string; snapshot: PromptSnapshot; cost: PromptCompositionCost }> {
  const builder = buildCliBaseBuilder(workspaceRoot);
  const baseSnapshot = builder.snapshot();
  await enrichCliBuilder(builder, workspaceRoot);
  logPromptBuilderDebug(workspaceRoot, builder, baseSnapshot);
  const prompt = builder.build();
  // Isolate the cost of the two always-injected blocks the schema-deferral
  // decision (Claude Code In-App Patterns §5) is weighing. Read the section
  // text straight off the builder — cleaner than the web side's marker
  // extraction, which has to recover the project block from a composite
  // environment section. The CLI prompt is built once per run, so this cost is
  // run-level (emitted with round 0).
  const githubText = builder.get('github_tool_instructions') ?? '';
  const projectText = builder.get('project_context') ?? '';
  const cost: PromptCompositionCost = {
    systemPromptBytes: prompt.length,
    githubProtocolBytes: githubText.length,
    projectInstructionsBytes: projectText.length,
    systemPromptTokens: estimateTokens(prompt),
    githubProtocolTokens: githubText ? estimateTokens(githubText) : 0,
    projectInstructionsTokens: projectText ? estimateTokens(projectText) : 0,
  };
  return { prompt, snapshot: builder.snapshot(), cost };
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
 * Per-state consume-on-peek storage: the enrichment result is also stashed in
 * `_pendingEnrichment` so `consumeEnrichment` can hand it to a single emitter
 * even when concurrent `runAssistantTurn`/kernel-lane callers await the same
 * enrichment promise. Without this, each awaiter would receive the same result
 * from the shared promise and emit a duplicate `assistant.prompt_snapshot`
 * event.
 */
const _enrichmentMap: WeakMap<SessionState, Promise<PromptSnapshot | null>> = new WeakMap();

/**
 * One carrier for all per-enrichment metadata consumed once per fresh build.
 * The snapshot carries section sizes/hashes; the cost carries the per-section
 * byte/token breakdown (which can't be recovered from the snapshot, since it
 * holds sizes but not the section text). Both ride together so a new datum
 * extends this shape rather than spawning another parallel WeakMap.
 */
export interface PendingEnrichment {
  snapshot: PromptSnapshot;
  cost: PromptCompositionCost;
}
const _pendingEnrichment: WeakMap<SessionState, PendingEnrichment> = new WeakMap();

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
    ({
      prompt,
      snapshot,
      cost,
    }: {
      prompt: string;
      snapshot: PromptSnapshot;
      cost: PromptCompositionCost;
    }): PromptSnapshot => {
      sysMsg.content = prompt;
      _enrichmentMap.delete(state);
      _pendingEnrichment.set(state, { snapshot, cost });
      return snapshot;
    },
  );
  _enrichmentMap.set(state, promise);
  return promise;
}

/**
 * Consume the most recent enrichment result for this state, returning it
 * exactly once. Subsequent calls (and calls for a state whose enrichment
 * hasn't completed yet, or which was already resumed) return null. Used by
 * `runAssistantTurn`/the kernel lane to emit `assistant.prompt_snapshot` and
 * `prompt_composition_cost` exactly once per session — even when multiple
 * callers concurrently await the same enrichment promise, only the first peek
 * gets the result, so the events are never double-counted.
 */
export function consumeEnrichment(state: SessionState): PendingEnrichment | null {
  const pending = _pendingEnrichment.get(state);
  if (!pending) return null;
  _pendingEnrichment.delete(state);
  return pending;
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

// ─── Turn Entrypoint ─────────────────────────────────────────────

/**
 * Top-level entry for a user turn.
 *
 * Runs the single conversational lead directly (Agent Runtime Decisions
 * §10) — no Planner pre-pass, no task-graph wrapper. The lead turn runs on
 * the shared coder kernel (`leadMode`). See the routing below.
 *
 * Callers must append the user message to `state.messages` before calling
 * — the run reads it as the turn's input of record.
 */
export async function runAssistantTurn(
  state: SessionState,
  providerConfig: ProviderConfig,
  apiKey: string,
  userText: string,
  maxRounds: number,
  options: RunOptions = {},
): Promise<RunResult> {
  // Mint a stable runId once for the whole turn so consumers keying on runId
  // (event logs, daemon attach clients) see one correlated stream per turn.
  const turnRunId = options.runId ?? makeRunId();
  const turnOptions: RunOptions = { ...options, runId: turnRunId };

  // Single conversational lead is the only turn shape (Agent Runtime Decisions
  // §10): the turn runs on the shared coder kernel (`leadMode`) — same kernel +
  // lead framing as the web's inline lane, with the CLI's local tool reach. No
  // Planner pre-pass, no subagent ceremony, one agent the user talks to. (The
  // Planner-driven `--delegate` spike and the CLI-local engine loop's
  // `PUSH_LEAD_RUNTIME=engine` opt-out were both retired once the lane baked.)
  const { runLeadKernelTurn } = await import('./lead-turn.js');
  return runLeadKernelTurn(state, providerConfig, apiKey, userText, maxRounds, turnOptions);
}
