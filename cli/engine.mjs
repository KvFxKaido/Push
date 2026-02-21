import process from 'node:process';
import { detectAllToolCalls, executeToolCall, isReadOnlyToolCall, truncateText, TOOL_PROTOCOL, TOOL_RULES } from './tools.mjs';
import { CLI_TOOL_SCHEMAS } from './tool-schemas.mjs';
import { appendSessionEvent, saveSessionState, makeRunId } from './session-store.mjs';
import { streamCompletion, resolveNativeFC } from './provider.mjs';
import { createFileLedger, getLedgerSummary, updateFileLedger } from './file-ledger.mjs';
import { recordMalformedToolCall } from './tool-call-metrics.mjs';
import { buildWorkspaceSnapshot, loadProjectInstructions, loadMemory } from './workspace-context.mjs';
import { trimContext } from './context-manager.mjs';

export const DEFAULT_MAX_ROUNDS = 8;

function createWorkingMemory() {
  return {
    plan: '',
    openTasks: [],
    filesTouched: [],
    assumptions: [],
    errorsEncountered: [],
  };
}

function uniqueStrings(values) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function applyWorkingMemoryUpdate(state, args) {
  if (!state.workingMemory || typeof state.workingMemory !== 'object') {
    state.workingMemory = createWorkingMemory();
  }

  const mem = state.workingMemory;
  if (typeof args.plan === 'string') mem.plan = args.plan;
  if (Array.isArray(args.openTasks)) mem.openTasks = uniqueStrings(args.openTasks);
  if (Array.isArray(args.filesTouched)) mem.filesTouched = uniqueStrings(args.filesTouched);
  if (Array.isArray(args.assumptions)) mem.assumptions = uniqueStrings(args.assumptions);
  if (Array.isArray(args.errorsEncountered)) mem.errorsEncountered = uniqueStrings(args.errorsEncountered);

  return mem;
}

