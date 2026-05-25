/**
 * loop-metrics-store.ts — durable JSONL export for loop-detection telemetry.
 *
 * The near-duplicate loop-detection ladder ships DARK (see
 * `lib/loop-detection.ts`): it computes a verdict every turn but only enforces
 * under `PUSH_LOOP_DETECTION=1`. `lib/loop-metrics.ts` aggregates those
 * verdicts in memory; this module persists a per-run summary so the dark data
 * survives the process and can be aggregated across runs to answer "how often
 * would the ladder have fired, and were those real loops?".
 *
 * Layout: one append-only file at `<dir>/verdicts.jsonl`, one JSON object per
 * top-level run that recorded at least one non-`none` verdict. `dir` is
 * `~/.push/loop-metrics` by default, overridable via `PUSH_LOOP_METRICS_DIR`
 * (matching the `PUSH_MEMORY_DIR` / `PUSH_SESSION_DIR` env-var pattern).
 *
 * Durability: append-only, relies on the OS's append atomicity for the
 * per-run line (one writer per run; pushd is single-process). Best-effort —
 * the caller swallows write errors so telemetry never breaks a run.
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { LoopMetrics } from '../lib/loop-metrics.ts';

export function getLoopMetricsDir(): string {
  if (process.env.PUSH_LOOP_METRICS_DIR) return process.env.PUSH_LOOP_METRICS_DIR;
  return path.join(os.homedir(), '.push', 'loop-metrics');
}

export function getLoopMetricsFile(): string {
  return path.join(getLoopMetricsDir(), 'verdicts.jsonl');
}

export interface LoopMetricsRunRecord {
  at: number;
  surface: 'cli';
  sessionId: string;
  runId?: string;
  outcome?: string;
  rounds?: number;
  metrics: LoopMetrics;
}

export async function appendLoopMetricsRecord(record: LoopMetricsRunRecord): Promise<void> {
  const dir = getLoopMetricsDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = getLoopMetricsFile();
  await fs.appendFile(file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
  // `appendFile`'s `mode` only applies when it creates the file, so chmod
  // best-effort to keep telemetry non-world-readable even if the file predates
  // this (or a permissive umask widened it) — matching the 0600 convention the
  // config writer uses for `~/.push`.
  await fs.chmod(file, 0o600).catch(() => {});
}
