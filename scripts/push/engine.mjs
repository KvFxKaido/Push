import process from 'node:process';
import { detectToolCall, executeToolCall, truncateText, TOOL_PROTOCOL } from './tools.mjs';
import { appendSessionEvent, saveSessionState, makeRunId } from './session-store.mjs';
import { streamCompletion } from './provider.mjs';

export const DEFAULT_MAX_ROUNDS = 8;

export function buildSystemPrompt(workspaceRoot) {
  return `You are Push CLI, a coding assistant running in a local workspace.
Workspace root: ${workspaceRoot}

You can read files, run commands, and write files using tools.
Use tools for facts; do not invent file contents or command outputs.

${TOOL_PROTOCOL}`;
}

export function buildToolResultMessage(call, result) {
  const payload = {
    tool: call.tool,
    ok: result.ok,
    output: result.text,
    meta: result.meta || null,
  };
  return `[TOOL_RESULT]\n${JSON.stringify(payload, null, 2)}\n[/TOOL_RESULT]`;
}

/**
 * Run the assistant loop. Options:
 * - approvalFn: async (tool, detail) => boolean — gate for high-risk operations
 */
export async function runAssistantLoop(state, providerConfig, apiKey, maxRounds, streamToStdout, options = {}) {
  const runId = makeRunId();
  let finalAssistantText = '';
  const repeatedCalls = new Map();

  for (let round = 1; round <= maxRounds; round++) {
    if (streamToStdout) process.stdout.write('\nassistant> ');

    const assistantText = await streamCompletion(
      providerConfig,
      apiKey,
      state.model,
      state.messages,
      (token) => {
        if (streamToStdout) process.stdout.write(token);
      },
    );

    if (streamToStdout) process.stdout.write('\n');

    finalAssistantText = assistantText.trim();
    state.messages.push({ role: 'assistant', content: assistantText });
    state.rounds += 1;

    const messageId = `asst_${Date.now().toString(36)}`;
    await appendSessionEvent(state, 'assistant_done', {
      messageId,
    }, runId);

    const toolCall = detectToolCall(assistantText);
    if (!toolCall) {
      await appendSessionEvent(state, 'run_complete', {
        runId,
        outcome: 'success',
        summary: finalAssistantText.slice(0, 500),
      }, runId);
      return { outcome: 'success', finalAssistantText, rounds: round, runId };
    }

    const callKey = JSON.stringify(toolCall);
    const seen = (repeatedCalls.get(callKey) || 0) + 1;
    repeatedCalls.set(callKey, seen);
    if (seen >= 3) {
      const loopText = `Detected repeated tool call loop for ${toolCall.tool}. Stopping run.`;
      state.messages.push({ role: 'user', content: `[TOOL_RESULT]\n{"tool":"${toolCall.tool}","ok":false,"output":"${loopText}"}\n[/TOOL_RESULT]` });
      await appendSessionEvent(state, 'error', {
        code: 'TOOL_LOOP_DETECTED',
        message: loopText,
        retryable: false,
      }, runId);
      return { outcome: 'error', finalAssistantText: loopText, rounds: round, runId };
    }

    if (streamToStdout) {
      process.stdout.write(`[tool] ${toolCall.tool}\n`);
    }

    const toolStart = Date.now();
    await appendSessionEvent(state, 'tool_call', {
      source: 'sandbox',
      toolName: toolCall.tool,
      args: toolCall.args,
    }, runId);

    const result = await executeToolCall(toolCall, state.cwd, { approvalFn: options.approvalFn });
    const durationMs = Date.now() - toolStart;

    await appendSessionEvent(state, 'tool_result', {
      source: 'sandbox',
      toolName: toolCall.tool,
      durationMs,
      isError: !result.ok,
      text: result.text.slice(0, 500),
      structuredError: null,
    }, runId);

    if (streamToStdout) {
      process.stdout.write(`[tool:${result.ok ? 'ok' : 'error'}] ${truncateText(result.text, 420)}\n`);
    }

    state.messages.push({ role: 'user', content: buildToolResultMessage(toolCall, result) });
    await saveSessionState(state);
  }

  const tools = [...repeatedCalls.keys()].map((k) => JSON.parse(k).tool);
  const uniqueTools = [...new Set(tools)];
  const warning = `Reached max rounds (${maxRounds}). Tools used: ${uniqueTools.join(', ') || 'none'}. Increase --max-rounds or break the task into smaller steps.`;
  await appendSessionEvent(state, 'run_complete', {
    runId,
    outcome: 'failed',
    summary: warning,
  }, runId);
  return { outcome: 'max_rounds', finalAssistantText: warning, rounds: maxRounds, runId };
}
