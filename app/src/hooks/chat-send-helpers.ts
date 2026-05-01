/**
 * chat-send-helpers.ts
 *
 * Pure-ish helpers extracted from chat-send.ts. The split keeps chat-send.ts
 * focused on `processAssistantTurn` (the post-stream dispatcher) by pulling
 * out the small support functions that are independent of SendLoopContext:
 *
 *   - shouldEmitPeriodicPulse           — round-counter pulse predicate
 *   - delegateCallNeedsSandbox          — does this delegate call need sandbox prewarm?
 *   - getDelegateCompletionAgent        — agent kind for DELEGATION_COMPLETED events
 *   - isChatHookSource                  — scratchpad/todo source predicate
 *   - executeChatHookToolCall           — local-state executor for chat-hook tools
 *   - executeToolWithChatHooks          — wrapper that routes chat-hook calls locally
 *   - extractChangedPathFromStatusLine  — git status --porcelain parser
 *   - inferVerificationCommandResult    — pulls a verification command result out of a tool card
 *   - collectPostToolPolicyEffects      — drains postHookInject / postHookHalt across tool results
 */

import type { MutableRefObject } from 'react';
import type { AnyToolCall } from '@/lib/tool-dispatch';
import {
  executeTool,
  type ToolExecRunContext,
  type ToolExecRawResult,
} from '@/lib/chat-tool-execution';
import { executeScratchpadToolCall } from '@/lib/scratchpad-tools';
import { executeTodoToolCall } from '@/lib/todo-tools';
import { createId } from '@push/lib/id-utils';
import type { ChatMessage, ToolExecutionResult } from '@/types';
import type { ScratchpadHandlers, TodoHandlers } from './chat-send-types';

const TOOL_RESULT_PULSE_INTERVAL = 3;

export function shouldEmitPeriodicPulse(round: number): boolean {
  return (round + 1) % TOOL_RESULT_PULSE_INTERVAL === 0;
}

export function delegateCallNeedsSandbox(call: AnyToolCall): boolean {
  if (call.source !== 'delegate') return false;
  if (call.call.tool === 'delegate_coder') return true;
  if (call.call.tool !== 'plan_tasks') return false;
  return call.call.args.tasks.some((task) => task.agent === 'coder');
}

export function getDelegateCompletionAgent(call: AnyToolCall): 'explorer' | 'coder' | 'task_graph' {
  if (call.source !== 'delegate') return 'coder';
  if (call.call.tool === 'delegate_explorer') return 'explorer';
  if (call.call.tool === 'plan_tasks') return 'task_graph';
  return 'coder';
}

/** Chat-hook-managed sources — executed against refs in this hook, not the
 * generic tool-execution runtime which can only see server-owned state. */
export function isChatHookSource(source: AnyToolCall['source']): boolean {
  return source === 'scratchpad' || source === 'todo';
}

/**
 * Wrap `executeTool` so chat-hook sources (scratchpad + todo) are routed
 * through the local chat-hook executor rather than the runtime, which
 * would reject them with "must be handled by the chat hook". Used in both
 * the parallel-reads path and the trailing-mutation path so batched turns
 * don't deterministically fail when they mix a chat-hook call with a
 * regular read/mutation.
 */
export async function executeToolWithChatHooks(
  call: AnyToolCall,
  ctx: ToolExecRunContext,
  refs: {
    scratchpadRef: MutableRefObject<ScratchpadHandlers | undefined>;
    todoRef: MutableRefObject<TodoHandlers | undefined>;
  },
): Promise<ToolExecRawResult> {
  if (isChatHookSource(call.source)) {
    const start = Date.now();
    const result =
      executeChatHookToolCall(call, refs) ??
      ({ text: '[Tool Error] Chat-hook tool dispatch failed.' } as ToolExecutionResult);
    return { call, raw: result, cards: [], durationMs: Date.now() - start };
  }
  return executeTool(call, ctx);
}

/**
 * Execute a chat-hook-handled tool call (scratchpad or todo) against the
 * local refs. Returns the result if the source is handled here, or null if
 * the caller should fall through to the runtime.
 *
 * These tools live in the chat hook because they mutate React state the
 * runtime can't see. Routed from both the single-call dispatch and the
 * batched (parallel reads / trailing mutation) paths so a model that
 * interleaves a todo_write with a read_file in one turn doesn't land on
 * "[Tool Error] Todo must be handled by the chat hook."
 */
