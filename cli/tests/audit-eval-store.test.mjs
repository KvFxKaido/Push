import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  recordAuditGateVerdict,
  __resetAuditEvalRecordersForTest,
  AUDIT_EVAL_TRAINSET_RELPATH,
} from '../audit-eval-store.ts';

const SCOPE = { repoFullName: 'kvfxkaido/push', branch: 'feat/x' };

function diffFor(file, line) {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    '@@ -1 +1 @@',
    `+${line}`,
    '',
  ].join('\n');
}

async function readTrainset(root) {
  const file = path.join(root, AUDIT_EVAL_TRAINSET_RELPATH);
  const text = await fs.readFile(file, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe('audit eval store (CLI persistence)', () => {
  let root;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-audit-eval-'));
    __resetAuditEvalRecordersForTest();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('persists a rejection→correction pair as a JSONL trainset line', async () => {
    await recordAuditGateVerdict(root, {
      scope: SCOPE,
      diff: diffFor('src/a.ts', 'const t = "sk-live-abc";'),
      verdict: 'unsafe',
      summary: 'hardcoded secret',
      risks: [{ level: 'high', description: 'hardcoded secret' }],
      at: 1_000,
    });

    // No pair yet — only a pending rejection, nothing written.
    await assert.rejects(() => readTrainset(root));

    await recordAuditGateVerdict(root, {
      scope: SCOPE,
      diff: diffFor('src/a.ts', 'const t = process.env.TOKEN;'),
      verdict: 'safe',
      summary: 'uses env var',
      risks: [],
      at: 2_000,
    });

    const cases = await readTrainset(root);
    assert.equal(cases.length, 1);
    const [c] = cases;
    assert.equal(c.expectedVerdict, 'safe');
    assert.equal(c.priorVerdict, 'unsafe');
    assert.match(c.correctedDiff, /process\.env\.TOKEN/);
    assert.match(c.rejectedDiff, /sk-live-abc/);
    assert.deepEqual(c.sharedFiles, ['src/a.ts']);
    assert.match(c.id, /^aep_[0-9a-f]{8}$/);
  });

  it('does not write a line for a SAFE verdict with no prior rejection', async () => {
    await recordAuditGateVerdict(root, {
      scope: SCOPE,
      diff: diffFor('src/a.ts', 'const x = 1;'),
      verdict: 'safe',
      summary: 'ok',
      risks: [],
      at: 1_000,
    });
    await assert.rejects(() => readTrainset(root));
  });

  it('appends across separate calls within a process (durable pending)', async () => {
    // Two independent rejection→correction cycles append two lines.
    for (const [i, file] of [
      ['a', 'src/a.ts'],
      ['b', 'src/b.ts'],
    ]) {
      void i;
      await recordAuditGateVerdict(root, {
        scope: SCOPE,
        diff: diffFor(file, 'bad'),
        verdict: 'unsafe',
        summary: 'risk',
        risks: [{ level: 'high', description: 'risk' }],
        at: 1_000,
      });
      await recordAuditGateVerdict(root, {
        scope: SCOPE,
        diff: diffFor(file, 'good'),
        verdict: 'safe',
        summary: 'fixed',
        risks: [],
        at: 2_000,
      });
    }
    const cases = await readTrainset(root);
    assert.equal(cases.length, 2);
  });
});
