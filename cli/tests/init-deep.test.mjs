import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runInitDeep } from '../init-deep.ts';

async function makeRepoFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-init-deep-'));

  // Repo root: README with a summary, plus a couple of top-level dirs.
  await fs.writeFile(
    path.join(root, 'README.md'),
    '# Fixture Repo\n\nA sample repository used to test init-deep bootstrap.\n',
  );

  // app/ with a package.json and a nested src/lib directory.
  await fs.mkdir(path.join(root, 'app'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'app', 'package.json'),
    JSON.stringify({ name: 'fixture-app', description: 'Fixture application.' }),
  );
  await fs.mkdir(path.join(root, 'app', 'src', 'lib'), { recursive: true });
  await fs.writeFile(path.join(root, 'app', 'src', 'lib', 'a.ts'), 'export const a = 1;\n');
  await fs.writeFile(path.join(root, 'app', 'src', 'lib', 'b.ts'), 'export const b = 2;\n');
  await fs.writeFile(path.join(root, 'app', 'src', 'lib', 'c.ts'), 'export const c = 3;\n');

  // cli/ with just a source file (top-level dir, no children but has content).
  await fs.mkdir(path.join(root, 'cli'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'cli', 'package.json'),
    JSON.stringify({ name: 'fixture-cli', description: 'Fixture command line tool.' }),
  );
  await fs.writeFile(path.join(root, 'cli', 'cli.ts'), '// cli entry\n');

  // node_modules should be skipped entirely.
  await fs.mkdir(path.join(root, 'node_modules', 'foo'), { recursive: true });
  await fs.writeFile(path.join(root, 'node_modules', 'foo', 'index.js'), '');

  // An existing AGENTS.md at the repo root should be preserved without --force.
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# Existing root doc\n');

  return root;
}

async function cleanup(root) {
  await fs.rm(root, { recursive: true, force: true });
}

describe('runInitDeep', () => {
  let repo;

  before(async () => {
    repo = await makeRepoFixture();
  });

  after(async () => {
    await cleanup(repo);
  });

  it('plans writes for top-level dirs and the nested src/lib, skipping ignored dirs', async () => {
    const result = await runInitDeep({ cwd: repo, dryRun: true, force: false });
    const dirs = [...result.written, ...result.skipped].map((p) => p.dir).sort();

    assert.ok(dirs.includes('app'), 'app should be significant');
    assert.ok(dirs.includes('cli'), 'cli should be significant');
    assert.ok(dirs.includes('app/src/lib'), 'app/src/lib should be a source group');
    assert.ok(!dirs.some((d) => d.startsWith('node_modules')), 'node_modules must be ignored');
  });

  it('preserves an existing root AGENTS.md without --force', async () => {
    const result = await runInitDeep({ cwd: repo, dryRun: true, force: false });
    const skippedDirs = result.skipped.map((p) => p.dir);
    assert.ok(skippedDirs.includes('.'), 'root should land in the skipped bucket');
    assert.ok(
      !result.written.some((p) => p.dir === '.'),
      'root AGENTS.md should not be in the write bucket without --force',
    );

    const preserved = await fs.readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    assert.equal(preserved, '# Existing root doc\n');
  });

  it('writes new AGENTS.md files when not in dry-run mode', async () => {
    const result = await runInitDeep({ cwd: repo, dryRun: false, force: false });
    assert.ok(result.written.length > 0, 'expected at least one file written');

    const appDoc = await fs.readFile(path.join(repo, 'app', 'AGENTS.md'), 'utf8');
    assert.match(appDoc, /# `app` Context/);
    assert.match(appDoc, /Fixture application\./);

    const libDoc = await fs.readFile(path.join(repo, 'app', 'src', 'lib', 'AGENTS.md'), 'utf8');
    assert.match(libDoc, /# `app\/src\/lib` Context/);
  });

  it('overwrites existing AGENTS.md files when --force is set', async () => {
    const before = await fs.readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    assert.equal(before, '# Existing root doc\n');

    await runInitDeep({ cwd: repo, dryRun: false, force: true });

    const after = await fs.readFile(path.join(repo, 'AGENTS.md'), 'utf8');
    assert.notEqual(after, '# Existing root doc\n');
    assert.match(after, /# Repository Context/);
  });
});