export async function buildSystemPrompt(workspaceRoot, { useNativeFC = false } = {}) {
  const [snapshot, instructions, memory] = await Promise.all([
    buildWorkspaceSnapshot(workspaceRoot).catch(() => ''),
    loadProjectInstructions(workspaceRoot).catch(() => null),
    loadMemory(workspaceRoot).catch(() => null),
  ]);

  // When native FC is active, tool definitions are sent as structured schemas
  // in the request body — only include behavioral rules in the prompt.
  const toolBlock = useNativeFC ? TOOL_RULES : TOOL_PROTOCOL;

  let prompt = `You are Push CLI, a coding assistant running in a local workspace.
Workspace root: ${workspaceRoot}

You can read files, run commands, and write files using tools.
Use tools for facts; do not invent file contents or command outputs.
If the user's message does not require reading files or running commands, respond directly without tool calls.
Each tool-loop round is expensive — plan before acting, batch related reads, and avoid exploratory browsing unless the user asks for it.
Use coder_update_state to keep a concise working plan; it is persisted and reinjected.
Use save_memory to persist learnings across sessions (build commands, project patterns, conventions).

${toolBlock}`;

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

export function buildToolResultMessage(call, result, metaEnvelope = null) {
  const payload = {
    tool: call.tool,
    ok: result.ok,
    output: result.text,
    meta: result.meta || null,
    structuredError: result.structuredError || null,
  };

  const metaLine = metaEnvelope ? `\n[meta] ${JSON.stringify(metaEnvelope)}` : '';
  return `[TOOL_RESULT]\n${JSON.stringify(payload, null, 2)}${metaLine}\n[/TOOL_RESULT]`;
}

function buildParseErrorMessage(malformed) {
  return `[TOOL_CALL_PARSE_ERROR]\n${JSON.stringify({
    reason: 'malformed_tool_call',
    malformed,
    guidance: 'Emit strict JSON fenced blocks: {"tool":"name","args":{...}}',
  }, null, 2)}\n[/TOOL_CALL_PARSE_ERROR]`;
}

/**
 * Run the assistant loop. Options:
 * - approvalFn: async (tool, detail) => boolean — gate for high-risk operations
 * - signal: AbortSignal — external abort (e.g. Ctrl+C)
 * - emit: (event) => void — callback for streaming events (replaces stdout writing)
 * - runId: string — optional run id override (used by pushd for ack/event correlation)
 */
export async function runAssistantLoop(state, providerConfig, apiKey, maxRounds, options = {}) {
  const { approvalFn, signal, emit, runId: providedRunId, allowExec } = options;
  const runId = providedRunId || makeRunId();
  let finalAssistantText = '';
  const repeatedCalls = new Map();
  const toolsUsed = new Set();
  const fileLedger = createFileLedger();

  if (!state.workingMemory || typeof state.workingMemory !== 'object') {
    state.workingMemory = createWorkingMemory();
  }

  function dispatchEvent(type, payload) {
    if (typeof emit === 'function') {
      emit({
        type,
        payload,
        runId,
        sessionId: state.sessionId,
      });
    }
  }

  async function executeOneToolCall(call, round, includeMemory = true) {
    const toolStart = Date.now();
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

    const result = await executeToolCall(call, state.cwd, {
      approvalFn,
      signal,
      allowExec,
      providerId: providerConfig?.id,
      providerApiKey: apiKey,
    });
    const durationMs = Date.now() - toolStart;

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

    const metaEnvelope = {
      runId,
      round,
      contextChars,
      trimmed: lastTrimResult?.trimmed || false,
      estimatedTokens: lastTrimResult?.afterTokens || 0,
      ledger: getLedgerSummary(fileLedger),
      ...(includeMemory ? { workingMemory: state.workingMemory } : {}),
    };

    state.messages.push({ role: 'user', content: buildToolResultMessage(call, result, metaEnvelope) });
    toolsUsed.add(call.tool);
    return result;
  }

  let contextChars = 0;
  let lastTrimResult = null;

  for (let round = 1; round <= maxRounds; round++) {
    contextChars = state.messages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0);
    if (signal?.aborted) {
      await saveSessionState(state);
      await appendSessionEvent(state, 'run_complete', { runId, outcome: 'aborted', summary: 'Aborted by user.' }, runId);
      dispatchEvent('run_complete', { outcome: 'aborted', summary: 'Aborted by user.' });
      return { outcome: 'aborted', finalAssistantText: 'Aborted.', rounds: round - 1, runId };
    }

    // Trim context to fit provider budget (state.messages is never mutated)
    const trimResult = trimContext(state.messages, providerConfig.id, state.model);
    lastTrimResult = trimResult;
    if (trimResult.trimmed) {
      dispatchEvent('status', {
        source: 'orchestrator',
        phase: 'context_trimming',
        detail: `${trimResult.beforeTokens} → ${trimResult.afterTokens} tokens (${trimResult.removedCount} msgs removed)`,
      });
    }

    const useNativeFC = resolveNativeFC(providerConfig);
    const fcOptions = useNativeFC
      ? { tools: CLI_TOOL_SCHEMAS, toolChoice: providerConfig.toolChoice || 'auto', forceNativeFC: true }
      : undefined;

    let assistantText;
    try {
      assistantText = await streamCompletion(
        providerConfig,
        apiKey,
        state.model,
        trimResult.messages,
        (token) => {
          dispatchEvent('assistant_token', { text: token });
        },
        undefined,
        signal,
        fcOptions,
      );
    } catch (err) {
      const isAbort = (err instanceof Error && err.name === 'AbortError') || signal?.aborted;
      if (isAbort) {
        await saveSessionState(state);
        await appendSessionEvent(state, 'run_complete', { runId, outcome: 'aborted', summary: 'Aborted by user.' }, runId);
        dispatchEvent('run_complete', { outcome: 'aborted', summary: 'Aborted by user.' });
        return { outcome: 'aborted', finalAssistantText: 'Aborted.', rounds: round - 1, runId };
      }

      const message = err instanceof Error ? err.message : String(err);
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
    state.messages.push({ role: 'assistant', content: assistantText });
    state.rounds += 1;

    const messageId = `asst_${Date.now().toString(36)}`;
    await appendSessionEvent(state, 'assistant_done', {
      messageId,
    }, runId);
    dispatchEvent('assistant_done', { messageId });

    const detected = detectAllToolCalls(assistantText);

    if (detected.malformed.length > 0) {
      for (const malformed of detected.malformed) {
        recordMalformedToolCall(malformed.reason);
      }
      await appendSessionEvent(state, 'warning', {
        code: 'MALFORMED_TOOL_CALL',
        count: detected.malformed.length,
        reasons: detected.malformed.map((m) => m.reason),
      }, runId);
      dispatchEvent('warning', {
        code: 'MALFORMED_TOOL_CALL',
        message: 'Malformed tool calls detected',
        detail: detected.malformed.map((m) => m.reason).join(', '),
      });
      state.messages.push({ role: 'user', content: buildParseErrorMessage(detected.malformed) });
    }

    const memoryCalls = detected.calls.filter((call) => call.tool === 'coder_update_state');
    for (const call of memoryCalls) {
      const updated = applyWorkingMemoryUpdate(state, call.args || {});
      await appendSessionEvent(state, 'working_memory_updated', {
        keys: Object.keys(updated),
      }, runId);
      state.messages.push({
        role: 'user',
        content: buildToolResultMessage(
          call,
          {
            ok: true,
            text: 'Working memory updated.',
            meta: { workingMemory: updated },
          },
          { runId, round, contextChars, ledger: getLedgerSummary(fileLedger), workingMemory: updated },
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

    const toolCalls = detected.calls.filter((call) => call.tool !== 'coder_update_state');

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

    const callKey = JSON.stringify(toolCalls);
    const seen = (repeatedCalls.get(callKey) || 0) + 1;
    repeatedCalls.set(callKey, seen);
    if (seen >= 3) {
      const loopText = `Detected repeated tool call loop (${toolCalls.map((c) => c.tool).join(', ')}). Stopping run.`;
      state.messages.push({ role: 'user', content: `[TOOL_RESULT]\n{"tool":"tool_loop","ok":false,"output":"${loopText}"}\n[/TOOL_RESULT]` });
      await appendSessionEvent(state, 'error', {
        code: 'TOOL_LOOP_DETECTED',
        message: loopText,
        retryable: false,
      }, runId);
      dispatchEvent('error', { code: 'TOOL_LOOP_DETECTED', message: loopText });
      return { outcome: 'error', finalAssistantText: loopText, rounds: round, runId };
    }

    const readCalls = toolCalls.filter(isReadOnlyToolCall);
    const mutateCalls = toolCalls.filter((call) => !isReadOnlyToolCall(call));

    if (readCalls.length > 0) {
      await Promise.all(readCalls.map((call, i) =>
        executeOneToolCall(call, round, i === readCalls.length - 1 && mutateCalls.length === 0)
      ));
    }

    if (mutateCalls.length > 0) {
      await executeOneToolCall(mutateCalls[0], round, true);

      for (let i = 1; i < mutateCalls.length; i++) {
        const call = mutateCalls[i];
        const result = {
          ok: false,
          text: `Skipped mutating tool call ${call.tool}: only one mutating tool call is allowed per assistant turn.`,
          structuredError: {
            code: 'MULTI_MUTATION_NOT_ALLOWED',
            message: 'Only one mutating tool call allowed per turn',
            retryable: true,
          },
        };

        await appendSessionEvent(state, 'tool_result', {
          source: 'sandbox',
          toolName: call.tool,
          durationMs: 0,
          isError: true,
          text: result.text,
          structuredError: result.structuredError,
        }, runId);

        state.messages.push({
          role: 'user',
          content: buildToolResultMessage(
            call,
            result,
            { runId, round, contextChars, ledger: getLedgerSummary(fileLedger), workingMemory: state.workingMemory },
          ),
        });
        toolsUsed.add(call.tool);
        dispatchEvent('tool_call', { source: 'sandbox', toolName: call.tool, args: call.args });
        dispatchEvent('tool_result', {
          source: 'sandbox',
          toolName: call.tool,
          isError: true,
          text: result.text,
        });
      }
    }

    await saveSessionState(state);
  }

  const warning = `Reached max rounds (${maxRounds}). Tools used: ${[...toolsUsed].join(', ') || 'none'}. Increase --max-rounds or break the task into smaller steps.`;
  await appendSessionEvent(state, 'run_complete', {
    runId,
    outcome: 'failed',
    summary: warning,
  }, runId);
  dispatchEvent('run_complete', { outcome: 'failed', summary: warning });
  return { outcome: 'max_rounds', finalAssistantText: warning, rounds: maxRounds, runId };
}
