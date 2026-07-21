import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { executeToolCall as _rawExecuteToolCall, TOOL_PROTOCOL } from '../tools.ts';
import { roleCanUseTool } from '../../lib/capabilities.ts';

const execFileAsync = promisify(execFile);

// Default role: coder (grants git:branch, which git_switch_branch requires).
const executeToolCall = (call, root, opts = {}) =>
  _rawExecuteToolCall(call, root, { role: 'coder', ...opts });

async function makeRepoWithBranches() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-switch-branch-'));
  const git = (args) => execFileAsync('git', args, { cwd: dir });
  await git(['init', '-q', '-b', 'main']);
  await git(['config', 'user.email', 'test@push.dev']);
  await git(['config', 'user.name', 'Push Test']);
  await git(['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(dir, 'a.txt'), 'hello\n');
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'init']);
  // A second branch to switch to.
  await git(['branch', 'feature/widget']);
  return dir;
}

async function currentBranch(dir) {
  const { stdout } = await execFileAsync('git', ['branch', '--show-current'], { cwd: dir });
  return stdout.trim();
}

// A `--depth=1 --single-branch` clone of a bare origin that also carries a
// second branch the clone does NOT have — the web-sandbox clone shape. The
// clone must go through a file:// URL: git silently ignores `--depth` on
// plain-path local clones.
async function makeSingleBranchClone() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'push-single-branch-'));
  const origin = path.join(base, 'origin.git');
  await execFileAsync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  const seed = path.join(base, 'seed');
  await execFileAsync('git', ['clone', '-q', origin, seed]);
  const git = (args) => execFileAsync('git', args, { cwd: seed });
  await git(['config', 'user.email', 'test@push.dev']);
  await git(['config', 'user.name', 'Push Test']);
  await git(['config', 'commit.gpgsign', 'false']);
  await fs.writeFile(path.join(seed, 'a.txt'), 'hello\n');
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'init']);
  await git(['push', '-q', 'origin', 'HEAD:main']);
  await git(['checkout', '-q', '-b', 'draft/auto/widget']);
  await fs.writeFile(path.join(seed, 'b.txt'), 'draft\n');
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'draft']);
  await git(['push', '-q', 'origin', 'draft/auto/widget']);
  const work = path.join(base, 'work');
  await execFileAsync('git', [
    'clone',
    '-q',
    '--depth=1',
    '--single-branch',
    '-b',
    'main',
    pathToFileURL(origin).href,
    work,
  ]);
  return { base, work };
}

