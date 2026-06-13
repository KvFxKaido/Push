/**
 * UI-side helper for the "New Branch from Here" flow (slice 2.1).
 *
 * Wraps the existing `sandbox_create_branch` tool path so the UI button and
 * the model emit the same operation. Returns the `BranchSwitchPayload` from
 * the tool result so the caller can forward it to the slice 2 migration
 * dispatcher (`applyBranchSwitchPayload` in `branch-fork-migration.ts`),
 * which is what actually migrates the active conversation.
 *
 * Why route through the tool: slice 2's migration handler is wired to fire
 * on `branchSwitch.kind === 'forked'` results coming back from
 * `executeSandboxToolCall`. By calling that same entry point from the UI,
 * the conversation-following + cross-tab marker + R12 atomic backfill all
 * happen the same way they would for a model-initiated fork. No second
 * implementation of the migration logic.
 */

import type { BranchSwitchPayload, ToolExecutionResult } from '@/types';
import type { SandboxToolCall } from './sandbox-tool-detection';

type SandboxToolExecutor = (
  call: SandboxToolCall,
  sandboxId: string,
) => Promise<ToolExecutionResult>;

async function executeSandboxTool(
  call: SandboxToolCall,
  sandboxId: string,
): Promise<ToolExecutionResult> {
  const { executeSandboxToolCall } = await import('./sandbox-tools');
  return executeSandboxToolCall(call, sandboxId);
}

export interface ForkBranchInWorkspaceResult {
  ok: boolean;
  /** Present when the tool result reported a successful branch creation —
   *  caller should forward this to `applyBranchSwitchPayload` (or the
   *  active chat-send dispatcher) to trigger conversation migration. */
  branchSwitch?: BranchSwitchPayload;
  /** User-facing error text on failure. Stripped of `[Tool Error]` prefixes. */
  errorMessage?: string;
  /** True when the failure is specifically "no sandbox running". Callers
   *  with a legacy plain-write path (drawer switch, create sheet) fall back
   *  to it on this flag — per the design doc's writer table, the typed path
   *  applies "when a sandbox is live; plain write otherwise". */
  noSandbox?: true;
  /** Raw tool result for advanced callers (currently unused; kept for
   *  future debugging affordances). */
  raw?: ToolExecutionResult;
}

export interface SwitchBranchInWorkspaceResult {
  ok: boolean;
  /** Present when the tool result reported a successful branch switch —
   *  caller should forward this to `applyBranchSwitchPayload` to route the
   *  conversation through the same path as model-initiated switches. */
  branchSwitch?: BranchSwitchPayload;
  /** User-facing error text on failure. Stripped of `[Tool Error]` prefixes. */
  errorMessage?: string;
  /** True when the failure is specifically "no sandbox running" — see
   *  ForkBranchInWorkspaceResult.noSandbox. */
  noSandbox?: true;
  /** Raw tool result for advanced callers. */
  raw?: ToolExecutionResult;
}

/** Fallback text cleaner for sandbox tool output that lacks a structured
 *  error. Strips both the leading `[Tool Error]` / `[Tool Result]` envelope
 *  AND the trailing `error_type:` / `retryable:` diagnostic lines that
 *  `formatStructuredError` appends — neither belongs in a UI error pill.
 *  Prefer `structuredError.message` when available. */
export function cleanToolText(text: string): string {
  return text
    .replace(/^\[Tool Error[^\]]*\]\s*/i, '')
    .replace(/^\[Tool Result[^\]]*\]\s*/i, '')
    .replace(/^\s*error_type:\s.*$/gm, '')
    .replace(/^\s*retryable:\s.*$/gm, '')
    .trim();
}

/** Create a new branch from the current sandbox HEAD (or from `from` if
 *  supplied) and return the BranchSwitchPayload so the caller can drive
 *  conversation migration through the slice 2 dispatcher. */
export async function forkBranchInWorkspace(
  sandboxId: string | null,
  name: string,
  from?: string,
  executeTool: SandboxToolExecutor = executeSandboxTool,
): Promise<ForkBranchInWorkspaceResult> {
  if (!sandboxId) {
    return {
      ok: false,
      noSandbox: true,
      errorMessage: 'No active sandbox — start one before creating a branch.',
    };
  }

  const result = await executeTool(
    {
      tool: 'sandbox_create_branch',
      args: { name, ...(from ? { from } : {}) },
    },
    sandboxId,
  );

  if (result.structuredError || !result.branchSwitch) {
    // Prefer the structured error's human message — it's authored for users
    // and skips the `error_type:` / `retryable:` diagnostic lines that
    // `formatStructuredError` appends to the text envelope.
    const struct = result.structuredError;
    const errorMessage = struct?.message
      ? struct.detail
        ? `${struct.message} — ${struct.detail}`
        : struct.message
      : cleanToolText(result.text);
    return {
      ok: false,
      errorMessage,
      raw: result,
    };
  }

  return {
    ok: true,
    branchSwitch: result.branchSwitch,
    raw: result,
  };
}

/** Switch the existing sandbox branch and return the BranchSwitchPayload so
 *  the caller can drive chat routing through the slice 2 dispatcher. */
export async function switchBranchInWorkspace(
  sandboxId: string | null,
  branch: string,
  executeTool: SandboxToolExecutor = executeSandboxTool,
): Promise<SwitchBranchInWorkspaceResult> {
  if (!sandboxId) {
    return {
      ok: false,
      noSandbox: true,
      errorMessage: 'No active sandbox — start one before switching branches.',
    };
  }

  const result = await executeTool(
    {
      tool: 'sandbox_switch_branch',
      args: { branch },
    },
    sandboxId,
  );

  if (result.structuredError || !result.branchSwitch) {
    const struct = result.structuredError;
    const errorMessage = struct?.message
      ? struct.detail
        ? `${struct.message} — ${struct.detail}`
        : struct.message
      : cleanToolText(result.text);
    return {
      ok: false,
      errorMessage,
      raw: result,
    };
  }

  return {
    ok: true,
    branchSwitch: result.branchSwitch,
    raw: result,
  };
}
