import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadUserGoalFile,
  seedUserGoalFile,
  resolveGoalFilePath,
  extractDigestBody,
  GOAL_FILE_RELATIVE_PATH,
} from '../user-goal-file.ts';

// Each test owns a fresh tempdir so seed/load fixtures don't bleed.
async function makeTempCwd() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'push-goal-file-'));
}

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

describe('resolveGoalFilePath', () => {
  it('always joins cwd with .push/goal.md', () => {
    const cwd = '/some/workspace';
    assert.equal(resolveGoalFilePath(cwd), path.join(cwd, GOAL_FILE_RELATIVE_PATH));
    assert.equal(GOAL_FILE_RELATIVE_PATH, path.join('.push', 'goal.md'));
  });
});

describe('loadUserGoalFile', () => {
  it('returns null when the file does not exist', async () => {
    const cwd = await makeTempCwd();
    try {
      assert.equal(await loadUserGoalFile(cwd), null);
    } finally {
      await rmrf(cwd);
    }
  });

  it('returns null when the file is unparseable (no Initial ask)', async () => {
    const cwd = await makeTempCwd();
    try {
      const filePath = resolveGoalFilePath(cwd);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, '# Goal\n\n## Notes\n\nsome free-form prose\n', 'utf8');
      assert.equal(await loadUserGoalFile(cwd), null);
    } finally {
      await rmrf(cwd);
    }
  });

  it('parses a user-edited file with v2 fields', async () => {
    const cwd = await makeTempCwd();
    try {
      const filePath = resolveGoalFilePath(cwd);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        `# Goal

## Initial ask

ship the anchor feature

## Current working goal

wire goal.md + auto-seed

## Constraints

- preserve cache prefix

## Do not

- overwrite existing goal.md

## Last refreshed

2026-05-14T11:45:00Z
`,
        'utf8',
      );
      const anchor = await loadUserGoalFile(cwd);
      assert.deepEqual(anchor, {
        initialAsk: 'ship the anchor feature',
        currentWorkingGoal: 'wire goal.md + auto-seed',
        constraints: ['preserve cache prefix'],
        doNot: ['overwrite existing goal.md'],
        lastRefreshedAt: '2026-05-14T11:45:00Z',
      });
    } finally {
      await rmrf(cwd);
    }
  });
});

