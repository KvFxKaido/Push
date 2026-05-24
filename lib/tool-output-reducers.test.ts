import { describe, expect, it } from 'vitest';
import { reduceToolOutput } from './tool-output-reducers.ts';

function lines(n: number, make: (i: number) => string): string {
  return Array.from({ length: n }, (_, i) => make(i)).join('\n');
}

describe('reduceToolOutput — git status', () => {
  const fatStatus = [
    'On branch feature/big-change',
    "Your branch is ahead of 'origin/feature/big-change' by 3 commits.",
    '',
    'Changes not staged for commit:',
    '  (use "git add <file>..." to update what will be committed)',
    '  (use "git restore <file>..." to discard changes in working directory)',
    lines(40, (i) => `\tmodified:   src/file${String(i).padStart(2, '0')}.ts`),
    '',
    'Untracked files:',
    '  (use "git add <file>..." to include in what will be committed)',
    lines(10, (i) => `\tsrc/new${String(i).padStart(2, '0')}.ts`),
    '',
  ].join('\n');

  const out = reduceToolOutput({
    command: 'git status',
    stdout: fatStatus,
    stderr: '',
    exitCode: 0,
  });

  it('reduces and tags the right rule', () => {
    expect(out.reduced).toBe(true);
    expect(out.reducerId).toBe('git/status');
  });

  it('preserves branch and tracking lines', () => {
    expect(out.stdout).toContain('On branch feature/big-change');
    expect(out.stdout).toContain('Your branch is ahead');
  });

  it('preserves head and tail file names', () => {
    expect(out.stdout).toContain('src/file00.ts'); // in the head window
    expect(out.stdout).toContain('src/new09.ts'); // in the tail window
  });

  it('drops the repetitive restore/add hints', () => {
    expect(out.stdout).not.toContain('(use "git restore');
    expect(out.stdout).not.toContain('(use "git add');
  });
});

describe('reduceToolOutput — inventory', () => {
  const findOut = lines(120, (i) => `./src/module${i}/index.ts`);

  it('reduces find output to count + head/tail', () => {
    const out = reduceToolOutput({
      command: 'find . -type f -name "*.ts"',
      stdout: findOut,
      stderr: '',
      exitCode: 0,
    });
    expect(out.reduced).toBe(true);
    expect(out.reducerId).toBe('filesystem/inventory');
    expect(out.stdout).toContain('[120 entries]');
    expect(out.stdout).toContain('./src/module0/index.ts'); // head
    expect(out.stdout).toContain('./src/module119/index.ts'); // tail
    expect(out.stdout).toMatch(/entries omitted/);
  });

  it.each([
    ['ls -la /big/dir', lines(120, (i) => `entry-${i}.bin`), 'filesystem/inventory'],
    ['fd . src', lines(120, (i) => `src/f${i}.rs`), 'filesystem/inventory'],
    ['rg --files', lines(120, (i) => `pkg/x${i}.go`), 'filesystem/inventory'],
    ['git ls-files', lines(120, (i) => `app/c${i}.tsx`), 'filesystem/inventory'],
  ])('matches %s', (command, stdout, id) => {
    const out = reduceToolOutput({ command, stdout, stderr: '', exitCode: 0 });
    expect(out.reduced).toBe(true);
    expect(out.reducerId).toBe(id);
  });

  it('bails on unsafe / ambiguous shapes', () => {
    const big = lines(120, (i) => `./f${i}.ts`);
    expect(
      reduceToolOutput({ command: 'find . | head -50', stdout: big, stderr: '', exitCode: 0 }),
    ).toMatchObject({ reduced: false, reason: 'unsafe-command' });
    expect(
      reduceToolOutput({ command: 'find . && echo done', stdout: big, stderr: '', exitCode: 0 }),
    ).toMatchObject({ reduced: false, reason: 'unsafe-command' });
    expect(
      reduceToolOutput({
        command: 'find . -name "$(cat x)"',
        stdout: big,
        stderr: '',
        exitCode: 0,
      }),
    ).toMatchObject({ reduced: false, reason: 'unsafe-command' });
    expect(
      reduceToolOutput({ command: 'find . > out.txt', stdout: big, stderr: '', exitCode: 0 }),
    ).toMatchObject({ reduced: false, reason: 'unsafe-command' });
    expect(
      reduceToolOutput({
        command: 'find . -type f & echo bg',
        stdout: big,
        stderr: '',
        exitCode: 0,
      }),
    ).toMatchObject({ reduced: false, reason: 'unsafe-command' });
  });

  it('never touches raw file reads', () => {
    const big = lines(400, (i) => `line ${i} of a file we must not summarize`);
    expect(
      reduceToolOutput({ command: 'cat bigfile.txt', stdout: big, stderr: '', exitCode: 0 }),
    ).toMatchObject({ reduced: false, reason: 'file-read' });
    expect(
      reduceToolOutput({ command: 'head -200 bigfile.txt', stdout: big, stderr: '', exitCode: 0 }),
    ).toMatchObject({ reduced: false, reason: 'file-read' });
    expect(
      reduceToolOutput({ command: 'tail -200 bigfile.txt', stdout: big, stderr: '', exitCode: 0 }),
    ).toMatchObject({ reduced: false, reason: 'file-read' });
  });
});

