import process from 'node:process';
import {
  detectAllToolCalls,
  executeToolCall,
  isFileMutationToolCall,
  isReadOnlyToolCall,
  truncateText,
  TOOL_PROTOCOL,
} from './tools.js';
import { appendSessionEvent, saveSessionState, makeRunId } from './session-store.js';
import { streamCompletion } from './provider.js';
import {
  createFileLedger,
  getLedgerSummary,
  updateFileLedger,
  resetTurnBudget,
} from './file-ledger.js';
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
} from './context-manager.js';
import { TurnPolicyRegistry, createCoderPolicy } from './turn-policy.js';
import { summarizeToolResultPreview } from '../lib/run-events.ts';
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
 * No-op for resumed sessions or already-enriched prompts.
 * Returns the enrichment promise (safe to call multiple times — deduped per state).
 */
const _enrichmentMap: WeakMap<SessionState, Promise<void>> = new WeakMap();
export function ensureSystemPromptReady(state: SessionState): Promise<void> {
  const sysMsg = (state.messages as Message[])[0];
  if (
    !sysMsg ||
    sysMsg.role !== 'system' ||
    !(sysMsg.content as string).includes(NEEDS_ENRICHMENT)
  ) {
    return Promise.resolve();
  }
  if (_enrichmentMap.has(state)) return _enrichmentMap.get(state)!;
  const promise: Promise<void> = buildEnrichedCliPrompt(state.cwd).then(
    ({ prompt }: { prompt: string; snapshot: PromptSnapshot }): void => {
      sysMsg.content = prompt;
      _enrichmentMap.delete(state);
    },
  );
  _enrichmentMap.set(state, promise);
  return promise;
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
  return `[TOOL_RESULT]\n${JSON.stringify(payload, null, 2)}${metaLine}\n[/TOOL_RESULT]`;
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
  } = options;
  const runId: string = providedRunId || makeRunId();
  let finalAssistantText: string = '';
  const repeatedCalls: Map<string, number> = new Map();
  const toolsUsed: Set<string> = new Set();
  const fileLedger: FileLedger = createFileLedger();
  let toolExecutionCounter = 0;

  // Lazily enrich system prompt with workspace context (git status,
  // project instructions, memory) if it hasn't been loaded yet.
  await ensureSystemPromptReady(state);
  // Surgical context distillation for long sessions: reduce history to essentials
  // if starting a new run with significant history.
  if ((state.messages as Message[]).length > 40) {
    state.messages = distillContext(state.messages as Message[]) as any;
    dispatchEvent('status', {
      source: 'orchestrator',
      phase: 'context_distillation',
      detail: `History distilled to ${(state.messages as Message[]).length} essential messages.`,
    });
  }

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

    const rawResult = await executeToolCall(call, state.cwd, {
      approvalFn,
      askUserFn,
      signal,
      allowExec,
      safeExecPatterns,
      execMode,
      providerId: providerConfig?.id,
      providerApiKey: apiKey,
    });
    const result: ToolResult = rawResult ?? { ok: false, text: 'Tool returned no result' };
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

    updateFileLedger(fileLedger, call, result);

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
      ledger: getLedgerSummary(fileLedger),
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
    resetTurnBudget(fileLedger);
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
      await appendSessionEvent(
        state,
        'run_complete',
        { runId, outcome: 'aborted', summary: 'Aborted by user.' },
        runId,
      );
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

    // Trim context to fit provider budget (state.messages is never mutated)
    if (
      shouldDistillMidSession(
        state.messages as Message[],
        state.workingMemory as WorkingMemory,
        round,
        providerConfig.id,
        state.model,
      )
    ) {
      const beforeCount = (state.messages as Message[]).length;
      state.messages = distillContext(state.messages as Message[]) as any;
      if ((state.messages as Message[]).length < beforeCount) {
        dispatchEvent('status', {
          source: 'orchestrator',
          phase: 'context_distillation',
          detail: `Round ${round}: history distilled from ${beforeCount} to ${(state.messages as Message[]).length} essential messages.`,
        });
      }
    }

    const trimResult: TrimResult = trimContext(
      state.messages as Message[],
      providerConfig.id,
      state.model,
    );
    lastTrimResult = trimResult;
    recordContextTrim(state.sessionId, trimResult);
    if (trimResult.trimmed) {
      dispatchEvent('status', {
        source: 'orchestrator',
        phase: 'context_trimming',
        detail: `${trimResult.beforeTokens} → ${trimResult.afterTokens} tokens (${trimResult.removedCount} msgs removed)`,
      });
    }

    const streamOptions: { onThinkingToken?: (token: string | null) => void; sessionId?: string } =
      {
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
      };

    let assistantText: string;
    try {
      assistantText = await streamCompletion(
        providerConfig,
        apiKey,
        state.model,
        trimResult.messages,
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
        await appendSessionEvent(
          state,
          'run_complete',
          { runId, outcome: 'aborted', summary: 'Aborted by user.' },
          runId,
        );
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
      await appendSessionEvent(
        state,
        'run_complete',
        {
          runId,
          outcome: 'failed',
          summary: message.slice(0, 500),
        },
        runId,
      );
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
      await appendSessionEvent(
        state,
        'run_complete',
        {
          runId,
          outcome: 'failed',
          summary: policyResult.summary,
        },
        runId,
      );
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
      for (const malformed of detected.malformed) {
        recordMalformedToolCall(malformed.reason, state.sessionId);
        await appendSessionEvent(
          state,
          'tool.call_malformed',
          {
            round: turnIndex,
            reason: malformed.reason,
            preview: malformed.sample.slice(0, 500),
          },
          runId,
        );
        dispatchEvent('tool.call_malformed', {
          round: turnIndex,
          reason: malformed.reason,
          preview: malformed.sample,
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
            ledger: getLedgerSummary(fileLedger),
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
          const finalTrimResult = trimContext(
            state.messages as Message[],
            providerConfig.id,
            state.model,
          );
          const finalStreamOptions: {
            onThinkingToken?: (token: string | null) => void;
            sessionId?: string;
          } = {
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
          };
          const finalizationText = await streamCompletion(
            providerConfig,
            apiKey,
            state.model,
            finalTrimResult.messages,
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
      await appendSessionEvent(
        state,
        'run_complete',
        {
          runId,
          outcome: 'success',
          summary: finalAssistantText.slice(0, 500),
        },
        runId,
      );
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
            ledger: getLedgerSummary(fileLedger),
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
            ledger: getLedgerSummary(fileLedger),
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
    const finalTrimResult = trimContext(
      state.messages as Message[],
      providerConfig.id,
      state.model,
    );
    if (finalTrimResult.trimmed) {
      dispatchEvent('status', {
        source: 'orchestrator',
        phase: 'context_trimming',
        detail: `${finalTrimResult.beforeTokens} → ${finalTrimResult.afterTokens} tokens (${finalTrimResult.removedCount} msgs removed)`,
      });
    }
    const finalStreamOptions: {
      onThinkingToken?: (token: string | null) => void;
      sessionId?: string;
    } = {
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
    };
    const assistantText = await streamCompletion(
      providerConfig,
      apiKey,
      state.model,
      finalTrimResult.messages,
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
      await appendSessionEvent(
        state,
        'run_complete',
        { runId, outcome: 'aborted', summary: 'Aborted by user.' },
        runId,
      );
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
  await appendSessionEvent(
    state,
    'run_complete',
    {
      runId,
      outcome: 'max_rounds',
      summary: finalSummaryText.slice(0, 500),
    },
    runId,
  );
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

  const delegationResult = await runUserTurnWithDelegation(
    state,
    providerConfig,
    apiKey,
    userText,
    maxRounds,
    options,
  );

  if (delegationResult?.delegated && delegationResult.runResult) {
    return delegationResult.runResult as RunResult;
  }

  return runAssistantLoop(state, providerConfig, apiKey, maxRounds, options);
}
