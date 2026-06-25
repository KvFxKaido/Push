/**
 * Audit eval pairs — capture Auditor rejection→correction transitions as a
 * replayable regression trainset.
 *
 * The idea (borrowed from dspyer's "failed self-corrections logged as
 * input/output pairs you can replay as a trainset", reimplemented first-party
 * against Push's own Auditor gate rather than depending on DSPy): every time
 * the Auditor commit gate blocks a diff as UNSAFE and a *later* commit on the
 * same branch passes as SAFE, that transition is a worked example of "code the
 * Auditor flagged, then the fix that satisfied it". Collected over time these
 * become a regression corpus for the Auditor kernel — replay the corrected diff
 * and assert it stays SAFE; replay the rejected diff and assert the Auditor
 * still catches the original issue.
 *
 * This module is the pure core: a stateful `AuditEvalRecorder` that observes
 * the verdict stream the gate already produces, plus serializers to/from a
 * replayable JSONL trainset. It owns no I/O — the surface (CLI gate today)
 * supplies the persistence sink and the durable scope. Per the cross-surface
 * storage rule, the scope is the durable `repoFullName + branch`, not a
 * per-run id, so pairs survive across CLI invocations once a file-backed sink
 * is wired.
 *
 * Structured logs go to `console.error`: this module is shared `lib/` consumed
 * by the CLI, where stdout is reserved for user output / `--json`. Same
 * shape and event-pairing as `lib/context-memory.ts` and `lib/git/repo-lock.ts`.
 */

import type { MemoryScope } from './runtime-contract.js';
import { parseDiffStats } from './diff-utils.js';

/** Durable scope for an eval pair — repo + branch, never a per-run id. */
export type AuditEvalScope = Pick<MemoryScope, 'repoFullName' | 'branch'>;

export interface AuditEvalRisk {
  level: 'low' | 'medium' | 'high';
  description: string;
}

/** One verdict observed by the commit gate — the recorder's input event. */
export interface AuditVerdictObservation {
  scope: AuditEvalScope;
  /** The staged diff the Auditor verdict was rendered over. */
  diff: string;
  verdict: 'safe' | 'unsafe';
  summary: string;
  risks: AuditEvalRisk[];
  /** Caller-supplied timestamp (the recorder stays free of `Date.now()`). */
  at: number;
}

/** A captured rejection→correction transition — one trainset example. */
export interface AuditEvalPair {
  scope: AuditEvalScope;
  /** The diff the Auditor rejected as UNSAFE, with the risks it flagged. */
  rejected: {
    diff: string;
    summary: string;
    risks: AuditEvalRisk[];
    at: number;
  };
  /** The later diff on the same scope the Auditor accepted as SAFE. */
  corrected: {
    diff: string;
    summary: string;
    at: number;
  };
  /**
   * Files changed in both the rejected and corrected diffs — the overlap that
   * ties the correction to the rejection (empty only when overlap is not
   * required; see `requireFileOverlap`).
   */
  sharedFiles: string[];
}

function logEvent(level: 'debug' | 'warn', event: string, ctx: Record<string, unknown>): void {
  // stderr, not stdout — see module header. Mirrors lib/context-memory.ts.
  console.error(JSON.stringify({ level, event, ...ctx }));
}

function scopeKey(scope: AuditEvalScope): string {
  // NUL separator: branch names can't contain it, so this can't collide a
  // repo/branch boundary the way a `/` or `:` separator could.
  return `${scope.repoFullName}\u0000${scope.branch ?? ''}`;
}

function changedFiles(diff: string): string[] {
  return parseDiffStats(diff).fileNames;
}

const DEFAULT_MAX_PAIR_AGE_MS = 24 * 60 * 60 * 1000; // 24h

