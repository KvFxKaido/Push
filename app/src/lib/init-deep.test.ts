import { describe, expect, it } from 'vitest';
import {
  isSignificantDir,
  planInitDeep,
  renderAgentsMd,
  type InitDeepDirSnapshot,
} from './init-deep';

function snapshot(
  path: string,
  entries: { name: string; isDirectory: boolean }[],
  hints?: InitDeepDirSnapshot['hints'],
): InitDeepDirSnapshot {
  return { path, entries, hints };
}

describe('isSignificantDir', () => {
  it('always marks the repo root as significant', () => {
    expect(isSignificantDir(snapshot('.', []))).toBe('root');
    expect(isSignificantDir(snapshot('', []))).toBe('root');
  });

  it('marks top-level directories with child dirs as significant', () => {
    const result = isSignificantDir(
      snapshot('app', [
        { name: 'src', isDirectory: true },
        { name: 'package.json', isDirectory: false },
      ]),
    );
    expect(result).toBe('top-level');
  });

  it('marks top-level directories with manifest hints as significant', () => {
    const result = isSignificantDir(
      snapshot('cli', [{ name: 'cli.ts', isDirectory: false }], {
        packageName: 'push-cli',
      }),
    );
    expect(result).toBe('top-level');
  });

  it('skips ignored directory names', () => {
    expect(
      isSignificantDir(snapshot('node_modules', [{ name: 'foo', isDirectory: true }])),
    ).toBeNull();
    expect(isSignificantDir(snapshot('dist', [{ name: 'bundle.js', isDirectory: false }]))).toBeNull();
  });

  it('skips top-level dirs with no children and no hints', () => {
    expect(isSignificantDir(snapshot('empty', []))).toBeNull();
  });

  it('marks src/lib source groups with enough entries as significant', () => {
    const result = isSignificantDir(
      snapshot('app/src/lib', [
        { name: 'a.ts', isDirectory: false },
        { name: 'b.ts', isDirectory: false },
        { name: 'c.ts', isDirectory: false },
      ]),
    );
    expect(result).toBe('source-group');
  });

  it('skips src/lib directories that are too small', () => {
    const result = isSignificantDir(
      snapshot('app/src/lib', [{ name: 'a.ts', isDirectory: false }]),
    );
    expect(result).toBeNull();
  });

  it('skips deep non-src directories', () => {
    const result = isSignificantDir(
      snapshot('app/src/components/Button', [
        { name: 'index.ts', isDirectory: false },
        { name: 'Button.tsx', isDirectory: false },
        { name: 'Button.test.tsx', isDirectory: false },
      ]),
    );
    expect(result).toBeNull();
  });
});

describe('renderAgentsMd', () => {
  it('includes the generated-by banner and a heading', () => {
    const content = renderAgentsMd(
      snapshot('app', [{ name: 'src', isDirectory: true }]),
      'top-level',
    );

    expect(content).toContain('# `app` Context');
    expect(content).toContain('push init-deep');
    expect(content).toContain('`src/`');
  });

  it('uses package description when present', () => {
    const content = renderAgentsMd(
      snapshot('cli', [{ name: 'cli.ts', isDirectory: false }], {
        packageName: 'push-cli',
        packageDescription: 'Local terminal agent for Push.',
      }),
      'top-level',
    );

    expect(content).toContain('Local terminal agent for Push.');
    expect(content).toContain('`push-cli`');
  });

  it('uses README excerpt when no package description exists', () => {
    const content = renderAgentsMd(
      snapshot('docs', [{ name: 'README.md', isDirectory: false }], {
        readmeExcerpt: 'Canonical documentation home. Use this file to navigate active plans.',
      }),
      'top-level',
    );

    expect(content).toContain('Canonical documentation home.');
  });

  it('labels root as Repository Context', () => {
    const content = renderAgentsMd(
      snapshot('.', [{ name: 'app', isDirectory: true }]),
      'root',
    );

    expect(content).toContain('# Repository Context');
    expect(content).not.toContain('Parent context');
  });

  it('points non-root files back to the root AGENTS.md', () => {
    const content = renderAgentsMd(
      snapshot('app', [{ name: 'src', isDirectory: true }]),
      'top-level',
    );

    expect(content).toContain('Parent context: see `AGENTS.md` in the repo root.');
  });

  it('truncates file listings with a +N more suffix', () => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      name: `file${i}.ts`,
      isDirectory: false,
    }));
    const content = renderAgentsMd(snapshot('src', entries), 'source-group');

    expect(content).toMatch(/\+8 more/);
  });

  it('omits ignored child directories from the listing', () => {
    const content = renderAgentsMd(
      snapshot('app', [
        { name: 'src', isDirectory: true },
        { name: 'node_modules', isDirectory: true },
        { name: 'dist', isDirectory: true },
      ]),
      'top-level',
    );

    expect(content).toContain('`src/`');
    expect(content).not.toContain('`node_modules/`');
    expect(content).not.toContain('`dist/`');
  });
});

describe('planInitDeep', () => {
  it('produces a stable sorted plan with root first', () => {
    const snapshots: InitDeepDirSnapshot[] = [
      snapshot('cli', [{ name: 'cli.ts', isDirectory: false }], { packageName: 'cli' }),
      snapshot('app', [{ name: 'src', isDirectory: true }]),
      snapshot('.', [
        { name: 'app', isDirectory: true },
        { name: 'cli', isDirectory: true },
      ]),
    ];

    const plan = planInitDeep(snapshots);

    expect(plan.toWrite.map((p) => p.dir)).toEqual(['.', 'app', 'cli']);
    expect(plan.existing).toEqual([]);
    expect(plan.toWrite[0].path).toBe('AGENTS.md');
    expect(plan.toWrite[1].path).toBe('app/AGENTS.md');
  });

  it('routes existing AGENTS.md paths into the existing bucket', () => {
    const plan = planInitDeep(
      [
        snapshot('.', [{ name: 'app', isDirectory: true }]),
        snapshot('app', [{ name: 'src', isDirectory: true }]),
      ],
      { existing: new Set(['app/AGENTS.md']) },
    );

    expect(plan.toWrite.map((p) => p.dir)).toEqual(['.']);
    expect(plan.existing.map((p) => p.dir)).toEqual(['app']);
  });

  it('filters out non-significant snapshots silently', () => {
    const plan = planInitDeep([
      snapshot('node_modules', [{ name: 'foo', isDirectory: true }]),
      snapshot('empty', []),
    ]);

    expect(plan.toWrite).toEqual([]);
    expect(plan.existing).toEqual([]);
  });
});
