import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runAuditEvalsSubcommand } from '../audit-eval-replay.ts';
import { AUDIT_EVAL_TRAINSET_RELPATH } from '../audit-eval-store.ts';

function caseLine(overrides = {}) {
  return (
    JSON.stringify({
      id: 'aep_test0001',
      scope: { repoFullName: 'kvfxkaido/push', branch: 'feat/x' },
      correctedDiff: 'diff --git a/src/a.ts b/src/a.ts\n+const t = process.env.TOKEN;\n',
      expectedVerdict: 'safe',
      rejectedDiff: 'diff --git a/src/a.ts b/src/a.ts\n+const t = "sk-live";\n',
      priorVerdict: 'unsafe',
      priorRisks: [{ level: 'high', description: 'hardcoded secret' }],
      rejectedSummary: 'secret',
      correctedSummary: 'env var',
      sharedFiles: ['src/a.ts'],
      capturedAt: 2000,
      ...overrides,
    }) + '\n'
  );
}

async function writeCorpus(root, lines) {
  const file = path.join(root, AUDIT_EVAL_TRAINSET_RELPATH);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, lines.join(''), 'utf8');
}

// Capture process.stdout.write for the duration of `fn`.
async function captureStdout(fn) {
  const original = process.stdout.write.bind(process.stdout);
  let buf = '';
  process.stdout.write = (chunk) => {
    buf += chunk;
    return true;
  };
  try {
    const code = await fn();
    return { code, out: buf };
  } finally {
    process.stdout.write = original;
  }
}

describe('push audit-evals command', () => {
  let root;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-audit-replay-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('list --json reports the corpus cases', async () => {
    await writeCorpus(root, [caseLine(), caseLine({ id: 'aep_test0002' })]);
    const { code, out } = await captureStdout(() =>
      runAuditEvalsSubcommand({ cwd: root, json: true }, ['audit-evals', 'list']),
    );
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.equal(parsed.existed, true);
    assert.equal(parsed.cases.length, 2);
  });

  it('list --json on a missing corpus reports existed:false', async () => {
    const { code, out } = await captureStdout(() =>
      runAuditEvalsSubcommand({ cwd: root, json: true }, ['audit-evals', 'list']),
    );
    assert.equal(code, 0);
    const parsed = JSON.parse(out);
    assert.equal(parsed.existed, false);
    assert.deepEqual(parsed.cases, []);
  });

  it('replay on an empty corpus exits 0 without needing a provider', async () => {
    const { code, out } = await captureStdout(() =>
      runAuditEvalsSubcommand({ cwd: root }, ['audit-evals', 'replay']),
    );
    assert.equal(code, 0);
    assert.match(out, /No audit-eval corpus yet/);
  });

  it('replay exits 1 when the provider has no API key', async () => {
    await writeCorpus(root, [caseLine()]);
    const savedKeys = {};
    for (const k of ['PUSH_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY', 'VITE_OPENROUTER_API_KEY']) {
      savedKeys[k] = process.env[k];
      delete process.env[k];
    }
    try {
      const { code, out } = await captureStdout(() =>
        runAuditEvalsSubcommand({ cwd: root, provider: 'openrouter' }, ['audit-evals', 'replay']),
      );
      assert.equal(code, 1);
      assert.match(out, /Cannot replay/);
    } finally {
      for (const [k, v] of Object.entries(savedKeys)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('rejects an unknown subcommand', async () => {
    await assert.rejects(
      () => runAuditEvalsSubcommand({ cwd: root }, ['audit-evals', 'frobnicate']),
      /Unknown audit-evals subcommand/,
    );
  });
});
