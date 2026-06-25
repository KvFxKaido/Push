/**
 * CLI persistence for audit eval pairs.
 *
 * Wires the pure `AuditEvalRecorder` (`lib/audit-eval-pairs.ts`) to a durable,
 * append-only JSONL trainset under the workspace `.push/` directory. The
 * recorder is the shared logic; this module owns the CLI-side I/O and the
 * per-workspace singleton so a rejection observed on one commit attempt can be
 * paired with the SAFE correction on a later attempt within the same process.
 *
 * The trainset file (`.push/audit-evals.jsonl`) is the replayable corpus: each
 * line is one rejection→correction case (see `AuditEvalTrainsetCase`). Feeding
 * a case's `correctedDiff` back through `runAuditor` should stay SAFE; its
 * `rejectedDiff` should reproduce UNSAFE.
 *
 * Everything here is best-effort: a failed append is logged (stderr, matching
 * the gate's fail-open posture) and swallowed — capturing training data must
 * never interfere with a commit.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  AuditEvalRecorder,
  serializeTrainsetLine,
  type AuditEvalPair,
  type AuditVerdictObservation,
} from '../lib/audit-eval-pairs.ts';

export const AUDIT_EVAL_TRAINSET_RELPATH = path.join('.push', 'audit-evals.jsonl');

function trainsetPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, AUDIT_EVAL_TRAINSET_RELPATH);
}

async function appendPair(workspaceRoot: string, pair: AuditEvalPair): Promise<void> {
  const file = trainsetPath(workspaceRoot);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, serializeTrainsetLine(pair), 'utf8');
    console.error(
      JSON.stringify({
        level: 'info',
        event: 'audit_eval_pair_persisted',
        repo: pair.scope.repoFullName,
        branch: pair.scope.branch ?? null,
        file: AUDIT_EVAL_TRAINSET_RELPATH,
      }),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({ level: 'warn', event: 'audit_eval_pair_persist_failed', error: message }),
    );
  }
}

// One recorder per workspace root — the in-memory pending map must survive
// across gate invocations within a process, but stay isolated between
// workspaces (the daemon may serve more than one).
const recorders = new Map<string, AuditEvalRecorder>();

function getRecorder(workspaceRoot: string): AuditEvalRecorder {
  let recorder = recorders.get(workspaceRoot);
  if (!recorder) {
    recorder = new AuditEvalRecorder({
      onPair: (pair) => appendPair(workspaceRoot, pair),
    });
    recorders.set(workspaceRoot, recorder);
  }
  return recorder;
}

/**
 * Feed one Auditor commit-gate verdict to the workspace's recorder. Best-effort
 * and self-contained: any failure is logged and swallowed so the gate's outcome
 * is never affected. Called from `makeAuditorPreCommitGate` on every verdict.
 */
export async function recordAuditGateVerdict(
  workspaceRoot: string,
  observation: AuditVerdictObservation,
): Promise<void> {
  try {
    await getRecorder(workspaceRoot).observe(observation);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({ level: 'warn', event: 'audit_eval_record_failed', error: message }),
    );
  }
}

/** Test seam — drop the cached recorders so each test starts clean. */
export function __resetAuditEvalRecordersForTest(): void {
  recorders.clear();
}