export function executeChatHookToolCall(
  call: AnyToolCall,
  refs: {
    scratchpadRef: MutableRefObject<ScratchpadHandlers | undefined>;
    todoRef: MutableRefObject<TodoHandlers | undefined>;
  },
): ToolExecutionResult | null {
  if (call.source === 'scratchpad') {
    const sp = refs.scratchpadRef.current;
    if (!sp) {
      return {
        text: '[Tool Error] Scratchpad not available. The scratchpad may not be initialized — try again after the UI loads.',
      };
    }
    const result = executeScratchpadToolCall(call.call, sp.content, sp.replace, sp.append);
    if (result.ok) {
      if (call.call.tool === 'set_scratchpad') {
        refs.scratchpadRef.current = { ...sp, content: call.call.content };
      } else if (call.call.tool === 'append_scratchpad') {
        const prev = sp.content.trim();
        refs.scratchpadRef.current = {
          ...sp,
          content: prev ? `${prev}\n\n${call.call.content}` : call.call.content,
        };
      }
    }
    return { text: result.text };
  }

  if (call.source === 'todo') {
    const todo = refs.todoRef.current;
    if (!todo) {
      return {
        text: '[Tool Error] Todo list not available. It may not be initialized — try again after the UI loads.',
      };
    }
    const result = executeTodoToolCall(call.call, todo.todos, {
      replace: todo.replace,
      clear: todo.clear,
    });
    if (result.ok && result.nextTodos) {
      refs.todoRef.current = { ...todo, todos: result.nextTodos };
    }
    return { text: result.text };
  }

  return null;
}

export function extractChangedPathFromStatusLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const candidate = trimmed.slice(3).trim();
  if (!candidate) return null;
  if (candidate.includes(' -> ')) {
    return candidate.split(' -> ').pop()?.trim() || null;
  }
  return candidate;
}

export function inferVerificationCommandResult(result: ToolExecutionResult): {
  command: string;
  exitCode: number;
  detail: string;
} | null {
  const card = result.card;
  if (!card) return null;

  if (card.type === 'sandbox') {
    return {
      command: card.data.command,
      exitCode: card.data.exitCode,
      detail: `Command "${card.data.command}" exited with code ${card.data.exitCode}.`,
    };
  }

  if (card.type === 'type-check') {
    const command =
      card.data.tool === 'tsc'
        ? 'npx tsc --noEmit'
        : card.data.tool === 'pyright'
          ? 'pyright'
          : card.data.tool === 'mypy'
            ? 'mypy'
            : null;
    if (!command) return null;
    return {
      command,
      exitCode: card.data.exitCode,
      detail: `${card.data.tool} exited with code ${card.data.exitCode}.`,
    };
  }

  if (card.type === 'test-results') {
    const command =
      card.data.framework === 'npm'
        ? 'npm test'
        : card.data.framework === 'pytest'
          ? 'pytest -v'
          : card.data.framework === 'cargo'
            ? 'cargo test'
            : card.data.framework === 'go'
              ? 'go test ./...'
              : null;
    if (!command) return null;
    return {
      command,
      exitCode: card.data.exitCode,
      detail: `${command} exited with code ${card.data.exitCode}.`,
    };
  }

  return null;
}

export interface PostToolPolicyEffects {
  messages: ChatMessage[];
  halted: boolean;
  haltDetail?: string;
}

export function collectPostToolPolicyEffects(
  results: readonly ToolExecutionResult[],
): PostToolPolicyEffects {
  const messages: ChatMessage[] = [];
  let haltDetail: string | undefined;

  for (const result of results) {
    if (result.postHookInject) {
      messages.push(result.postHookInject);
    }
    if (!haltDetail && result.postHookHalt) {
      haltDetail = result.postHookHalt;
      messages.push({
        id: createId(),
        role: 'user',
        content: result.postHookHalt,
        timestamp: Date.now(),
      });
    }
  }

  return {
    messages,
    halted: Boolean(haltDetail),
    haltDetail,
  };
}
