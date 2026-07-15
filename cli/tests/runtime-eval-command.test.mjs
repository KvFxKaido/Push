import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { parseRuntimeEvalJsonl, runRuntimeEvalSubcommand } from '../runtime-eval-command.ts';

function event(type, payload, index, overrides = {}) {
  return {
    v: 'push.runtime.v1',
    kind: 'event',
    sessionId: 'sess_eval',
    runId: 'run_eval',
    seq: index + 1,
    ts: 1_000 + index * 10,
    type,
    payload,
    ...overrides,
  };
}

function jsonl(events) {
  return `${events.map((candidate) => JSON.stringify(candidate)).join('\n')}\n`;
}

async function withFixture(files, run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-runtime-eval-command-'));
  try {
    await Promise.all(
      Object.entries(files).map(([name, contents]) =>
        fs.writeFile(path.join(root, name), contents),
      ),
    );
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe('push eval command', () => {
  it('prints a passing receipt and exits zero without a policy file', async () => {
    await withFixture(
      {
        'run.jsonl': jsonl([
          event('run_complete', { runId: 'run_eval', outcome: 'success', summary: 'done' }, 0),
        ]),
      },
      async (root) => {
        let output = '';
        const code = await runRuntimeEvalSubcommand({}, ['eval', 'run.jsonl'], {
          cwd: root,
          write: (text) => {
            output += text;
          },
        });

        assert.equal(code, 0);
        assert.match(output, /^verdict: pass/m);
        assert.match(output, /PASS receipt\.valid/);
        assert.match(output, /run: run_eval/);
      },
    );
  });

  it('loads an explicit policy, selects one run, and keeps score misses non-blocking', async () => {
    const oldRun = event(
      'run_complete',
      { runId: 'run_old', outcome: 'failed', summary: 'failed' },
      0,
      { runId: 'run_old' },
    );
    const targetRun = [
      event('assistant.turn_start', { round: 1 }, 1, { runId: 'run_target' }),
      event('run_complete', { runId: 'run_target', outcome: 'success', summary: 'done' }, 2, {
        runId: 'run_target',
      }),
    ];

    await withFixture(
      {
        'runs.jsonl': jsonl([oldRun, ...targetRun]),
        'policy.json': JSON.stringify({ version: 1, scores: { maxRounds: 0 } }),
      },
      async (root) => {
        let output = '';
        const code = await runRuntimeEvalSubcommand(
          { json: true, policy: 'policy.json', 'run-id': 'run_target' },
          ['eval', 'runs.jsonl'],
          {
            cwd: root,
            write: (text) => {
              output += text;
            },
          },
        );
        const result = JSON.parse(output);

        assert.equal(code, 0);
        assert.equal(result.verdict, 'score_miss');
        assert.equal(result.runId, 'run_target');
        assert.deepEqual(result.scores, [
          { id: 'maxRounds', status: 'miss', actual: 1, threshold: 0 },
        ]);
      },
    );
  });

  it('returns exit one when an explicit gate fails', async () => {
    await withFixture(
      {
        'run.jsonl': jsonl([
          event('run_complete', { runId: 'run_eval', outcome: 'success', summary: 'done' }, 0),
        ]),
        'policy.json': JSON.stringify({
          version: 1,
          gates: { requiredTools: ['exec'] },
        }),
      },
      async (root) => {
        let output = '';
        const code = await runRuntimeEvalSubcommand(
          { policy: 'policy.json' },
          ['eval', 'run.jsonl'],
          {
            cwd: root,
            write: (text) => {
              output += text;
            },
          },
        );

        assert.equal(code, 1);
        assert.match(output, /^verdict: fail/m);
        assert.match(output, /FAIL tools\.required\.exec/);
      },
    );
  });

  it('reports the line for malformed JSONL and rejects empty receipts', () => {
    assert.throws(
      () => parseRuntimeEvalJsonl('{}\nnot-json\n', 'fixture'),
      /fixture contains invalid JSON on line 2/,
    );
    assert.throws(() => parseRuntimeEvalJsonl('\n\r\n', 'fixture'), /fixture contains no events/);
  });
});
