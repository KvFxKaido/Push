/**
 * Approval bridge — the resolver registry that lets a runtime-driven approval
 * gate SUSPEND a tool call until the user decides, then resume it.
 *
 * Why this exists: the web tool-execution runtime evaluates approval gates
 * (`lib/approval-gates.ts`) and, when a gate returns `ask_user`, `await`s an
 * `approvalCallback` that must resolve to a boolean. Today that callback is
 * never wired, so every gate falls back to a structured error that BEGS THE
 * MODEL to call `ask_user` — i.e. the model, not the runtime, decides whether
 * the human is asked. That's the control-plane-in-prompt smell Push's own
 * "behavior lives in code, not prompts" rule warns against.
 *
 * This module is the runtime-side fix: the callback renders a Confirmation
 * card and returns the promise registered here; the card's Approve/Reject
 * action resolves it. A non-cooperating model can no longer skip the gate —
 * the suspension happens in code, before the tool runs.
 *
 * Single in-browser client → a module-level Map is sufficient; cross-chat
 * collisions are avoided by the unique `approvalId`. This is the named
 * coordinator home (not buried in `useChat.ts`), per the repo's
 * "name the coordinator's home first" guidance.
 */

import type { ApprovalCardData, ApprovalCardCategory } from '@/types';
import type { ApprovalRequest } from '@push/lib/tool-execution-runtime';
import { createId } from '@push/lib/id-utils';

const resolvers = new Map<string, (approved: boolean) => void>();

/**
 * Register a pending approval and return the promise the runtime `await`s.
 * The returned promise resolves when {@link resolveApproval} is called with
 * the same `approvalId` (Approve → true, Reject → false).
 */
export function registerApproval(approvalId: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    // A re-registered id (shouldn't happen) would orphan the prior promise;
    // resolve the old one as denied so its tool call fails closed rather than
    // hanging forever.
    const prior = resolvers.get(approvalId);
    if (prior) prior(false);
    resolvers.set(approvalId, resolve);
  });
}

/**
 * Resolve a pending approval. Returns true if a waiter was found, false if the
 * id was unknown (already resolved, or never registered — e.g. the card was
 * restored from history after the turn ended). Symmetric logging lets ops tell
 * a genuine resolve from a no-op replay.
 */
export function resolveApproval(approvalId: string, approved: boolean): boolean {
  const resolve = resolvers.get(approvalId);
  if (!resolve) {
    console.log(
      JSON.stringify({ level: 'info', event: 'approval_resolve_noop', approvalId, approved }),
    );
    return false;
  }
  resolvers.delete(approvalId);
  resolve(approved);
  console.log(JSON.stringify({ level: 'info', event: 'approval_resolved', approvalId, approved }));
  return true;
}

const SUMMARY_BY_CATEGORY: Record<ApprovalCardCategory, string> = {
  destructive_sandbox: 'This command looks destructive and was held for your approval.',
  git_override: 'This bypasses the git guard and was held for your approval.',
  remote_side_effect: 'This makes a remote change and was held for your approval.',
  capability_violation: 'This action is outside the granted capabilities.',
};

/** Best-effort extraction of the literal command/target to show verbatim. */
function extractCommand(toolName: string, args?: Record<string, unknown>): string | undefined {
  if (!args) return undefined;
  const candidate =
    toolName === 'sandbox_exec'
      ? (args.command ?? args.cmd)
      : (args.command ?? args.cmd ?? args.path ?? args.branch);
  return typeof candidate === 'string' && candidate.trim().length > 0
    ? candidate.trim()
    : undefined;
}

const KNOWN_CATEGORIES: ApprovalCardCategory[] = [
  'destructive_sandbox',
  'git_override',
  'remote_side_effect',
  'capability_violation',
];

/** Narrow an arbitrary gate-category string to a known card category,
 *  defaulting to the caution band for anything unrecognized (fail-safe). */
function coerceCategory(value: string): ApprovalCardCategory {
  return (KNOWN_CATEGORIES as string[]).includes(value)
    ? (value as ApprovalCardCategory)
    : 'destructive_sandbox';
}

/**
 * Map a gate hit into the card payload. The reason/recoveryPath come straight
 * from `ApprovalGateBlockedResult` so the user approves the real thing, not a
 * paraphrase.
 */
export function buildApprovalCardData(input: {
  approvalId: string;
  toolName: string;
  category: string;
  reason: string;
  recoveryPath: string;
  args?: Record<string, unknown>;
}): ApprovalCardData {
  const category = coerceCategory(input.category);
  return {
    approvalId: input.approvalId,
    toolName: input.toolName,
    category,
    summary: SUMMARY_BY_CATEGORY[category] ?? 'This action was held for your approval.',
    command: extractCommand(input.toolName, input.args),
    reason: input.recoveryPath ? `${input.reason} · ${input.recoveryPath}` : input.reason,
    status: 'pending',
  };
}

// ---------------------------------------------------------------------------
// Card injection seam — registered once by the chat layer
// (chat-card-actions.ts); called by requestApproval to surface the card.
// ---------------------------------------------------------------------------

let cardInjector: ((chatId: string, data: ApprovalCardData) => void) | null = null;

/** Register (or clear with null) the function that renders an approval card. */
export function setApprovalCardInjector(
  fn: ((chatId: string, data: ApprovalCardData) => void) | null,
): void {
  cardInjector = fn;
}

/**
 * Entry point the runtime-wired `approvalCallback` calls when a policy gate
 * suspends a tool call. Builds the card, surfaces it via the registered
 * injector, and returns the promise the card's Approve/Reject resolves. Fails
 * CLOSED (denies) when no injector is registered — there is no UI to ask, so
 * proceeding would bypass the gate.
 */
export async function requestApproval(
  chatId: string,
  req: ApprovalRequest,
  signal?: AbortSignal,
): Promise<boolean> {
  const approvalId = createId();
  const data = buildApprovalCardData({
    approvalId,
    toolName: req.toolName,
    category: req.category,
    reason: req.reason,
    recoveryPath: req.recoveryPath,
    args: req.args,
  });
  if (!cardInjector) {
    console.log(
      JSON.stringify({
        level: 'warn',
        event: 'approval_no_injector',
        approvalId,
        tool: req.toolName,
      }),
    );
    return false;
  }
  cardInjector(chatId, data);
  const decision = registerApproval(approvalId);
  // If the turn is aborted (Stop) while the card is pending, deny so the
  // suspended tool call unblocks instead of hanging the round loop forever.
  if (signal) {
    if (signal.aborted) resolveApproval(approvalId, false);
    else signal.addEventListener('abort', () => resolveApproval(approvalId, false), { once: true });
  }
  return decision;
}
