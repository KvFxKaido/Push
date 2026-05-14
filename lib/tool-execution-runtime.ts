/**
 * ToolExecutionRuntime — the headless seam between role agents (Explorer,
 * Coder, deep-reviewer) and the per-shell tool execution layer. Defined in
 * `lib/` so future role kernels can import it without pulling any Web
 * module. Web provides `WebToolExecutionRuntime`; future pushd / CLI
 * adapters will provide their own implementations.
 *
 * Design notes:
 * - `TCall` and `TResult` are generic so the interface does not need to
 *   lift the full `AnyToolCall` / `ToolExecutionResult` cascade (those
 *   drag `ChatMessage`, `ChatCard`, `DelegationOutcome`, etc. into lib).
 *   Web binds them to its rich types; future lib-side consumers bind to
 *   whatever shape they need.
 * - `THooks` and `TGates` are similarly generic so the context can hold
 *   Web's full `ToolHookRegistry` / `ApprovalGateRegistry` classes
 *   without requiring a type lift for hooks that transitively reference
 *   `ChatMessage`.
 * - Error payloads use an inline structural subset — Web's
 *   `StructuredToolError` is structurally assignable without casts.
 * - Diagnosis payloads use the real `ToolCallDiagnosis` from
 *   `lib/tool-call-diagnosis.ts` (landed in Phase 5A).
 *
 * Phase 4 approval seam (landed `bbd282e`) is carried here as
 * `approvalCallback`. Web supplies `undefined` to keep the 5-hop chat
 * fallback; pushd will wire an RPC callback in Phase 6.
 */

import type { CapabilityLedger, ExecutionMode } from './capabilities.js';
import type { AgentRole } from './runtime-contract.js';
import type { ToolCallDiagnosis } from './tool-call-diagnosis.js';

// ---------------------------------------------------------------------------
// Execution mode helper — derives the named capability mode from context
// ---------------------------------------------------------------------------

/**
 * Resolve the `ExecutionMode` for a given tool-execution context.
 *
 * The named mode (`cloud` | `local-daemon`) is the policy input that
 * capability checks consume. Today the web edge derives it from
 * `context.localDaemonBinding` — if a local pushd binding is wired, the
 * call is going to a paired daemon; otherwise it goes to a cloud
 * sandbox. The derivation is intentionally one-line and centralized
 * here so a future code path that sets `localDaemonBinding` for a
 * non-local reason has one obvious seam to revisit. Bindings must not
 * become the hidden policy input — the mode is.
 */
export function getExecutionMode(
  context: Pick<ToolExecutionContext, 'localDaemonBinding'>,
): ExecutionMode {
  return context.localDaemonBinding ? 'local-daemon' : 'cloud';
}

// ---------------------------------------------------------------------------
// Event payloads — narrow subset of the RunEvent vocabulary
// ---------------------------------------------------------------------------

export interface ToolExecutionStartEvent {
  toolName: string;
  source: string;
  toolCallId: string;
}

export interface ToolExecutionCompleteEvent {
  toolName: string;
  durationMs: number;
  /**
   * Structurally compatible with Web's `StructuredToolError`. The runtime
   * never synthesizes errors — it only forwards them — so the subset shape
   * is enough and avoids a cascading type lift.
   */
  error?: { type: string; message: string; retryable?: boolean };
}

export interface ToolCallMalformedEvent {
  diagnosis: ToolCallDiagnosis;
}

export interface ToolEventEmitter {
  toolExecutionStart(event: ToolExecutionStartEvent): void;
  toolExecutionComplete(event: ToolExecutionCompleteEvent): void;
  toolCallMalformed(event: ToolCallMalformedEvent): void;
}

// ---------------------------------------------------------------------------
// Approval callback — Phase 4 seam
// ---------------------------------------------------------------------------

export type ApprovalCallback = (
  toolName: string,
  reason: string,
  recoveryPath: string,
) => Promise<boolean>;

// ---------------------------------------------------------------------------
// Runtime context — collapses the 11-param positional signature from Phase 4
// ---------------------------------------------------------------------------

/**
 * Per-call context shared across all runtime adapters.
 *
 * `THooks` / `TGates` are supplied by the binding — Web uses its real
 * `ToolHookRegistry` and `ApprovalGateRegistry` classes. Lib-side
 * consumers can bind to simpler shapes, or leave them as the default
 * `unknown` when they don't use hooks/gates.
 */
export interface ToolExecutionContext<THooks = unknown, TGates = unknown> {
  allowedRepo: string;
  sandboxId: string | null;
  isMainProtected: boolean;
  defaultBranch?: string;
  /**
   * Provider identifier. Typically a narrow string literal union in the
   * binding (e.g. 'ollama' | 'openrouter' | …). Kept as `string` here so
   * the runtime does not need to lift the full provider union.
   */
  activeProvider?: string;
  activeModel?: string;
  hooks?: THooks;
  approvalGates?: TGates;
  capabilityLedger?: CapabilityLedger;
  approvalCallback?: ApprovalCallback;
  emit?: ToolEventEmitter;
  /**
   * The agent role making the call.
   *
   * Required: the runtime adapter enforces a capability-based refusal
   * for any tool the role cannot use — independent of whether hooks or
   * approval gates are registered, and independent of how the
   * prompt-side tool registry was built. This is the runtime-hard
   * backstop behind the policy-shaped hook layer.
   *
   * Promoted from optional to required to close audit item #3 from the
   * OpenCode silent-failure inventory: when `role` was optional, a
   * binding that forgot to set it would silently bypass the kernel
   * check. The required type makes tsgo the drift-detector for TS call
   * sites; the runtime additionally emits `ROLE_REQUIRED` if the field
   * arrives undefined from a JS caller (see `enforceRoleCapability`
   * in `lib/capabilities.ts`).
   */
  role: AgentRole;
  /**
   * Web-only chat identifier. Threaded through so artifact creation can
   * file records under the durable `repoFullName + branch + chatId`
   * triple that `ArtifactScope` expects. CLI callers leave this
   * undefined — CLI artifacts file under the branch-scoped key.
   */
  chatId?: string;
  /**
   * Opaque local-daemon binding carrier for remote-sessions Phase 1.d.
   *
   * When present, sandbox tools should route through the paired `pushd`
   * WebSocket instead of the cloud sandbox provider. Typed as `unknown`
   * here because the binding shape lives in the Web layer (`LocalPcBinding`
   * in `app/src/types`); the runtime only forwards it to its sandbox
   * dispatcher, which narrows. A future lib-side daemon client can
   * promote this to a typed interface when it needs to read the fields.
   *
   * `sandboxId: null` is legal when this is set — the dispatcher decides
   * which transport handles the call.
   */
  localDaemonBinding?: unknown;
  /**
   * AbortSignal observed by daemon-routed tools that support mid-run
   * cancellation (today: `sandbox_exec`). When the signal fires while
   * the daemon child is running, the client dispatches a `cancel_run`
   * over the same WS so the daemon SIGTERMs the child. Absent signal
   * preserves the legacy "child runs to its own timeout" behaviour.
   * Web's tool-runtime forwards `abortControllerRef.current?.signal`;
   * CLI callers leave this undefined.
   */
  abortSignal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Runtime interface
// ---------------------------------------------------------------------------

export interface ToolExecutionRuntime<TCall, TResult, THooks = unknown, TGates = unknown> {
  execute(toolCall: TCall, context: ToolExecutionContext<THooks, TGates>): Promise<TResult>;
  getSandboxBranch(sandboxId: string): Promise<string | null>;
}
