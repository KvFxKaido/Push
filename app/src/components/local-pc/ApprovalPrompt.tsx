/**
 * ApprovalPrompt — surface for `approval_required` events emitted by
 * the daemon's `buildApprovalFn` (used by delegated agents). Phase 3
 * slice 4 of the remote-sessions track.
 *
 * Without this, daemon-side approval gates (e.g. when a delegated
 * Coder agent hits a sandbox guard) emit `approval_required` and
 * silently time out 60s later — no web surface listened. The chat
 * surface gets a render-blocking prompt with Approve / Deny so the
 * delegation continues with the user's actual decision instead of
 * the implicit deny-on-timeout.
 *
 * Visual posture mirrors the local-pc reconnect banner: a sticky
 * strip under the header that doesn't take over the viewport but
 * is impossible to miss. Multiple pending approvals queue (FIFO);
 * the strip displays the head of the queue and a counter ("2 more
 * waiting") when there's more.
 */
import { Check, ShieldQuestion, X } from 'lucide-react';

export interface PendingApproval {
  /** Daemon-issued correlation id, sent back with `submit_approval`. */
  approvalId: string;
  /** Engine session this approval belongs to. */
  sessionId: string;
  /** Run id the approval is scoped to (delegate child run, task-graph node, etc.). */
  runId?: string;
  /** Daemon-emitted shape: `tool.tool` from `buildApprovalFn` (e.g. `sandbox_exec`). */
  kind: string;
  /** Human-readable title from the daemon (already localized server-side). */
  title: string;
  /** Detail string the daemon serialized from the tool's approval request. */
  summary: string;
  /** Decision options offered by the daemon (today always ['approve', 'deny']). */
  options: string[];
  /** Wall-clock ms when the approval arrived in the client; for sorting. */
  receivedAt: number;
}

interface ApprovalPromptProps {
  /** Head of the FIFO queue, or null when no approvals are pending. */
  pending: PendingApproval | null;
  /** Number of additional approvals waiting behind `pending`. */
  queuedBehind: number;
  /**
   * Caller dispatches `submit_approval` with `decision` and removes
   * `pending` from its own queue. The component does NOT manage
   * queue state — keeping it stateless avoids the "two screens
   * sharing one queue" coordination problem the chat surface already
   * solves via React state.
   */
  onDecide: (decision: 'approve' | 'deny') => void;
}

export function ApprovalPrompt({ pending, queuedBehind, onDecide }: ApprovalPromptProps) {
  if (!pending) return null;
  return (
    <div
      role="dialog"
      aria-modal="false"
      aria-label="Approval required"
      className="flex items-start gap-3 border-b border-amber-400/30 bg-amber-950/30 px-4 py-3 text-sm"
    >
      <ShieldQuestion className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 text-amber-100">
          <span className="font-medium">{pending.title}</span>
          <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 text-[10px] uppercase tracking-wide text-amber-200">
            {pending.kind}
          </span>
        </div>
        {pending.summary ? (
          <p className="mt-1 break-words text-amber-200/80">{pending.summary}</p>
        ) : null}
        {queuedBehind > 0 ? (
          <p className="mt-1 text-xs text-amber-200/60">
            {queuedBehind} more {queuedBehind === 1 ? 'approval' : 'approvals'} waiting
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={() => onDecide('deny')}
          aria-label="Deny"
          className="inline-flex items-center gap-1.5 rounded-full border border-rose-400/40 px-3 py-1.5 text-xs text-rose-200 transition hover:border-rose-400/60 hover:bg-rose-400/10"
        >
          <X className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Deny</span>
        </button>
        <button
          type="button"
          onClick={() => onDecide('approve')}
          aria-label="Approve"
          className="inline-flex items-center gap-1.5 rounded-full border border-emerald-400/40 bg-emerald-400/10 px-3 py-1.5 text-xs text-emerald-200 transition hover:border-emerald-400/60 hover:bg-emerald-400/20"
        >
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Approve</span>
        </button>
      </div>
    </div>
  );
}
