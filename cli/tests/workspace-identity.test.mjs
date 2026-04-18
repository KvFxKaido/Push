/**
 * Unit tests for the git-remote URL parser and workspace identity
 * resolver. The parser has enough variance (https vs ssh, presence
 * or absence of `.git` suffix, non-GitHub hosts) that the wrong
 * output would silently produce wrong `repoFullName` values across
 * the memory surface. These pins are cheap defense.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

import { parseGitRemoteUrl, resolveWorkspaceIdentity } from '../workspace-identity.ts';

const execFileAsync = promisify(execFile);

describe('parseGitRemoteUrl', () => {
  const cases = [
    // HTTPS forms
    ['https://github.com/owner/repo.git', 'owner/repo'],
    ['https://github.com/owner/repo', 'owner/repo'],
    ['https://gitlab.com/group/project.git', 'group/project'],
    ['https://bitbucket.org/team/thing', 'team/thing'],
    // SSH shorthand
    ['git@github.com:owner/repo.git', 'owner/repo'],
    ['git@github.com:owner/repo', 'owner/repo'],
    ['git@gitlab.example.com:group/project.git', 'group/project'],
    // SSH URL form
    ['ssh://git@github.com/owner/repo.git', 'owner/repo'],
    ['ssh://git@github.com:22/owner/repo', 'owner/repo'],
    // Extra whitespace tolerated
    ['  https://github.com/owner/repo.git  \n', 'owner/repo'],
  ];

  for (const [input, expected] of cases) {
    it(`parses "${input}" → ${expected}`, () => {
      assert.equal(parseGitRemoteUrl(input), expected);
    });
  }

  it('returns null for unparseable strings', () => {
    assert.equal(parseGitRemoteUrl(''), null);
    assert.equal(parseGitRemoteUrl('not a url'), null);
    assert.equal(parseGitRemoteUrl('https://example.com'), null);
    assert.equal(parseGitRemoteUrl('https://example.com/single-segment'), null);
  });

  it('handles nested path segments (uses the last two)', () => {
    // Some hosts like self-hosted Gitea use group/subgroup/repo shapes.
    // Our retrieval keys on owner/repo; the penultimate and last
    // segments win. This matches what web does with its scoped
    // retrieval.
    assert.equal(parseGitRemoteUrl('https://gitea.example.com/group/sub/repo.git'), 'sub/repo');
  });
});

// ---------------------------------------------------------------------------
// resolveWorkspaceIdentity — real git integration
// ---------------------------------------------------------------------------

let tmpRoot;

before(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-wsid-'));
});

after(async () => {
  if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true });
});

async function initGitRepo(dir, { remote = null, branch = 'main' } = {}) {
  await execFileAsync('git', ['init', '-q', '-b', branch], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await execFileAsync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'README.md'), '# test\n', 'utf8');
  await execFileAsync('git', ['add', '.'], { cwd: dir });
  await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  if (remote) {
    await execFileAsync('git', ['remote', 'add', 'origin', remote], { cwd: dir });
  }
}

describe('resolveWorkspaceIdentity', () => {
  it('reads repo + branch from a real git repo with an origin remote', async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, 'repo-'));
    await initGitRepo(dir, { remote: 'https://github.com/push-test/fixture.git', branch: 'main' });

    const id = await resolveWorkspaceIdentity(dir);
    assert.equal(id.repoFullName, 'push-test/fixture');
    assert.equal(id.branch, 'main');
  });

  it('falls back to basename(cwd) when there is no git repo', async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, 'no-git-'));
    const id = await resolveWorkspaceIdentity(dir);
    assert.equal(id.repoFullName, path.basename(dir));
    assert.equal(id.branch, null);
  });

  it('falls back to basename(cwd) when the repo has no origin remote', async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, 'no-remote-'));
    await initGitRepo(dir);
    const id = await resolveWorkspaceIdentity(dir);
    assert.equal(id.repoFullName, path.basename(dir));
    // initGitRepo() initializes with `git init -b main`, so the
    // branch is deterministic regardless of local config.
    assert.equal(id.branch, 'main');
  });

  it('treats detached HEAD as no branch (avoids a HEAD.jsonl file)', async () => {
    const dir = await fs.mkdtemp(path.join(tmpRoot, 'detached-'));
    await initGitRepo(dir, { remote: 'https://github.com/push-test/detached.git' });
    // Checkout the HEAD commit directly to enter detached state.
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: dir });
    const sha = stdout.trim();
    await execFileAsync('git', ['checkout', '-q', '--detach', sha], { cwd: dir });

    const id = await resolveWorkspaceIdentity(dir);
    assert.equal(id.repoFullName, 'push-test/detached');
    assert.equal(id.branch, null);
  });
});