describe('seedUserGoalFile', () => {
  it('writes goal.md when absent and reports wrote: true', async () => {
    const cwd = await makeTempCwd();
    try {
      const result = await seedUserGoalFile(cwd, {
        firstUserTurn: 'help with X',
        workingGoalSeed: 'narrow to the file store',
        refreshedAt: '2026-05-14T11:45:00Z',
      });
      assert.equal(result.wrote, true);
      assert.equal(result.path, resolveGoalFilePath(cwd));

      // Round-trip: what we wrote parses back to what we passed.
      const anchor = await loadUserGoalFile(cwd);
      assert.deepEqual(anchor, {
        initialAsk: 'help with X',
        currentWorkingGoal: 'narrow to the file store',
        lastRefreshedAt: '2026-05-14T11:45:00Z',
      });
    } finally {
      await rmrf(cwd);
    }
  });

  it('never overwrites an existing goal.md (user-owned after first write)', async () => {
    const cwd = await makeTempCwd();
    try {
      const filePath = resolveGoalFilePath(cwd);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      const userEdited = `# Goal\n\n## Initial ask\n\nuser-owned goal\n`;
      await fs.writeFile(filePath, userEdited, 'utf8');

      const result = await seedUserGoalFile(cwd, {
        firstUserTurn: 'this would be the auto-seed',
        refreshedAt: '2026-05-14T11:45:00Z',
      });
      assert.equal(result.wrote, false);

      const onDisk = await fs.readFile(filePath, 'utf8');
      assert.equal(onDisk, userEdited);
    } finally {
      await rmrf(cwd);
    }
  });

  it('skips the write when firstUserTurn is empty after trim', async () => {
    const cwd = await makeTempCwd();
    try {
      const result = await seedUserGoalFile(cwd, {
        firstUserTurn: '   \n\t  ',
        refreshedAt: '2026-05-14T11:45:00Z',
      });
      assert.equal(result.wrote, false);
      assert.equal(await loadUserGoalFile(cwd), null);
    } finally {
      await rmrf(cwd);
    }
  });

  it('omits the working-goal section when no seed is provided', async () => {
    const cwd = await makeTempCwd();
    try {
      await seedUserGoalFile(cwd, {
        firstUserTurn: 'help with X',
        refreshedAt: '2026-05-14T11:45:00Z',
      });
      const anchor = await loadUserGoalFile(cwd);
      assert.deepEqual(anchor, {
        initialAsk: 'help with X',
        lastRefreshedAt: '2026-05-14T11:45:00Z',
      });
    } finally {
      await rmrf(cwd);
    }
  });

  it('creates the parent .push/ directory if absent', async () => {
    const cwd = await makeTempCwd();
    try {
      // Verify .push/ doesn't pre-exist.
      let preExisted = true;
      try {
        await fs.stat(path.join(cwd, '.push'));
      } catch {
        preExisted = false;
      }
      assert.equal(preExisted, false);

      const result = await seedUserGoalFile(cwd, {
        firstUserTurn: 'help with X',
        refreshedAt: '2026-05-14T11:45:00Z',
      });
      assert.equal(result.wrote, true);
      // Parent now exists.
      const stat = await fs.stat(path.join(cwd, '.push'));
      assert.equal(stat.isDirectory(), true);
    } finally {
      await rmrf(cwd);
    }
  });

  it('caps the seeded initial ask at the runtime budget', async () => {
    // Codex review on PR #549: without a cap on the write path, a pasted
    // log as the first user turn would be persisted raw and then
    // re-injected uncapped by subsequent rounds via loadUserGoalFile.
    const cwd = await makeTempCwd();
    try {
      const long = 'x'.repeat(2000);
      const result = await seedUserGoalFile(cwd, {
        firstUserTurn: long,
        refreshedAt: '2026-05-14T11:45:00Z',
      });
      assert.equal(result.wrote, true);
      const anchor = await loadUserGoalFile(cwd);
      assert.ok(anchor, 'expected parsed anchor');
      assert.ok(
        anchor.initialAsk.length < long.length,
        'initialAsk should have been truncated before write',
      );
      assert.ok(anchor.initialAsk.endsWith('...'), 'truncation marker present');
    } finally {
      await rmrf(cwd);
    }
  });

  it('returns wrote: false (does not throw) when mkdir cannot create parent', async () => {
    // Copilot review on PR #549: fs.mkdir was outside the try, so
    // EACCES/ENOSPC during directory creation rejected from
    // seedUserGoalFile despite the documented best-effort contract.
    const cwd = await makeTempCwd();
    try {
      // Create a *file* named `.push` so mkdir cannot create a directory
      // at the same path. Forces an ENOTDIR / EEXIST class failure on
      // the mkdir call itself — exactly the situation Copilot flagged.
      await fs.writeFile(path.join(cwd, '.push'), 'not a directory', 'utf8');

      const result = await seedUserGoalFile(cwd, {
        firstUserTurn: 'help with X',
        refreshedAt: '2026-05-14T11:45:00Z',
      });
      assert.equal(result.wrote, false);
      assert.equal(result.path, resolveGoalFilePath(cwd));
    } finally {
      await rmrf(cwd);
    }
  });
});

describe('extractDigestBody', () => {
  it('strips the [CONTEXT DIGEST] wrapper and the intro line', () => {
    const digest = `[CONTEXT DIGEST]
Earlier messages were condensed to fit the context budget:
- User: explain the sandbox restart bug
- Assistant: traced it to useWorkspaceSandboxController
[/CONTEXT DIGEST]`;
    assert.equal(
      extractDigestBody(digest),
      '- User: explain the sandbox restart bug\n- Assistant: traced it to useWorkspaceSandboxController',
    );
  });

  it('returns empty string when the wrapper is missing', () => {
    assert.equal(extractDigestBody('just some prose'), '');
    assert.equal(extractDigestBody(''), '');
  });

  it('tolerates a missing closing tag (best-effort extraction)', () => {
    const digest = `[CONTEXT DIGEST]
Earlier messages were condensed to fit the context budget:
- User: x`;
    assert.equal(extractDigestBody(digest), '- User: x');
  });
});
