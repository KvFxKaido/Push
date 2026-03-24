import process from 'node:process';
import { detectAllToolCalls, executeToolCall, isReadOnlyToolCall, truncateText, TOOL_PROTOCOL } from './tools.js';
import { appendSessionEvent, saveSessionState, makeRunId } from './session-store.js';
import { streamCompletion } from './provider.js';
import { createFileLedger, getLedgerSummary, updateFileLedger } from './file-ledger.js';
import { recordMalformedToolCall } from './tool-call-metrics.js';
import { buildWorkspaceSnapshot, loadProjectInstructions, loadMemory } from './workspace-context.js';
import { trimContext, distillContext } from './context-manager.js';

import type { SessionState } from './session-store.js';
import type { ProviderConfig } from './provider.js';
import type { Message, TrimResult } from './context-manager.js';
import type { FileLedger } from './file-ledger.js';

// ─── Interfaces ──────────────────────────────────────────────────

export interface WorkingMemory {
  plan: string;
  openTasks: string[];
  filesTouched: string[];
  assumptions: string[];
  errorsEncountered: string[];
  currentPhase: string;
  completedPhases: string[];
}

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

// ─── Constants ───────────────────────────────────────────────────

export const DEFAULT_MAX_ROUNDS: number = 8;

// Sentinel appended to the base prompt — signals that workspace context
// (git status, project instructions, memory) still needs to be loaded.
const NEEDS_ENRICHMENT: string = '[WORKSPACE_PENDING]';

// ─── Working Memory ──────────────────────────────────────────────

function createWorkingMemory(): WorkingMemory {
  return {
    plan: '',
    openTasks: [],
    filesTouched: [],
    assumptions: [],
    errorsEncountered: [],
    currentPhase: '',
    completedPhases: [],
  };
}

