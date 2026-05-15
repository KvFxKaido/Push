/**
 * App-side wrapper around the shared approval-gates module in `lib/`.
 *
 * The lib factory takes a `modeProvider` so it stays free of browser
 * storage. Web wires `getApprovalMode()` (safeStorage-backed) here.
 */

import {
  createDefaultApprovalGates as createDefaultApprovalGatesLib,
  type ApprovalGateOptions as ApprovalGateOptionsLib,
} from '@push/lib/approval-gates';
import { getApprovalMode } from './approval-mode';

export {
  ApprovalGateRegistry,
  describeToolCapabilities,
  buildCapabilityApprovalPrompt,
  type ApprovalMode,
  type ApprovalGateCategory,
  type ApprovalGateDecision,
  type ApprovalGateRule,
  type ApprovalGateBlockedResult,
} from '@push/lib/approval-gates';

export interface ApprovalGateOptions {
  /** Override the default safeStorage-backed mode provider. */
  modeProvider?: ApprovalGateOptionsLib['modeProvider'];
}

/**
 * Creates an `ApprovalGateRegistry` pre-loaded with the standard gates.
 * Defaults to reading approval mode via `getApprovalMode()` (safeStorage).
 */
export function createDefaultApprovalGates(options?: ApprovalGateOptions) {
  return createDefaultApprovalGatesLib({
    modeProvider: options?.modeProvider ?? getApprovalMode,
  });
}
