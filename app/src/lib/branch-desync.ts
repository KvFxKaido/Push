import type { MutableRefObject } from 'react';
import type { AnyToolCall } from '@/lib/tool-dispatch';
import { applyBranchSwitchPayload, type BranchForkMigrationContext } from './branch-fork-migration';
import type { ChatRuntimeHandlers } from '@/hooks/chat-send-types';
import type { RunEventInput, ToolExecutionResult } from '@/types';

export type BranchDesyncDecision =
  | { kind: 'no_stamp' }
  | { kind: 'match'; expected: string; actual: string }
  | { kind: 'detached'; expected: string; actual: 'HEAD'; command: string }
  | { kind: 'reconcile'; expected: string; actual: string; command: string };

export interface BranchDesyncInput {
  expected?: string;
  actual?: string;
  command: string;
}

export function decideSandboxExecBranchDesync(input: BranchDesyncInput): BranchDesyncDecision {
  const actual = input.actual?.trim();
  const expected = input.expected?.trim();
  if (!actual || !expected) return { kind: 'no_stamp' };
  if (actual === expected) return { kind: 'match', expected, actual };
  if (actual === 'HEAD') return { kind: 'detached', expected, actual, command: input.command };
  return { kind: 'reconcile', expected, actual, command: input.command };
}

export interface BranchDesyncContext extends BranchForkMigrationContext {
  chatId: string;
  appendRunEvent: (chatId: string, event: RunEventInput) => void;
  runtimeHandlersRef: MutableRefObject<ChatRuntimeHandlers | undefined>;
}

export function applySandboxExecBranchDesync(
  call: AnyToolCall,
  result: ToolExecutionResult,
  ctx: BranchDesyncContext,
): BranchDesyncDecision {
  if (call.source !== 'sandbox' || call.call.tool !== 'sandbox_exec') {
    return { kind: 'no_stamp' };
  }
  return applyStampedSandboxExecBranchDesync(
    { command: call.call.args.command, branch: result.branch },
    ctx,
  );
}

/** Entry point for surfaces that see the stamp without an AnyToolCall wrapper
 *  — the inline lead lane tees `{ command, branch }` out of the kernel's
 *  sandbox executor closure (`runInPageCoderKernel`'s bindings), where the
 *  orchestrator dispatch seam never runs. */
export function applyStampedSandboxExecBranchDesync(
  input: { command: string; branch?: string },
  ctx: BranchDesyncContext,
): BranchDesyncDecision {
  const expected =
    ctx.branchInfoRef.current?.currentBranch ?? ctx.branchInfoRef.current?.defaultBranch;
  const decision = decideSandboxExecBranchDesync({
    expected,
    actual: input.branch,
    command: input.command,
  });
  if (decision.kind !== 'detached' && decision.kind !== 'reconcile') {
    return decision;
  }

  ctx.appendRunEvent(ctx.chatId, {
    type: 'branch_desync',
    expected: decision.expected,
    actual: decision.actual,
    command: decision.command,
  });

  ctx.runtimeHandlersRef.current?.onBranchDesync?.({
    expected: decision.expected,
    actual: decision.actual,
    command: decision.command,
    reconciled: decision.kind === 'reconcile',
  });

  if (decision.kind === 'detached') {
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'branch_desync_detected_detached',
        expected: decision.expected,
        actual: decision.actual,
        command: decision.command,
      }),
    );
    return decision;
  }

  console.log(
    JSON.stringify({
      level: 'info',
      event: 'branch_desync_detected_reconciled',
      expected: decision.expected,
      actual: decision.actual,
      command: decision.command,
    }),
  );
  applyBranchSwitchPayload(
    {
      name: decision.actual,
      kind: 'switched',
      from: decision.expected,
      previous: decision.expected,
      source: 'branch_desync',
    },
    ctx,
  );
  return decision;
}
