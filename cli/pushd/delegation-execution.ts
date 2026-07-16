/**
 * delegation-execution.ts — daemon adapters used by delegated role kernels.
 *
 * Owns the Coder and read-only Explorer/Reviewer tool executors plus the shared
 * persistence-before-broadcast bridge for role-agent run events. Task-graph and
 * direct-delegation coordination remain with their handler owners.
 */
import type { CoderToolExecContext, CoderToolExecResult } from '../../lib/coder-agent.ts';
import { isEditDiff } from '../../lib/edit-diff.ts';
import { PROTOCOL_VERSION } from '../../lib/protocol-schema.ts';
import type { AgentRole, RunEventInput } from '../../lib/runtime-contract.ts';
import { isToolCard } from '../../lib/tool-cards.ts';
import { makeCliReadOnlyToolExec } from '../lead-explorer.js';
import { appendSessionEvent } from '../session-store.js';
import { executeToolCall } from '../tools.js';
import type { SessionRuntime, SessionRuntimeEntry } from './session-runtime.js';

export interface DaemonCoderToolExecOptions {
  sessionId: string;
  entry: SessionRuntimeEntry;
  runId: string;
  signal?: AbortSignal;
}

export interface DaemonReadOnlyToolExecOptions {
  entry: SessionRuntimeEntry;
  signal?: AbortSignal;
  role?: AgentRole;
}

export type DaemonCoderToolExec = (
  toolCall: unknown,
  execContext: CoderToolExecContext,
) => Promise<CoderToolExecResult>;

export type DaemonReadOnlyToolExec = ReturnType<typeof makeCliReadOnlyToolExec>;
export type RoleAgentRunEventHandler = (event: RunEventInput) => void;

export interface DelegationExecutionAdapters {
  makeDaemonCoderToolExec(options: DaemonCoderToolExecOptions): DaemonCoderToolExec;
  makeDaemonExplorerToolExec(options: DaemonReadOnlyToolExecOptions): DaemonReadOnlyToolExec;
  emitRoleAgentRunEvent(
    sessionId: string,
    entry: SessionRuntimeEntry,
    runId: string | null,
  ): RoleAgentRunEventHandler;
}

