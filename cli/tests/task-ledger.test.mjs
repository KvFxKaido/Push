import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  normalizeTaskLedgerScope,
  normalizeTaskLedgerSteps,
  taskLedgerScopeKey,
  taskLikelyRequiresMutation,
} from '../../lib/task-ledger.ts';
import {
  clearTaskLedger,
  loadTaskLedger,
  saveTaskLedger,
  TaskLedgerRevisionConflictError,
  taskLedgerFilePath,
} from '../task-ledger-store.ts';

const scope = { repoFullName: 'KvFxKaido/Push', branch: 'codex/task-ledger-1547' };
let tmpRoot;
let previousStoreRoot;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-task-ledger-'));
  previousStoreRoot = process.env.PUSH_TASK_LEDGER_DIR;
  process.env.PUSH_TASK_LEDGER_DIR = tmpRoot;
});

afterEach(async () => {
  if (previousStoreRoot === undefined) delete process.env.PUSH_TASK_LEDGER_DIR;
  else process.env.PUSH_TASK_LEDGER_DIR = previousStoreRoot;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('shared task ledger', () => {
  it('uses a normalized repo plus exact branch as the durable scope', () => {
    const normalized = normalizeTaskLedgerScope(scope);
    assert.deepEqual(normalized, {
      repoFullName: 'kvfxkaido/push',
      branch: 'codex/task-ledger-1547',
    });
    assert.notEqual(
      taskLedgerScopeKey(normalized),
      taskLedgerScopeKey({ ...normalized, branch: 'main' }),
    );
  });

  it('normalizes untrusted steps and preserves one current step', () => {
    const steps = normalizeTaskLedgerSteps([
      { id: 'a', content: ' First ', activeForm: ' Doing first ', status: 'in_progress' },
      { id: 'a', content: 'Second', activeForm: 'Doing second', status: 'in_progress' },
      { id: '', content: 'Invalid', activeForm: 'Invalid', status: 'pending' },
    ]);
    assert.deepEqual(steps, [
      { id: 'a', content: 'First', activeForm: 'Doing first', status: 'in_progress' },
      { id: 'a-1', content: 'Second', activeForm: 'Doing second', status: 'pending' },
    ]);
  });

  it('persists, reloads, and clears independently of a CLI session', async () => {
    const step = {
      id: 'implement',
      content: 'Implement the monitor',
      activeForm: 'Implementing the monitor',
      status: 'in_progress',
    };
    const saved = await saveTaskLedger(scope, [step]);
    assert.equal(saved.scope.repoFullName, 'kvfxkaido/push');
    assert.equal(saved.revision, 1);
    assert.deepEqual((await loadTaskLedger(scope)).steps, [step]);
    assert.match(taskLedgerFilePath(scope), /^[\s\S]*[a-f0-9]{64}\.json$/);

    const cleared = await clearTaskLedger(scope, { expectedRevision: saved.revision });
    assert.equal(cleared.revision, 2);
    assert.deepEqual((await loadTaskLedger(scope)).steps, []);
  });

  it('quarantines corrupt JSON, emits a structured warning, and resumes empty', async () => {
    const file = taskLedgerFilePath(scope);
    await fs.writeFile(file, '{"steps": [', 'utf8');
    const warnings = [];
    const originalConsoleError = console.error;
    console.error = (...args) => warnings.push(args.join(' '));
    try {
      const loaded = await loadTaskLedger(scope);
      assert.deepEqual(loaded.steps, []);
      assert.equal(loaded.revision, 0);
    } finally {
      console.error = originalConsoleError;
    }

    await assert.rejects(fs.access(file));
    const quarantined = (await fs.readdir(tmpRoot)).filter((name) => name.includes('.corrupt-'));
    assert.equal(quarantined.length, 1);
    assert.ok(
      warnings.some((line) => {
        const event = JSON.parse(line);
        return event.event === 'task_ledger_corrupt_recovered';
      }),
      'missing structured corrupt-ledger recovery warning',
    );
  });

  it('rejects one of two concurrent writers based on the same revision', async () => {
    const initial = await saveTaskLedger(scope, [
      {
        id: 'initial',
        content: 'Initial step',
        activeForm: 'Running initial step',
        status: 'in_progress',
      },
    ]);
    const candidates = [
      [{ id: 'writer-a', content: 'Writer A', activeForm: 'Running A', status: 'in_progress' }],
      [{ id: 'writer-b', content: 'Writer B', activeForm: 'Running B', status: 'in_progress' }],
    ];
    const results = await Promise.allSettled(
      candidates.map((steps) =>
        saveTaskLedger(scope, steps, { expectedRevision: initial.revision }),
      ),
    );

    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected');
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof TaskLedgerRevisionConflictError);
    assert.equal(rejected[0].reason.current.revision, initial.revision + 1);

    const stored = await loadTaskLedger(scope);
    assert.equal(stored.revision, initial.revision + 1);
    assert.deepEqual(stored.steps, fulfilled[0].value.steps);
  });

  it('lets exactly one process through when several reclaim the same stale lock', async () => {
    // Real processes, not async tasks: the race is between separate lock
    // contenders that each judge the same dead-owner lock stale. When stale
    // takeover unlinked the lock by path, one could delete the lock another
    // had just acquired, letting two writers with the same expected revision
    // both succeed.
    const contender = fileURLToPath(new URL('./task-ledger-lock-contender.mjs', import.meta.url));
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    const file = taskLedgerFilePath(scope);
    const rounds = 4;
    const contenders = 8;

    for (let round = 0; round < rounds; round += 1) {
      const base = await saveTaskLedger(scope, [
        { id: `base-${round}`, content: 'Base', activeForm: 'Running base', status: 'in_progress' },
      ]);
      // Plant a dead owner holding the current epoch, so every contender has
      // to take over from it rather than find a released lock.
      const lockDir = `${file}.lockdir`;
      const current = Math.max(
        -1,
        ...(await fs.readdir(lockDir))
          .filter((entry) => entry.endsWith('.owner'))
          .map((entry) => Number(entry.slice(0, -'.owner'.length))),
      );
      await fs.writeFile(
        path.join(lockDir, `${current + 1}.owner`),
        JSON.stringify({ pid: deadPid, createdAt: Date.now() - 60_000 }),
        { mode: 0o600 },
      );
      const goFile = path.join(tmpRoot, `go-${round}`);
      const children = Array.from({ length: contenders }, (_, index) => {
        const child = spawn(process.execPath, ['--import', 'tsx', contender], {
          env: {
            ...process.env,
            CONTENDER_ID: `${round}-${index}`,
            CONTENDER_GO_FILE: goFile,
            CONTENDER_EXPECTED_REVISION: String(base.revision),
            CONTENDER_SCOPE: JSON.stringify(scope),
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        // Reject (rather than hang) if a contender fails to start or exits
        // before reporting ready; a late reject after resolve is a no-op.
        const ready = new Promise((resolve, reject) => {
          child.stdout.on('data', (chunk) => {
            stdout += chunk;
            if (stdout.includes('ready\n')) resolve();
          });
          child.on('error', reject);
          child.on('close', (code) =>
            reject(new Error(`contender exited (${code}) before ready: ${stderr}`)),
          );
        });
        const done = new Promise((resolve) => {
          child.on('close', (code) => resolve({ code, stdout, stderr }));
        });
        return { child, ready, done };
      });
      try {
        await Promise.all(children.map((contender) => contender.ready));
      } catch (error) {
        for (const contender of children) contender.child.kill();
        throw error;
      }
      await fs.writeFile(goFile, '');
      const outcomes = await Promise.all(children.map((child) => child.done));

      const results = outcomes.map(
        (outcome) => outcome.stdout.match(/result:(\S+)/)?.[1] ?? `none:${outcome.stderr}`,
      );
      assert.equal(
        results.filter((result) => result === 'ok').length,
        1,
        `round ${round}: expected exactly one writer through the lock, got ${results.join(', ')}`,
      );
      assert.equal(results.filter((result) => result === 'conflict').length, contenders - 1);
      const stored = await loadTaskLedger(scope);
      assert.equal(stored.revision, base.revision + 1);
      // Released and garbage-collected: only the final epoch's owner and
      // release marker remain.
      const remaining = (await fs.readdir(lockDir)).sort();
      assert.equal(remaining.length, 2, `unexpected lock entries: ${remaining.join(', ')}`);
      const [lastOwner, lastReleased] = remaining;
      assert.match(lastOwner, /^\d+\.owner$/);
      assert.equal(lastReleased, lastOwner.replace('.owner', '.released'));
    }
  });

  it('only enables the no-mutation signal for explicit change requests', () => {
    assert.equal(taskLikelyRequiresMutation('Please implement issue 1547'), true);
    assert.equal(taskLikelyRequiresMutation("Let's pick up issue 1547"), true);
    assert.equal(taskLikelyRequiresMutation('Review issue 1547 and explain the tradeoffs'), false);
  });
});
