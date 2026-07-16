/**
 * ids.ts — pushd request/approval ID generation.
 *
 * Extracted from cli/pushd.ts (Pushd Decomposition Plan, Phase 1). Pure
 * generators; no daemon runtime state.
 *
 * `makeAttachToken` deliberately does NOT live here — every session creation
 * path (daemon + TUI + CLI) mints through the one helper in
 * `cli/session-store.ts`, and `cli/pushd.ts` re-exports it from there.
 */
import { randomBytes } from 'node:crypto';

export function makeRequestId(): string {
  return `req_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

export function makeApprovalId(): string {
  return `appr_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}