export function createDelegationExecutionAdapters(
  runtime: SessionRuntime,
): DelegationExecutionAdapters {
  /**
   * Bind the production CLI executor (`executeToolCall` from `cli/tools.ts` —
   * the same one the CLI lead turn uses) to one delegated Coder run, with
   * approval gating routed through the session runtime so any high-risk exec
   * emits `approval_required` on the child `runId` and blocks on a
   * `submit_approval` RPC.
   *
   * The result is translated from CLI's `{ ok, text, meta?, structuredError? }`
   * shape to lib's discriminated union
   * (`{ kind: 'executed', resultText, errorType? } | { kind: 'denied', reason }`).
   * `errorType` feeds the kernel's mutation-failure tracker
   * (`lib/coder-agent.ts` guards against repeated same-tool+file failures).
   *
   * Non-goals: no sandbox layer (runs directly against `state.cwd`, same model
   * as the CLI engine), no OTel spans, no `CapabilityLedger` gating, no
   * `TurnPolicyRegistry` (all Web-side). Pushd is an RPC transport + approval
   * gate, nothing more.
   */
  function makeDaemonCoderToolExec({
    sessionId,
    entry,
    runId,
    signal,
  }: DaemonCoderToolExecOptions): DaemonCoderToolExec {
    const approvalFn = runtime.buildApprovalFn(sessionId, entry, runId);
    const workspaceRoot = entry.state.cwd;

    return async (toolCall: unknown, _execContext: CoderToolExecContext) => {
      // The kernel passes the nested wrapper from `wrapCliDetectAllToolCalls`
      // — a `{ source, call: { tool, args } }` shape. Unwrap once to the flat
      // form `executeToolCall` expects; a bare CLI call (e.g. tests calling
      // the executor directly) falls through as-is.
      const wrapped = toolCall as { call?: unknown } | null;
      const rawCall =
        wrapped && typeof wrapped === 'object' && wrapped.call ? wrapped.call : toolCall;

      try {
        const result = await executeToolCall(rawCall, workspaceRoot, {
          approvalFn,
          signal,
          // Daemon delegations run the full tool surface; the approval gate
          // keeps high-risk exec behind an explicit user decision.
          // `execMode: 'auto'` mirrors the non-delegated CLI engine default.
          allowExec: true,
          execMode: 'auto',
          // Surface the actual role to capability-gated executor cases and
          // author-stamping — without this, a Coder-emitted artifact would
          // default to `role: 'orchestrator'` and misattribute.
          role: 'coder',
          // Provider + model for the Auditor commit gate (default-on,
          // `lib/auditor-policy.ts`): a delegated Coder emitting git_commit
          // needs these to run the verdict — without them the gate fails
          // closed and blocks the commit.
          providerId: entry.state.provider,
          model: entry.state.model,
          runId,
        });
        const resultText = typeof result?.text === 'string' ? result.text : '';
        const meta = result?.meta as Record<string, unknown> | null | undefined;
        const card = isToolCard(meta?.card) ? meta.card : undefined;
        const editDiff = isEditDiff(meta?.editDiff) ? meta.editDiff : undefined;

        if (result && result.ok === true) {
          return {
            kind: 'executed',
            resultText,
            ...(card ? { card } : {}),
            ...(editDiff ? { editDiff } : {}),
          };
        }

        // Tool ran to completion but reported failure. Feed the opaque
        // structured-error code into the kernel's mutation-failure tracker
        // via `errorType` so repeated same-tool+file failures trigger the
        // kernel's halt guard (`lib/coder-agent.ts`).
        return {
          kind: 'executed',
          resultText,
          errorType: result?.structuredError?.code,
          ...(card ? { card } : {}),
          ...(editDiff ? { editDiff } : {}),
        };
      } catch (error) {
        // `executeToolCall` throwing is the rare exception path — approval
        // timeout, abort during exec, catastrophic I/O. Surface as `denied`
        // so the kernel doesn't spin on the same call forever; it injects
        // the `reason` into the next user message so the model can react.
        const message = error instanceof Error ? error.message : String(error);
        return { kind: 'denied', reason: `daemon tool executor error: ${message}` };
      }
    };
  }

  /**
   * Bind the shared capability-gated read-only executor to a daemon entry.
   * Read-only roles that share this executor: Explorer and Deep Reviewer
   * (which passes `role: 'reviewer'`).
   *
   * The implementation lives in `cli/lead-explorer.ts:makeCliReadOnlyToolExec`
   * — extracted when the lead's Explorer fan-out became the second consumer,
   * so the daemon's delegated runs and the lead lane enforce the read-only
   * contract (three-layer capability gate, `role_capability_denied` log,
   * approval-free `executeToolCall`) through one implementation. This wrapper
   * only binds the daemon's session entry shape. No approval gating: the
   * contract is read-only, and the executor refuses mutating tools outright
   * with a polite denial the kernel feeds back to the model (mirrors the
   * web-side `ROLE_CAPABILITY_DENIED` check so both surfaces enforce via
   * `lib/capabilities.ts`).
   */
  function makeDaemonExplorerToolExec({
    entry,
    signal,
    role = 'explorer',
  }: DaemonReadOnlyToolExecOptions): DaemonReadOnlyToolExec {
    return makeCliReadOnlyToolExec({
      workspaceRoot: entry.state.cwd,
      sessionId: entry?.sessionId ?? null,
      signal,
      role,
    });
  }

  /**
   * Build an `onRunEvent` handler for role-agent kernels (Coder / Explorer /
   * Reviewer / Auditor) running on the CLI daemon.
   *
   * Two race-safety properties:
   *
   *   1. Seq capture is synchronous. `appendSessionEvent` increments
   *      `state.eventSeq` before its filesystem await resolves, so we read
   *      the seq immediately after starting the append, BEFORE awaiting.
   *      Reading inside `.then()` would race with concurrent emits (e.g.
   *      task-graph `task_completed`) that bump `eventSeq` before this
   *      promise resolves, causing the live envelope to reuse a later seq
   *      than the persisted record — and break clients that reconcile/replay
   *      by seq. Codex P2 on PR #540.
   *
   *   2. Broadcast is gated on persistence success. If the filesystem append
   *      fails the broadcast is skipped, so the wire stream never contains
   *      an envelope that has no persisted counterpart; a structured warning
   *      surfaces the gap to operators rather than silent loss.
   */
  function emitRoleAgentRunEvent(
    sessionId: string,
    entry: SessionRuntimeEntry,
    runId: string | null,
  ): RoleAgentRunEventHandler {
    return (event) => {
      const { type, ...payload } = event;
      const writePromise = appendSessionEvent(entry.state, type, payload, runId);
      const seq = entry.state.eventSeq;

      writePromise
        .then(() => {
          runtime.broadcast(sessionId, {
            v: PROTOCOL_VERSION,
            kind: 'event',
            sessionId,
            ...(runId ? { runId } : {}),
            seq,
            ts: Date.now(),
            type,
            payload,
          });
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          runtime.broadcast(sessionId, {
            v: PROTOCOL_VERSION,
            kind: 'event',
            sessionId,
            ...(runId ? { runId } : {}),
            seq,
            ts: Date.now(),
            type: 'warning',
            payload: {
              code: 'PROMPT_SNAPSHOT_PERSIST_FAILED',
              message: `Failed to persist ${type}: ${message}`,
            },
          });
        });
    };
  }

  return {
    makeDaemonCoderToolExec,
    makeDaemonExplorerToolExec,
    emitRoleAgentRunEvent,
  };
}
