import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCommandToolCard,
  buildCommitToolCard,
  buildDelegationResultToolCard,
  buildEditDiffToolCard,
  buildGitStatusToolCard,
  buildTextChangeToolCard,
  buildTypeCheckToolCard,
} from '../../lib/tool-card-producers.ts';

describe('tool card producers', () => {
  it('declares test results from a test command outcome', () => {
    const card = buildCommandToolCard({
      command: 'pnpm run test:cli',
      stdout: 'Tests: 12 passed, 1 failed, 13 total\n2 skipped',
      stderr: '',
      exitCode: 1,
      durationMs: 42,
    });

    assert.equal(card.type, 'test-results');
    assert.deepEqual(
      {
        passed: card.data.passed,
        failed: card.data.failed,
        skipped: card.data.skipped,
        total: card.data.total,
        exitCode: card.data.exitCode,
      },
      { passed: 12, failed: 1, skipped: 2, total: 13, exitCode: 1 },
    );
  });

  it('parses unordered Jest summaries and successful summaries with no failed count', () => {
    const failedFirst = buildCommandToolCard({
      command: 'npm test',
      stdout: 'Test Suites: 1 failed, 1 total\nTests: 1 failed, 2 passed, 3 total',
      stderr: '',
      exitCode: 1,
      durationMs: 10,
    });
    assert.equal(failedFirst.type, 'test-results');
    assert.deepEqual(
      {
        passed: failedFirst.data.passed,
        failed: failedFirst.data.failed,
        total: failedFirst.data.total,
      },
      { passed: 2, failed: 1, total: 3 },
    );

    const allPassed = buildCommandToolCard({
      command: 'pnpm test',
      stdout: 'Tests: 3 passed, 3 total',
      stderr: '',
      exitCode: 0,
      durationMs: 8,
    });
    assert.equal(allPassed.type, 'test-results');
    assert.deepEqual(
      {
        passed: allPassed.data.passed,
        failed: allPassed.data.failed,
        total: allPassed.data.total,
      },
      { passed: 3, failed: 0, total: 3 },
    );
  });

  it('declares parsed typecheck errors from a typecheck command outcome', () => {
    const card = buildCommandToolCard({
      command: 'pnpm run typecheck',
      stdout: 'src/app.ts(4,7): error TS2322: Type number is not assignable to string.',
      stderr: '',
      exitCode: 2,
      durationMs: 12,
    });

    assert.equal(card.type, 'type-check');
    assert.equal(card.data.tool, 'tsc');
    assert.equal(card.data.errorCount, 1);
    assert.deepEqual(card.data.errors[0], {
      file: 'src/app.ts',
      line: 4,
      column: 7,
      message: 'Type number is not assignable to string.',
      code: 'TS2322',
    });
  });

  it('falls back to a bounded sandbox card for a generic command', () => {
    const card = buildCommandToolCard({
      command: 'echo hello',
      stdout: 'hello\n',
      stderr: '',
      exitCode: 0,
      durationMs: 3,
    });
    assert.equal(card.type, 'sandbox');
    assert.equal(card.data.stdout, 'hello\n');
    assert.equal(card.data.durationMs, 3);
  });

  it('converts structured edit outcomes to diff-preview cards', () => {
    const card = buildEditDiffToolCard({
      path: 'src/app.ts',
      adds: 1,
      dels: 1,
      lines: [
        { kind: 'del', oldLine: 1, text: 'const x = 1;' },
        { kind: 'add', newLine: 1, text: 'const x = 2;' },
      ],
    });

    assert.equal(card.type, 'diff-preview');
    assert.equal(card.data.filesChanged, 1);
    assert.equal(card.data.additions, 1);
    assert.equal(card.data.deletions, 1);
    assert.match(card.data.diff, /\+const x = 2;/);

    const fromContent = buildTextChangeToolCard('src/app.ts', 'const x = 1;\n', 'const x = 2;\n');
    assert.equal(fromContent?.type, 'diff-preview');
    assert.equal(fromContent?.data.additions, 1);
    assert.equal(fromContent?.data.deletions, 1);

    const truncated = buildEditDiffToolCard({
      path: 'generated.ts',
      adds: 200,
      dels: 5,
      lines: Array.from({ length: 80 }, (_, index) => ({
        kind: 'add',
        newLine: index + 1,
        text: `line ${index + 1}`,
      })),
      truncated: true,
    });
    assert.equal(truncated.type, 'diff-preview');
    assert.equal(truncated.data.additions, 200);
    assert.equal(truncated.data.deletions, 5);
    assert.equal(truncated.data.truncated, true);
  });

  it('builds structured diagnostics, commit, and delegation outcomes', () => {
    const diagnostics = buildTypeCheckToolCard({
      tool: 'pyright',
      diagnostics: [
        { file: 'app.py', line: 2, col: 3, severity: 'error', message: 'Unknown name' },
      ],
      exitCode: 1,
    });
    assert.equal(diagnostics.type, 'type-check');
    assert.equal(diagnostics.data.errors[0].column, 3);

    const commit = buildCommitToolCard({
      repo: 'acme/push',
      sha: 'abc1234',
      message: 'Ship cards',
      author: 'Ada',
      date: '2026-07-13T00:00:00Z',
    });
    assert.equal(commit.type, 'commit-list');
    assert.equal(commit.data.commits[0].sha, 'abc1234');

    const delegation = buildDelegationResultToolCard({
      status: 'complete',
      summary: 'Mapped the flow.',
      rounds: 2,
      checkpoints: 0,
      elapsedMs: 50,
      gateVerdicts: [],
      missingRequirements: [],
    });
    assert.equal(delegation.type, 'delegation-result');
    assert.equal(delegation.data.agent, 'explorer');
  });

  it('builds a bounded local workspace-state card from git status', () => {
    const preview = Array.from({ length: 14 }, (_, index) =>
      index === 0 ? `M src/${'x'.repeat(300)}.ts\nspoofed` : `?? file-${index}.txt`,
    );
    const card = buildGitStatusToolCard({
      repoPath: '/workspace/push',
      branch: 'feat/cards',
      statusLine: 'Branch: feat/cards → origin/feat/cards [ahead 1]',
      changedFiles: 14,
      stagedFiles: 1,
      unstagedFiles: 2,
      untrackedFiles: 11,
      preview,
      fetchedAt: '2026-07-14T00:00:00.000Z',
    });

    assert.equal(card.type, 'sandbox-state');
    assert.equal(card.data.sandboxId, 'local-daemon');
    assert.equal(card.data.changedFiles, 14);
    assert.equal(card.data.preview.length, 12);
    assert.equal(card.data.preview[0].includes('\n'), false);
    assert.ok(card.data.preview[0].endsWith('…'));
    assert.equal(card.data.fetchedAt, '2026-07-14T00:00:00.000Z');
  });
});