function uniqueStrings(values: unknown[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values || []) {
    if (typeof value !== 'string') continue;
    const trimmed: string = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function applyWorkingMemoryUpdate(state: SessionState, args: Partial<WorkingMemory>): WorkingMemory {
  if (!state.workingMemory || typeof state.workingMemory !== 'object') {
    state.workingMemory = createWorkingMemory();
  }

  const mem = state.workingMemory as WorkingMemory;
  if (typeof args.plan === 'string') mem.plan = args.plan;
  if (Array.isArray(args.openTasks)) mem.openTasks = uniqueStrings(args.openTasks);
  if (Array.isArray(args.filesTouched)) mem.filesTouched = uniqueStrings(args.filesTouched);
  if (Array.isArray(args.assumptions)) mem.assumptions = uniqueStrings(args.assumptions);
  if (Array.isArray(args.errorsEncountered)) mem.errorsEncountered = uniqueStrings(args.errorsEncountered);
  if (typeof args.currentPhase === 'string') mem.currentPhase = args.currentPhase;
  if (Array.isArray(args.completedPhases)) mem.completedPhases = uniqueStrings(args.completedPhases);

  return mem;
}

// ─── System Prompt ───────────────────────────────────────────────

/**
 * Instant (sync, no I/O) base system prompt — enough to create a session
 * and render the UI without blocking on git or filesystem.
 */
export function buildSystemPromptBase(workspaceRoot: string): string {
  const explainBlock: string = process.env.PUSH_EXPLAIN_MODE === 'true'
    ? `\nExplain mode is active. After each significant action, add a brief [explain] note (2–3 lines) describing the pattern or architectural convention at play — not what you just did, but why this approach fits the codebase. Focus on patterns the user can recognize next time (e.g. "this follows the hook factory pattern used across all provider configs" or "edit expressed as hashline ops to avoid line-number drift"). Keep it concise and skip it for trivial changes.\n`
    : '';

  return `You are a coding assistant running in a local workspace.
Workspace root: ${workspaceRoot}

You can read files, run commands, and write files using tools.
Use tools for facts; do not invent file contents or command outputs.
If the user's message does not require reading files or running commands, respond directly without tool calls.
Each tool-loop round is expensive — plan before acting, batch related reads, and avoid exploratory browsing unless the user asks for it.
Use coder_update_state to keep a concise working plan; it is persisted and reinjected.
Use save_memory to persist learnings across sessions (build commands, project patterns, conventions).
${explainBlock}
${TOOL_PROTOCOL}
${NEEDS_ENRICHMENT}`;
}

/**
 * Full system prompt with workspace context (git status, project instructions,
 * memory). Async — requires I/O. Used for enrichment and the legacy sync path.
 */
export async function buildSystemPrompt(workspaceRoot: string): Promise<string> {
  let prompt: string = buildSystemPromptBase(workspaceRoot).replace(NEEDS_ENRICHMENT, '');

  const [snapshot, instructions, memory] = await Promise.all([
    buildWorkspaceSnapshot(workspaceRoot).catch((): string => ''),
    loadProjectInstructions(workspaceRoot).catch((): null => null),
    loadMemory(workspaceRoot).catch((): null => null),
  ]);

  if (snapshot) {
    prompt += `\n\n${snapshot}`;
  }

  if (instructions) {
    prompt += `\n\n[PROJECT_INSTRUCTIONS source="${instructions.file}"]\n${instructions.content}\n[/PROJECT_INSTRUCTIONS]`;
  }

  if (memory) {
    prompt += `\n\n[MEMORY]\n${memory}\n[/MEMORY]`;
  }

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
  if (!sysMsg || sysMsg.role !== 'system' || !(sysMsg.content as string).includes(NEEDS_ENRICHMENT)) {
    return Promise.resolve();
  }
  if (_enrichmentMap.has(state)) return _enrichmentMap.get(state)!;
  const promise: Promise<void> = buildSystemPrompt(state.cwd).then((enriched: string): void => {
    sysMsg.content = enriched;
    _enrichmentMap.delete(state);
  });
  _enrichmentMap.set(state, promise);
  return promise;
}

// ─── Tool Result Messages ────────────────────────────────────────

export function buildToolResultMessage(call: ToolCall, result: ToolResult, metaEnvelope: MetaEnvelope | null = null): string {
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

function buildParseErrorMessage(malformed: { reason: string; sample: string }[]): string {
  return `[TOOL_CALL_PARSE_ERROR]\n${JSON.stringify({
    reason: 'malformed_tool_call',
    malformed,
    guidance: 'Emit strict JSON fenced blocks: {"tool":"name","args":{...}}',
  }, null, 2)}\n[/TOOL_CALL_PARSE_ERROR]`;
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
  const { approvalFn, askUserFn, signal, emit, runId: providedRunId, allowExec, safeExecPatterns, execMode } = options;
  const runId: string = providedRunId || makeRunId();
  let finalAssistantText: string = '';
  const repeatedCalls: Map<string, number> = new Map();
  const toolsUsed: Set<string> = new Set();
  const fileLedger: FileLedger = createFileLedger();

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

  async function executeOneToolCall(call: ToolCall, round: number, includeMemory: boolean = true): Promise<ToolResult> {
    const toolStart: number = Date.now();
    await appendSessionEvent(state, 'tool_call', {
      source: 'sandbox',
      toolName: call.tool,
      args: call.args,
    }, runId);

    dispatchEvent('tool_call', {
      source: 'sandbox',
      toolName: call.tool,
      args: call.args,
    });

    const result: ToolResult = await executeToolCall(call, state.cwd, {
      approvalFn,
      askUserFn,
      signal,
      allowExec,
      safeExecPatterns,
      execMode,
      providerId: providerConfig?.id,
      providerApiKey: apiKey,
    });
    const durationMs: number = Date.now() - toolStart;

    await appendSessionEvent(state, 'tool_result', {
      source: 'sandbox',
      toolName: call.tool,
      durationMs,
      isError: !result.ok,
      text: result.text.slice(0, 500),
      structuredError: result.structuredError || null,
    }, runId);

    updateFileLedger(fileLedger, call, result);

    dispatchEvent('tool_result', {
      source: 'sandbox',
      toolName: call.tool,
      durationMs,
      isError: !result.ok,
      text: result.text,
      structuredError: result.structuredError || null,
    });

    const metaEnvelope: MetaEnvelope = {
      runId,
      round,
      contextChars,
      trimmed: lastTrimResult?.trimmed || false,
      estimatedTokens: lastTrimResult?.afterTokens || 0,
      ledger: getLedgerSummary(fileLedger),
      ...(includeMemory ? { workingMemory: state.workingMemory } : {}),
    };

    (state.messages as Message[]).push({ role: 'user', content: buildToolResultMessage(call, result, metaEnvelope) });
    toolsUsed.add(call.tool);
    return result;
  }

  let contextChars: number = 0;
  let lastTrimResult: TrimResult | null = null;

  for (let round = 1; round <= maxRounds; round++) {
    contextChars = (state.messages as Message[]).reduce(
      (sum: number, m: Message) => sum + (typeof m.content === 'string' ? m.content.length : 0),
      0,
    );
    if (signal?.aborted) {
      await saveSessionState(state);
      await appendSessionEvent(state, 'run_complete', { runId, outcome: 'aborted', summary: 'Aborted by user.' }, runId);
      dispatchEvent('run_complete', { outcome: 'aborted', summary: 'Aborted by user.' });
      return { outcome: 'aborted', finalAssistantText: 'Aborted.', rounds: round - 1, runId };
    }

    // Trim context to fit provider budget (state.messages is never mutated)
    if (round > 4 && (state.workingMemory as WorkingMemory)?.plan?.trim()) {
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

    const trimResult: TrimResult = trimContext(state.messages as Message[], providerConfig.id, state.model);
    lastTrimResult = trimResult;
    if (trimResult.trimmed) {
      dispatchEvent('status', {
        source: 'orchestrator',
        phase: 'context_trimming',
        detail: `${trimResult.beforeTokens} → ${trimResult.afterTokens} tokens (${trimResult.removedCount} msgs removed)`,
      });
    }

    const streamOptions: { onThinkingToken?: (token: string | null) => void } = {
      onThinkingToken: emit ? (token: string | null): void => {
        if (token === null) {
          dispatchEvent('assistant_thinking_done', {});
          return;
        }
        dispatchEvent('assistant_thinking_token', { text: token });
      } : undefined,
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
      const isAbort: boolean = (err instanceof Error && err.name === 'AbortError') || (signal?.aborted ?? false);
      if (isAbort) {
        await saveSessionState(state);
        await appendSessionEvent(state, 'run_complete', { runId, outcome: 'aborted', summary: 'Aborted by user.' }, runId);
        dispatchEvent('run_complete', { outcome: 'aborted', summary: 'Aborted by user.' });
        return { outcome: 'aborted', finalAssistantText: 'Aborted.', rounds: round - 1, runId };
      }

      const message: string = err instanceof Error ? err.message : String(err);
      await appendSessionEvent(state, 'error', {
        code: 'PROVIDER_ERROR',
        message,
        retryable: true,
      }, runId);
      dispatchEvent('error', { code: 'PROVIDER_ERROR', message });

      await appendSessionEvent(state, 'run_complete', {
        runId,
        outcome: 'failed',
        summary: message.slice(0, 500),
      }, runId);
      dispatchEvent('run_complete', { outcome: 'failed', summary: message.slice(0, 500) });
      return { outcome: 'error', finalAssistantText: message, rounds: round - 1, runId };
    }

    finalAssistantText = assistantText.trim();
    (state.messages as Message[]).push({ role: 'assistant', content: assistantText });
    state.rounds += 1;

    const messageId: string = `asst_${Date.now().toString(36)}`;
    await appendSessionEvent(state, 'assistant_done', {
      messageId,
    }, runId);
    dispatchEvent('assistant_done', { messageId });

    const detected: DetectedToolCalls = detectAllToolCalls(assistantText);

    if (detected.malformed.length > 0) {
      for (const malformed of detected.malformed) {
        recordMalformedToolCall(malformed.reason);
      }
      await appendSessionEvent(state, 'warning', {
        code: 'MALFORMED_TOOL_CALL',
        count: detected.malformed.length,
        reasons: detected.malformed.map((m: { reason: string }) => m.reason),
      }, runId);
      dispatchEvent('warning', {
        code: 'MALFORMED_TOOL_CALL',
        message: 'Malformed tool calls detected',
        detail: detected.malformed.map((m: { reason: string }) => m.reason).join(', '),
      });
      (state.messages as Message[]).push({ role: 'user', content: buildParseErrorMessage(detected.malformed) });
    }

    const memoryCalls: ToolCall[] = detected.calls.filter((call: ToolCall) => call.tool === 'coder_update_state');
    for (const call of memoryCalls) {
      const updated: WorkingMemory = applyWorkingMemoryUpdate(state, (call.args || {}) as Partial<WorkingMemory>);
      await appendSessionEvent(state, 'working_memory_updated', {
        keys: Object.keys(updated),
      }, runId);
      (state.messages as Message[]).push({
        role: 'user',
        content: buildToolResultMessage(
          call,
          {
            ok: true,
            text: 'Working memory updated.',
            meta: { workingMemory: updated },
          },
          { runId, round, contextChars, trimmed: false, estimatedTokens: 0, ledger: getLedgerSummary(fileLedger), workingMemory: updated },
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

    const toolCalls: ToolCall[] = detected.calls.filter((call: ToolCall) => call.tool !== 'coder_update_state');

    if (toolCalls.length === 0) {
      if (memoryCalls.length > 0 || detected.malformed.length > 0) {
        await saveSessionState(state);
        continue;
      }
      await appendSessionEvent(state, 'run_complete', {
        runId,
        outcome: 'success',
        summary: finalAssistantText.slice(0, 500),
      }, runId);
      dispatchEvent('run_complete', { outcome: 'success', summary: finalAssistantText });
      return { outcome: 'success', finalAssistantText, rounds: round, runId };
    }

    const callKey: string = JSON.stringify(toolCalls);
    const seen: number = (repeatedCalls.get(callKey) || 0) + 1;
    repeatedCalls.set(callKey, seen);
    if (seen >= 3) {
      const loopText: string = `Detected repeated tool call loop (${toolCalls.map((c: ToolCall) => c.tool).join(', ')}). Stopping run.`;
      (state.messages as Message[]).push({ role: 'user', content: `[TOOL_RESULT]\n{"tool":"tool_loop","ok":false,"output":"${loopText}"}\n[/TOOL_RESULT]` });
      await appendSessionEvent(state, 'error', {
        code: 'TOOL_LOOP_DETECTED',
        message: loopText,
        retryable: false,
      }, runId);
      dispatchEvent('error', { code: 'TOOL_LOOP_DETECTED', message: loopText });
      return { outcome: 'error', finalAssistantText: loopText, rounds: round, runId };
    }

    const readCalls: ToolCall[] = toolCalls.filter(isReadOnlyToolCall);
    const mutateCalls: ToolCall[] = toolCalls.filter((call: ToolCall) => !isReadOnlyToolCall(call));

    if (readCalls.length > 0) {
      await Promise.all(readCalls.map((call: ToolCall, i: number) =>
        executeOneToolCall(call, round, i === readCalls.length - 1 && mutateCalls.length === 0)
      ));
    }

    if (mutateCalls.length > 0) {
      await executeOneToolCall(mutateCalls[0], round, true);

      for (let i = 1; i < mutateCalls.length; i++) {
        const call: ToolCall = mutateCalls[i];
        const result: ToolResult = {
          ok: false,
          text: `Skipped mutating tool call ${call.tool}: only one mutating tool call is allowed per assistant turn.`,
          structuredError: {
            code: 'MULTI_MUTATION_NOT_ALLOWED',
            message: 'Only one mutating tool call allowed per turn',
            retryable: true,
          },
        };

        await appendSessionEvent(state, 'tool_result', {
          source: call.source || 'sandbox',
          toolName: call.tool,
          durationMs: 0,
          isError: true,
          text: result.text,
          structuredError: result.structuredError,
        }, runId);

        (state.messages as Message[]).push({
          role: 'user',
          content: buildToolResultMessage(
            call,
            result,
            { runId, round, contextChars, trimmed: false, estimatedTokens: 0, ledger: getLedgerSummary(fileLedger), workingMemory: state.workingMemory },
          ),
        });
        toolsUsed.add(call.tool);
        dispatchEvent('tool_call', { source: call.source || 'sandbox', toolName: call.tool, args: call.args });
        dispatchEvent('tool_result', {
          source: call.source || 'sandbox',
          toolName: call.tool,
          isError: true,
          text: result.text,
        });
      }
    }

    await saveSessionState(state);
  }

  const warning: string = `Reached max rounds (${maxRounds}). Tools used: ${[...toolsUsed].join(', ') || 'none'}. Increase --max-rounds or break the task into smaller steps.`;
  await appendSessionEvent(state, 'run_complete', {
    runId,
    outcome: 'failed',
    summary: warning,
  }, runId);
  dispatchEvent('run_complete', { outcome: 'failed', summary: warning });
  return { outcome: 'max_rounds', finalAssistantText: warning, rounds: maxRounds, runId };
}