export interface AuditEvalRecorderOptions {
  /**
   * Drop a pending rejection if the SAFE correction arrives more than this
   * long after it — past the window the two are probably unrelated work, not a
   * fix. Default 24h.
   */
  maxPairAgeMs?: number;
  /**
   * Require the corrected diff to touch at least one file the rejected diff
   * touched before pairing them. Default `true` — a SAFE commit that shares no
   * files with the rejection is unrelated work, not the fix, so the pending
   * rejection is kept (a real fix may still arrive within the age window)
   * rather than mispaired. Set `false` to pair on any next SAFE verdict.
   */
  requireFileOverlap?: boolean;
  /**
   * Persistence sink for captured pairs. Best-effort: a throw (or rejected
   * promise) is swallowed and logged — a failing sink must never block the
   * commit gate, which only borrows this recorder on its happy path.
   */
  onPair?: (pair: AuditEvalPair) => void | Promise<void>;
}

interface PendingRejection {
  observation: AuditVerdictObservation;
  files: string[];
}

/**
 * Stateful tracker over the gate's verdict stream. Holds at most one pending
 * rejection per scope (the most recent UNSAFE), and emits an `AuditEvalPair`
 * the first time a qualifying SAFE verdict lands on that scope.
 *
 * In-memory by design: the durable artifact is the JSONL trainset the `onPair`
 * sink writes, not the recorder's pending map. A process restart loses an
 * un-corrected pending rejection, which is the right default — a rejection with
 * no observed correction isn't a complete example anyway.
 */
export class AuditEvalRecorder {
  private readonly pending = new Map<string, PendingRejection>();
  private readonly maxPairAgeMs: number;
  private readonly requireFileOverlap: boolean;
  private readonly onPair?: (pair: AuditEvalPair) => void | Promise<void>;

  constructor(options: AuditEvalRecorderOptions = {}) {
    this.maxPairAgeMs = options.maxPairAgeMs ?? DEFAULT_MAX_PAIR_AGE_MS;
    this.requireFileOverlap = options.requireFileOverlap ?? true;
    this.onPair = options.onPair;
  }

  /**
   * Feed one gate verdict. Returns the captured pair when this observation
   * completes a rejection→correction transition, else `null`. Every branch
   * emits a structured log so the capture path is observable (symmetric
   * recorded ↔ captured ↔ expired ↔ no-overlap ↔ no-pending).
   */
  async observe(observation: AuditVerdictObservation): Promise<AuditEvalPair | null> {
    const key = scopeKey(observation.scope);
    const files = changedFiles(observation.diff);

    if (observation.verdict === 'unsafe') {
      this.pending.set(key, { observation, files });
      logEvent('debug', 'audit_eval_rejection_recorded', {
        repo: observation.scope.repoFullName,
        branch: observation.scope.branch ?? null,
        files: files.length,
        risks: observation.risks.length,
      });
      return null;
    }

    // verdict === 'safe'
    const pending = this.pending.get(key);
    if (!pending) {
      logEvent('debug', 'audit_eval_pair_no_pending', {
        repo: observation.scope.repoFullName,
        branch: observation.scope.branch ?? null,
      });
      return null;
    }

    const age = observation.at - pending.observation.at;
    if (age > this.maxPairAgeMs) {
      this.pending.delete(key);
      logEvent('warn', 'audit_eval_pair_expired', {
        repo: observation.scope.repoFullName,
        branch: observation.scope.branch ?? null,
        ageMs: age,
        maxPairAgeMs: this.maxPairAgeMs,
      });
      return null;
    }

    const pendingFiles = new Set(pending.files);
    const sharedFiles = files.filter((f) => pendingFiles.has(f));
    if (this.requireFileOverlap && sharedFiles.length === 0) {
      // Unrelated SAFE commit — keep the pending rejection (its real fix may
      // still arrive within the age window) rather than mispairing.
      logEvent('debug', 'audit_eval_pair_no_overlap', {
        repo: observation.scope.repoFullName,
        branch: observation.scope.branch ?? null,
      });
      return null;
    }

    this.pending.delete(key);
    const pair: AuditEvalPair = {
      scope: { repoFullName: observation.scope.repoFullName, branch: observation.scope.branch },
      rejected: {
        diff: pending.observation.diff,
        summary: pending.observation.summary,
        risks: pending.observation.risks,
        at: pending.observation.at,
      },
      corrected: {
        diff: observation.diff,
        summary: observation.summary,
        at: observation.at,
      },
      sharedFiles,
    };

    logEvent('debug', 'audit_eval_pair_captured', {
      repo: observation.scope.repoFullName,
      branch: observation.scope.branch ?? null,
      sharedFiles: sharedFiles.length,
      ageMs: age,
    });

    if (this.onPair) {
      try {
        await this.onPair(pair);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logEvent('warn', 'audit_eval_pair_sink_failed', {
          repo: observation.scope.repoFullName,
          branch: observation.scope.branch ?? null,
          error: message,
        });
      }
    }

    return pair;
  }

