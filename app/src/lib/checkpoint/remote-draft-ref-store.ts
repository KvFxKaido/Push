/**
 * RemoteDraftRefCheckpointStore — the web/cloud CheckpointStore backend.
 *
 * A THIN delegating adapter over the existing B2 auto-back primitives
 * (`backUpWorkingTree` / `detectAutoBackRestore` / `applyAutoBackRestore`). It
 * does not reimplement or restructure them — it only maps their shapes onto the
 * storage-agnostic CheckpointStore contract, so freshly-shipped auto-back code
 * stays untouched and authoritative.
 *
 * Dedup token: the coordinator threads an opaque token; this store encodes the
 * auto-back `(tree, head)` pair as `tree:head` and decodes it back. Both are git
 * shas (head may be the literal `none` for an unborn HEAD), neither contains a
 * colon, so the split is unambiguous.
 */

import { backUpWorkingTree, type AutoBackResult } from '../sandbox-auto-back';
import { applyAutoBackRestore, detectAutoBackRestore } from '../sandbox-auto-back-restore';
import type {
  CheckpointCaptureInput,
  CheckpointCaptureResult,
  CheckpointDetectInput,
  CheckpointRecord,
  CheckpointRestoreAvailability,
  CheckpointRestoreInput,
  CheckpointRestoreResult,
  CheckpointStore,
} from './checkpoint-store';

/** `tree:head` → the auto-back dedup pin (undefined when no/!malformed token). */
function decodeToken(token: string | undefined): { tree: string; head: string } | undefined {
  if (!token) return undefined;
  const sep = token.indexOf(':');
  if (sep <= 0 || sep === token.length - 1) return undefined;
  return { tree: token.slice(0, sep), head: token.slice(sep + 1) };
}

const encodeToken = (tree: string, head: string): string => `${tree}:${head}`;

function toCaptureResult(result: AutoBackResult): CheckpointCaptureResult {
  switch (result.status) {
    case 'backed-up':
      return { status: 'captured', dedupToken: encodeToken(result.tree, result.head) };
    case 'unchanged':
      return { status: 'unchanged', dedupToken: encodeToken(result.tree, result.head) };
    case 'clean':
      return { status: 'clean' };
    case 'skipped':
      return { status: 'skipped', reason: result.reason };
    case 'blocked':
      return { status: 'blocked', reason: result.reason };
    case 'failed':
      return { status: 'failed', reason: result.reason };
  }
}

export const remoteDraftRefCheckpointStore: CheckpointStore = {
  kind: 'remote-draft-ref',

  async capture(input: CheckpointCaptureInput): Promise<CheckpointCaptureResult> {
    const prior = decodeToken(input.priorToken);
    const result = await backUpWorkingTree(input.sandboxId, input.branch, {
      lastBackedTree: prior?.tree,
      lastBackedHead: prior?.head,
    });
    return toCaptureResult(result);
  },

  async detectRestore(input: CheckpointDetectInput): Promise<CheckpointRestoreAvailability> {
    const availability = await detectAutoBackRestore(input.sandboxId, input.branch);
    if (!availability.available) return { available: false, reason: availability.reason };
    // The backup commit sha is the store-local checkpoint handle.
    return { available: true, checkpointId: availability.sha, summary: availability.summary };
  },

  async restore(input: CheckpointRestoreInput): Promise<CheckpointRestoreResult> {
    const result = await applyAutoBackRestore(input.sandboxId, input.branch, input.checkpointId);
    switch (result.status) {
      case 'restored':
        return { status: 'restored', checkpointId: result.sha };
      case 'skipped-dirty':
        return { status: 'skipped-dirty' };
      case 'failed':
        return { status: 'failed', reason: result.reason };
    }
  },

  // The remote backend keeps a single force-updated draft ref per branch, not a
  // history — there's nothing to enumerate. `detectRestore` is the "is the one
  // backup there?" query; `list` is a degenerate empty here (the on-device store
  // is where a real checkpoint history lives).
  async list(): Promise<CheckpointRecord[]> {
    return [];
  },
};
