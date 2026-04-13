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

import type { CapabilityLedger } from './capabilities.js';
import type { ToolCallDiagnosis } from './tool-call-diagnosis.js';

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
}

// ---------------------------------------------------------------------------
// Runtime interface
// ---------------------------------------------------------------------------

export interface ToolExecutionRuntime<TCall, TResult, THooks = unknown, TGates = unknown> {
  execute(toolCall: TCall, context: ToolExecutionContext<THooks, TGates>): Promise<TResult>;
  getSandboxBranch(sandboxId: string): Promise<string | null>;
}