  /** Pending (un-corrected) rejection count — for diagnostics/tests. */
  pendingCount(): number {
    return this.pending.size;
  }
}

// ---------------------------------------------------------------------------
// Trainset serialization — the durable, replayable artifact
// ---------------------------------------------------------------------------

/**
 * One replayable regression case derived from a captured pair. Replay
 * semantics: feed `correctedDiff` to `runAuditor` and assert the verdict stays
 * `safe` (the fix must not regress); feed `rejectedDiff` and assert the verdict
 * is `unsafe` (the Auditor must still catch the original issue). `priorRisks`
 * is what the Auditor flagged on the rejection — useful for asserting the
 * replayed UNSAFE verdict still names the same class of risk.
 */
export interface AuditEvalTrainsetCase {
  /** Deterministic id (scope + timestamps fingerprint — no RNG, replay-stable). */
  id: string;
  scope: AuditEvalScope;
  correctedDiff: string;
  expectedVerdict: 'safe';
  rejectedDiff: string;
  priorVerdict: 'unsafe';
  priorRisks: AuditEvalRisk[];
  rejectedSummary: string;
  correctedSummary: string;
  sharedFiles: string[];
  capturedAt: number;
}

function fingerprint(value: string): string {
  // FNV-1a — same algorithm lib/auditor-agent.ts uses for its coalesce key.
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function toTrainsetCase(pair: AuditEvalPair): AuditEvalTrainsetCase {
  const id = `aep_${fingerprint(`${scopeKey(pair.scope)}\u0000${pair.rejected.at}\u0000${pair.corrected.at}`)}`;
  return {
    id,
    scope: pair.scope,
    correctedDiff: pair.corrected.diff,
    expectedVerdict: 'safe',
    rejectedDiff: pair.rejected.diff,
    priorVerdict: 'unsafe',
    priorRisks: pair.rejected.risks,
    rejectedSummary: pair.rejected.summary,
    correctedSummary: pair.corrected.summary,
    sharedFiles: pair.sharedFiles,
    capturedAt: pair.corrected.at,
  };
}

/** Serialize a captured pair as one JSONL trainset line (trailing newline). */
export function serializeTrainsetLine(pair: AuditEvalPair): string {
  return JSON.stringify(toTrainsetCase(pair)) + '\n';
}

/** Serialize many pairs to a JSONL trainset blob. */
export function serializeTrainset(pairs: AuditEvalPair[]): string {
  return pairs.map(serializeTrainsetLine).join('');
}

/**
 * Parse a JSONL trainset blob back into cases for replay. Malformed lines are
 * skipped (logged), not fatal — a corrupt line shouldn't sink an otherwise
 * usable corpus. Blank lines are ignored.
 */
export function parseTrainset(jsonl: string): AuditEvalTrainsetCase[] {
  const cases: AuditEvalTrainsetCase[] = [];
  const lines = jsonl.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      cases.push(JSON.parse(line) as AuditEvalTrainsetCase);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logEvent('warn', 'audit_eval_trainset_line_parse_failed', { line: i + 1, error: message });
    }
  }
  return cases;
}
