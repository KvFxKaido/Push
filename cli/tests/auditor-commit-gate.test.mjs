import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { executeToolCall as _rawExecuteToolCall } from '../tools.ts';

const execFileAsync = promisify(execFile);

// Default role: 'coder' so the kernel role check admits these direct-executor
// tests (mirrors tools-new.test.mjs).
const executeToolCall = (call, root, opts = {}) =>
  _rawExecuteToolCall(call, root, { role: 'coder', ...opts });

async function makeRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-auditor-gate-'));
  await execFileAsync('git', ['init', '-q'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@push.dev'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Push Test'], { cwd: dir });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  return dir;
}

describe('git_commit Auditor gate', () => {
  let repo;
  const savedEnv = process.env.PUSH_AUDITOR_GATE;

  beforeEach(async () => {
    repo = await makeRepo();
    delete process.env.PUSH_AUDITOR_GATE;
  });

  afterEach(async () => {
    if (savedEnv === undefined) delete process.env.PUSH_AUDITOR_GATE;
    else process.env.PUSH_AUDITOR_GATE = savedEnv;
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('commits normally when the gate is explicitly off (auditorGate: false)', async () => {
    await fs.writeFile(path.join(repo, 'a.txt'), 'hello\n');
    const result = await executeToolCall({ tool: 'git_commit', args: { message: 'add a' } }, repo, {
      auditorGate: false,
    });
    assert.equal(result.ok, true, result.text);
    assert.equal(result.meta?.auditorGate, undefined, 'no gate metadata when off');
    assert.equal(result.meta?.card?.type, 'commit-list');
    assert.equal(result.meta?.card?.data.commits[0]?.author, 'Push Test');
    const { stdout } = await execFileAsync('git', ['log', '--oneline'], { cwd: repo });
    assert.match(stdout, /add a/);
  });

  it('fails closed when the gate is on but no provider is configured', async () => {
    await fs.writeFile(path.join(repo, 'b.txt'), 'world\n');
    const result = await executeToolCall(
      { tool: 'git_commit', args: { message: 'add b' } },
      repo,
      // gate on, but no providerId/model/key → must block (fail-closed),
      // never silently commit.
      { auditorGate: true, providerId: '', model: '' },
    );
    assert.equal(result.ok, false);
    assert.equal(result.structuredError?.code, 'AUDITOR_UNSAFE');
    assert.match(result.text, /Auditor/i);
    // The commit must NOT have landed.
    const { stdout } = await execFileAsync('git', ['log', '--oneline'].concat(), {
      cwd: repo,
    }).catch((err) => ({ stdout: err.stdout || '' }));
    assert.doesNotMatch(stdout, /add b/, 'blocked commit must not be in history');
  });

  it('PUSH_AUDITOR_GATE=0 overrides auditorGate:true and lets the commit through', async () => {
    process.env.PUSH_AUDITOR_GATE = '0';
    await fs.writeFile(path.join(repo, 'c.txt'), 'env-off\n');
    const result = await executeToolCall({ tool: 'git_commit', args: { message: 'add c' } }, repo, {
      auditorGate: true,
      providerId: '',
      model: '',
    });
    assert.equal(result.ok, true, result.text);
    const { stdout } = await execFileAsync('git', ['log', '--oneline'], { cwd: repo });
    assert.match(stdout, /add c/);
  });
});