describe('reduceToolOutput — check/test/typecheck/lint', () => {
  it('keeps a compact tail summary on success (exit 0)', () => {
    const stdout = [
      lines(60, (i) => `✓ src/feature.test.ts > does thing #${i}`),
      '',
      'Test Files  5 passed (5)',
      '     Tests  60 passed (60)',
    ].join('\n');
    const out = reduceToolOutput({ command: 'npx vitest run', stdout, stderr: '', exitCode: 0 });
    expect(out.reduced).toBe(true);
    expect(out.reducerId).toBe('check/test-typecheck-lint');
    expect(out.stdout).toContain('Tests  60 passed (60)'); // summary survives in tail
    expect(out.stdout).not.toContain('[summary:'); // failure-only counter not injected
    expect(out.reducedChars).toBeLessThan(out.originalChars);
  });

  it('preserves errors + counter on failure and never looks successful', () => {
    const stdout = [
      lines(200, (i) => `info: scanning module ${i}`),
      "src/a.ts(1,1): error TS2322: Type 'string' is not assignable to type 'number'.",
      'src/b.ts(4,9): error TS2304: Cannot find name "foo".',
      'src/c.ts(8,2): error TS7006: Parameter implicitly has an "any" type.',
      "src/d.ts(2,2): warning TS6133: 'x' is declared but its value is never read.",
      "src/e.ts(3,3): warning TS6133: 'y' is declared but its value is never read.",
      "src/f.ts(5,5): warning TS6133: 'z' is declared but its value is never read.",
    ].join('\n');
    const out = reduceToolOutput({ command: 'npm run typecheck', stdout, stderr: '', exitCode: 2 });

    expect(out.reduced).toBe(true);
    expect(out.reducerId).toBe('check/test-typecheck-lint');
    expect(out.stdout).toContain('[summary: 3 errors, 3 warnings]');
    // diagnostics (clustered at the tail) survive intact.
    expect(out.stdout).toContain('error TS2322');
    expect(out.stdout).toContain('warning TS6133');
    expect(out.stdout).toContain('error');
    // large noise body is trimmed (a mid-run line is gone).
    expect(out.stdout).not.toContain('info: scanning module 100');
  });

  it('preserves diagnostics on failure even with no error/warn tokens', () => {
    // A failing run whose output contains none of the trigger words must still
    // reach the model — the failure path never gates on keywords.
    const stdout = lines(300, (i) => `step ${i}: проверка модуля завершена`);
    const out = reduceToolOutput({ command: 'npm run check', stdout, stderr: '', exitCode: 1 });

    expect(out.reduced).toBe(true);
    expect(out.reducerId).toBe('check/test-typecheck-lint');
    expect(out.stdout.trim().length).toBeGreaterThan(0); // not emptied
    expect(out.stdout).toContain('step 0:'); // head context kept
    expect(out.stdout).toContain('step 299:'); // tail context kept
    expect(out.stdout).not.toContain('[summary:'); // no false error/warn counter
  });

  it('keeps stderr diagnostics on failure under the stderr stream', () => {
    const out = reduceToolOutput({
      command: 'eslint .',
      stdout: '',
      stderr: lines(120, (i) => `src/file${i}.ts:${i}:1  error  Unexpected console statement`),
      exitCode: 1,
    });
    expect(out.reduced).toBe(true);
    expect(out.stderr).toContain('Unexpected console statement'); // stays on stderr, not folded into stdout
    expect(out.stdout).toContain('[summary:'); // counter spans both streams
  });

  it('matches bare runners and npm/pnpm/npx wrappers', () => {
    // Lots of non-error chatter + a couple real errors → failure branch drops
    // the chatter, guaranteeing the reduction clears the threshold.
    const failing = [
      lines(80, (i) => `compiling module ${i}...`),
      'src/x.ts(1,1): error TS2322: bad type',
      'src/y.ts(2,2): error TS2304: missing name',
    ].join('\n');
    for (const command of [
      'tsc --noEmit',
      'eslint .',
      'jest',
      'pytest -q',
      'pnpm test',
      'npx vitest run',
    ]) {
      const out = reduceToolOutput({ command, stdout: failing, stderr: '', exitCode: 1 });
      expect(out.reduced).toBe(true);
      expect(out.reducerId).toBe('check/test-typecheck-lint');
    }
  });
});