describe('git_switch_branch', () => {
  let repo;
  beforeEach(async () => {
    repo = await makeRepoWithBranches();
  });
  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it('switches to an existing branch', async () => {
    assert.equal(await currentBranch(repo), 'main');
    const result = await executeToolCall(
      { tool: 'git_switch_branch', args: { branch: 'feature/widget' } },
      repo,
    );
    assert.equal(result.ok, true, result.text);
    assert.equal(result.meta?.branch, 'feature/widget');
    assert.equal(await currentBranch(repo), 'feature/widget');
  });

  it('accepts the switch_branch and sandbox_switch_branch aliases', async () => {
    let result = await executeToolCall(
      { tool: 'switch_branch', args: { branch: 'feature/widget' } },
      repo,
    );
    assert.equal(result.ok, true, result.text);
    assert.equal(await currentBranch(repo), 'feature/widget');

    result = await executeToolCall(
      { tool: 'sandbox_switch_branch', args: { branch: 'main' } },
      repo,
    );
    assert.equal(result.ok, true, result.text);
    assert.equal(await currentBranch(repo), 'main');
  });

  it('git_create_branch accepts the create_branch / sandbox_create_branch aliases', async () => {
    let result = await executeToolCall(
      { tool: 'create_branch', args: { name: 'feature/alpha' } },
      repo,
    );
    assert.equal(result.ok, true, result.text);
    assert.equal(await currentBranch(repo), 'feature/alpha');

    result = await executeToolCall(
      { tool: 'sandbox_create_branch', args: { name: 'feature/beta', from: 'main' } },
      repo,
    );
    assert.equal(result.ok, true, result.text);
    assert.equal(await currentBranch(repo), 'feature/beta');
  });

  it('rejects an invalid branch ref without touching git', async () => {
    const result = await executeToolCall(
      { tool: 'git_switch_branch', args: { branch: '--evil' } },
      repo,
    );
    assert.equal(result.ok, false);
    assert.equal(result.structuredError?.code, 'INVALID_ARG');
    assert.equal(await currentBranch(repo), 'main', 'branch must be unchanged');
  });

  it('returns a structured GIT_ERROR for a nonexistent branch', async () => {
    const result = await executeToolCall(
      { tool: 'git_switch_branch', args: { branch: 'does/not/exist' } },
      repo,
    );
    assert.equal(result.ok, false);
    assert.equal(result.structuredError?.code, 'GIT_ERROR');
    assert.equal(await currentBranch(repo), 'main');
  });

  it('normalizes remote-prefixed branch input to the plain branch name', async () => {
    for (const spelled of ['origin/feature/widget', 'remotes/origin/feature/widget']) {
      await executeToolCall({ tool: 'git_switch_branch', args: { branch: 'main' } }, repo);
      const result = await executeToolCall(
        { tool: 'git_switch_branch', args: { branch: spelled } },
        repo,
      );
      assert.equal(result.ok, true, `${spelled}: ${result.text}`);
      assert.equal(result.meta?.branch, 'feature/widget');
      assert.equal(await currentBranch(repo), 'feature/widget');
    }
  });

  it('reaches a branch absent from a single-branch shallow clone (the web-sandbox clone shape)', async () => {
    const { base, work } = await makeSingleBranchClone();
    try {
      assert.equal(await currentBranch(work), 'main');
      const result = await executeToolCall(
        { tool: 'git_switch_branch', args: { branch: 'draft/auto/widget' } },
        work,
      );
      assert.equal(result.ok, true, result.text);
      assert.equal(await currentBranch(work), 'draft/auto/widget');
      // The retried switch must also set up tracking (the refspec-widening
      // path DWIMs from origin/<branch>, which configures upstream).
      const { stdout } = await execFileAsync(
        'git',
        ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
        { cwd: work },
      );
      assert.equal(stdout.trim(), 'origin/draft/auto/widget');
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it('is advertised in the tool protocol', () => {
    assert.match(TOOL_PROTOCOL, /git_switch_branch\(branch\)/);
  });

  it('requires git:branch — same grant matrix as git_create_branch', () => {
    // git_switch_branch must mirror git_create_branch exactly, so any future
    // grant change moves them together.
    for (const role of ['coder', 'orchestrator', 'explorer']) {
      assert.equal(
        roleCanUseTool(role, 'git_switch_branch', 'local-daemon'),
        roleCanUseTool(role, 'git_create_branch', 'local-daemon'),
        `git_switch_branch grant for ${role} should match git_create_branch`,
      );
    }
    // Both coder and orchestrator can branch in local-daemon (local working
    // tree — see capabilities.ts; the CLI inline loop runs as orchestrator).
    // Explorer is read-only.
    assert.equal(roleCanUseTool('coder', 'git_switch_branch', 'local-daemon'), true);
    assert.equal(roleCanUseTool('orchestrator', 'git_switch_branch', 'local-daemon'), true);
    assert.equal(roleCanUseTool('explorer', 'git_switch_branch', 'local-daemon'), false);
  });

  it('denies the explorer role end-to-end (no branch change)', async () => {
    const result = await _rawExecuteToolCall(
      { tool: 'git_switch_branch', args: { branch: 'feature/widget' } },
      repo,
      { role: 'explorer' },
    );
    assert.equal(result.ok, false);
    assert.equal(result.structuredError?.code, 'ROLE_CAPABILITY_DENIED');
    assert.equal(await currentBranch(repo), 'main');
  });
});
