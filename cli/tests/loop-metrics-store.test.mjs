import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendLoopMetricsRecord,
  getLoopMetricsDir,
  getLoopMetricsFile,
} from '../loop-metrics-store.ts';

let tmpDir;
let prevEnv;

before(async () => {
  prevEnv = process.env.PUSH_LOOP_METRICS_DIR;
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-loop-metrics-'));
  process.env.PUSH_LOOP_METRICS_DIR = tmpDir;
});

after(async () => {
  if (prevEnv === undefined) delete process.env.PUSH_LOOP_METRICS_DIR;
  else process.env.PUSH_LOOP_METRICS_DIR = prevEnv;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function sampleMetrics() {
  return {
    total: 4,
    byLevel: { none: 2, warn: 1, block: 1, compact: 0, abort: 0 },
    byAction: { none: 4, warn: 0, block: 0, compact: 0, abort: 0 },
    enforcedActions: 0,
    darkSuppressed: 2,
    recent: [
      {
        surface: 'cli',
        level: 'warn',
        action: 'none',
        enforced: false,
        reasons: ['near-duplicate writes streak 4 at 90% similarity'],
        similarity: 0.9,
        round: 3,
        at: 111,
      },
    ],
  };
}

describe('loop-metrics-store', () => {
  it('honors PUSH_LOOP_METRICS_DIR', () => {
    assert.equal(getLoopMetricsDir(), tmpDir);
    assert.equal(getLoopMetricsFile(), path.join(tmpDir, 'verdicts.jsonl'));
  });

  it('appends a parseable JSONL record', async () => {
    await appendLoopMetricsRecord({
      at: 1000,
      surface: 'cli',
      sessionId: 'sess-1',
      runId: 'run-1',
      outcome: 'success',
      rounds: 4,
      metrics: sampleMetrics(),
    });

    const lines = (await fs.readFile(getLoopMetricsFile(), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed.sessionId, 'sess-1');
    assert.equal(parsed.outcome, 'success');
    assert.equal(parsed.metrics.darkSuppressed, 2);
    assert.equal(parsed.metrics.recent[0].level, 'warn');
  });

  it('appends additional records as separate lines', async () => {
    await appendLoopMetricsRecord({
      at: 2000,
      surface: 'cli',
      sessionId: 'sess-2',
      metrics: sampleMetrics(),
    });

    const lines = (await fs.readFile(getLoopMetricsFile(), 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1]).sessionId, 'sess-2');
  });

  it('creates the directory if it does not exist', async () => {
    const nested = path.join(tmpDir, 'nested', 'deeper');
    process.env.PUSH_LOOP_METRICS_DIR = nested;
    try {
      await appendLoopMetricsRecord({
        at: 3000,
        surface: 'cli',
        sessionId: 'sess-3',
        metrics: sampleMetrics(),
      });
      const content = await fs.readFile(path.join(nested, 'verdicts.jsonl'), 'utf8');
      assert.match(content, /sess-3/);
    } finally {
      process.env.PUSH_LOOP_METRICS_DIR = tmpDir;
    }
  });
});