describe('reduceToolOutput — passthrough & metadata', () => {
  it('passes small output through unchanged', () => {
    const smallStatus = reduceToolOutput({
      command: 'git status',
      stdout: 'On branch main\nnothing to commit, working tree clean',
      stderr: '',
      exitCode: 0,
    });
    expect(smallStatus).toMatchObject({ reduced: false, reason: 'below-threshold', savedChars: 0 });
    expect(smallStatus.stdout).toContain('working tree clean'); // unchanged

    const smallFind = reduceToolOutput({
      command: 'find . -maxdepth 1',
      stdout: './a\n./b\n./c',
      stderr: '',
      exitCode: 0,
    });
    expect(smallFind).toMatchObject({ reduced: false, reason: 'below-threshold' });
  });

  it('passes commands with no matching rule through', () => {
    const out = reduceToolOutput({
      command: 'git log --oneline',
      stdout: lines(200, (i) => `abc${i} commit message ${i}`),
      stderr: '',
      exitCode: 0,
    });
    expect(out).toMatchObject({ reduced: false, reason: 'no-matching-rule' });
  });

  it('passes unparseable commands through', () => {
    expect(
      reduceToolOutput({ command: '   ', stdout: 'x', stderr: '', exitCode: 0 }),
    ).toMatchObject({
      reduced: false,
      reason: 'unparseable-command',
    });
  });

  it('reports consistent char accounting when reduced', () => {
    const out = reduceToolOutput({
      command: 'find . -type f',
      stdout: lines(120, (i) => `./deep/path/to/file-${i}.ts`),
      stderr: '',
      exitCode: 0,
    });
    expect(out.reduced).toBe(true);
    expect(out.reducerId).toBeTruthy();
    expect(out.originalChars).toBeGreaterThan(0);
    expect(out.reducedChars).toBeGreaterThan(0);
    expect(out.savedChars).toBe(out.originalChars - out.reducedChars);
    expect(out.savedChars).toBeGreaterThan(0);
    expect(out.reason).toBeUndefined();
  });

  it('reports consistent char accounting on passthrough', () => {
    const out = reduceToolOutput({
      command: 'cat f.txt',
      stdout: 'hello\nworld',
      stderr: '',
      exitCode: 0,
    });
    expect(out.reduced).toBe(false);
    expect(out.savedChars).toBe(0);
    expect(out.reducedChars).toBe(out.originalChars);
    expect(out.reason).toBeTruthy();
  });
});
