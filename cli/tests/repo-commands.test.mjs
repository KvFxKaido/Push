import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  deriveRepoCommands,
  formatRepoCommands,
  parseAgentsMdHints,
} from '../../lib/repo-commands.ts';
import {
  buildRepoCommandsSnapshot,
  ensureRepoCommandsSeeded,
  loadRepoCommands,
  resetRepoCommandsMemo,
} from '../repo-commands.ts';
import { formatCoderState as formatCoderStateFromWorkingMemory } from '../../lib/working-memory.ts';
import { formatCoderState as formatCoderStateFromCoderAgent } from '../../lib/coder-agent.ts';

// ---------------------------------------------------------------------------
// Pure derivation
// ---------------------------------------------------------------------------

describe('deriveRepoCommands — package scripts', () => {
  it('matches exact script names as explicit', () => {
    const out = deriveRepoCommands({
      packageScripts: {
        test: 'vitest run',
        lint: 'biome check .',
        typecheck: 'tsc --noEmit',
      },
    });
    assert.deepEqual(out.test, {
      command: 'npm run test',
      source: 'package-script',
      confidence: 'explicit',
    });
    assert.deepEqual(out.lint, {
      command: 'npm run lint',
      source: 'package-script',
      confidence: 'explicit',
    });
    assert.deepEqual(out.typecheck, {
      command: 'npm run typecheck',
      source: 'package-script',
      confidence: 'explicit',
    });
  });

  it('matches preferred aliases as heuristic', () => {
    const out = deriveRepoCommands({
      packageScripts: {
        'test:unit': 'vitest run',
        'check:types': 'tsc --noEmit',
      },
    });
    assert.equal(out.test?.command, 'npm run test:unit');
    assert.equal(out.test?.confidence, 'heuristic');
    assert.equal(out.typecheck?.command, 'npm run check:types');
    assert.equal(out.typecheck?.confidence, 'heuristic');
  });

  it('prefers exact match over aliases when both are present', () => {
    const out = deriveRepoCommands({
      packageScripts: {
        'test:unit': 'vitest run',
        test: 'vitest run --reporter=dot',
      },
    });
    assert.equal(out.test?.command, 'npm run test');
    assert.equal(out.test?.confidence, 'explicit');
  });

  it('prefers `format:check` over the mutating `format` script', () => {
    const out = deriveRepoCommands({
      packageScripts: {
        format: 'biome format --write',
        'format:check': 'biome format',
      },
    });
    assert.equal(out.format?.command, 'npm run format:check');
    assert.equal(out.format?.confidence, 'heuristic');
  });

  it('keeps `check` additive — does not displace test/lint/typecheck', () => {
    const out = deriveRepoCommands({
      packageScripts: {
        test: 'vitest run',
        lint: 'biome check .',
        typecheck: 'tsc --noEmit',
        check: 'npm run lint && npm run typecheck && npm run test',
      },
    });
    assert.equal(out.test?.command, 'npm run test');
    assert.equal(out.lint?.command, 'npm run lint');
    assert.equal(out.typecheck?.command, 'npm run typecheck');
    assert.equal(out.check?.command, 'npm run check');
  });
});

describe('deriveRepoCommands — config-file inference', () => {
  it('infers vitest test command from vitest config', () => {
    const out = deriveRepoCommands({ configFiles: ['vitest.config.ts'] });
    assert.deepEqual(out.test, {
      command: 'npx vitest run',
      source: 'config-file',
      confidence: 'heuristic',
    });
  });

  it('infers biome lint and format from biome.json', () => {
    const out = deriveRepoCommands({ configFiles: ['biome.json'] });
    assert.equal(out.lint?.command, 'npx biome check .');
    assert.equal(out.lint?.source, 'config-file');
    assert.equal(out.format?.command, 'npx biome format .');
  });

  it('infers tsc typecheck from tsconfig.json', () => {
    const out = deriveRepoCommands({ configFiles: ['tsconfig.json'] });
    assert.equal(out.typecheck?.command, 'npx tsc --noEmit');
    assert.equal(out.typecheck?.confidence, 'heuristic');
  });

  it('does not infer build or check from config files', () => {
    const out = deriveRepoCommands({ configFiles: ['tsconfig.json', 'biome.json'] });
    assert.equal(out.build, undefined);
    assert.equal(out.check, undefined);
  });

  it('package script wins over config-file inference for the same kind', () => {
    const out = deriveRepoCommands({
      packageScripts: { test: 'vitest run --reporter=verbose' },
      configFiles: ['vitest.config.ts'],
    });
    assert.equal(out.test?.command, 'npm run test');
    assert.equal(out.test?.source, 'package-script');
  });
});

describe('deriveRepoCommands — AGENTS.md hints', () => {
  it('AGENTS hint beats package script for the same kind only', () => {
    const out = deriveRepoCommands({
      packageScripts: {
        test: 'vitest run',
        lint: 'biome check .',
        typecheck: 'tsc --noEmit',
      },
      agentsMdHints: [{ kind: 'test', command: 'npm run test:ci' }],
    });
    assert.equal(out.test?.command, 'npm run test:ci');
    assert.equal(out.test?.source, 'agents-md');
    assert.equal(out.test?.confidence, 'explicit');
    // lint and typecheck untouched.
    assert.equal(out.lint?.command, 'npm run lint');
    assert.equal(out.lint?.source, 'package-script');
    assert.equal(out.typecheck?.command, 'npm run typecheck');
    assert.equal(out.typecheck?.source, 'package-script');
  });

  it('partial AGENTS override leaves remaining kinds to fall through', () => {
    const out = deriveRepoCommands({
      configFiles: ['biome.json', 'tsconfig.json'],
      agentsMdHints: [{ kind: 'test', command: 'pnpm vitest --silent' }],
    });
    assert.equal(out.test?.source, 'agents-md');
    assert.equal(out.lint?.source, 'config-file');
    assert.equal(out.typecheck?.source, 'config-file');
  });
});

describe('parseAgentsMdHints', () => {
  it('parses single-kind fenced block', () => {
    const md = ['# Notes', '', '```bash', '# test:', 'npm run test:unit', '```', ''].join('\n');
    assert.deepEqual(parseAgentsMdHints(md), [{ kind: 'test', command: 'npm run test:unit' }]);
  });

  it('parses multiple kinds in one block', () => {
    const md = [
      '```bash',
      '# test:',
      'npm run test:unit',
      '# lint:',
      'npx biome check .',
      '# typecheck:',
      'npx tsc --noEmit',
      '```',
    ].join('\n');
    assert.deepEqual(parseAgentsMdHints(md), [
      { kind: 'test', command: 'npm run test:unit' },
      { kind: 'lint', command: 'npx biome check .' },
      { kind: 'typecheck', command: 'npx tsc --noEmit' },
    ]);
  });

  it('first hit per kind wins', () => {
    const md = ['```bash', '# test:', 'first', '```', '```sh', '# test:', 'second', '```'].join(
      '\n',
    );
    assert.deepEqual(parseAgentsMdHints(md), [{ kind: 'test', command: 'first' }]);
  });

  it('accepts sh and shell fences', () => {
    const md = ['```shell', '# lint:', 'npx eslint .', '```'].join('\n');
    assert.deepEqual(parseAgentsMdHints(md), [{ kind: 'lint', command: 'npx eslint .' }]);
  });

  it('ignores non-shell fences', () => {
    const md = ['```ts', '# test:', 'npm run test', '```'].join('\n');
    assert.deepEqual(parseAgentsMdHints(md), []);
  });

  it('skips intermediate comments without consuming the directive', () => {
    const md = ['```bash', '# test:', '# (uses vitest)', 'npm run test:unit', '```'].join('\n');
    assert.deepEqual(parseAgentsMdHints(md), [{ kind: 'test', command: 'npm run test:unit' }]);
  });

  it('returns an empty list for empty input', () => {
    assert.deepEqual(parseAgentsMdHints(''), []);
  });
});

describe('formatRepoCommands', () => {
  it('renders kinds in canonical order with provenance', () => {
    const rendered = formatRepoCommands({
      test: { command: 'npm run test:unit', source: 'agents-md', confidence: 'explicit' },
      typecheck: {
        command: 'npm run typecheck',
        source: 'package-script',
        confidence: 'explicit',
      },
      check: { command: 'npm run ci', source: 'package-script', confidence: 'heuristic' },
    });
    assert.equal(
      rendered,
      'test=npm run test:unit [agents-md]; typecheck=npm run typecheck [package-script]; check=npm run ci [package-script]',
    );
  });

  it('returns empty string when no commands resolved', () => {
    assert.equal(formatRepoCommands({}), '');
  });
});

// ---------------------------------------------------------------------------
// CLI adapter
// ---------------------------------------------------------------------------

async function makeFixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-repo-commands-'));
  // Test-scoped cleanup so we don't leak temp dirs across runs.
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  return root;
}

describe('buildRepoCommandsSnapshot', () => {
  beforeEach(() => resetRepoCommandsMemo());

  it('reads scripts, config files, and AGENTS hints from disk', async (t) => {
    const root = await makeFixture(t, {
      'package.json': JSON.stringify({
        name: 'fixture',
        scripts: {
          test: 'vitest run',
          lint: 'biome check .',
          typecheck: 'tsc --noEmit',
        },
      }),
      'biome.json': '{}',
      'tsconfig.json': '{}',
      'AGENTS.md': '```bash\n# test:\nnpm run test:ci\n```\n',
    });

    const snapshot = await buildRepoCommandsSnapshot(root);
    assert.deepEqual(snapshot.packageScripts, {
      test: 'vitest run',
      lint: 'biome check .',
      typecheck: 'tsc --noEmit',
    });
    assert.ok(snapshot.configFiles?.includes('biome.json'));
    assert.ok(snapshot.configFiles?.includes('tsconfig.json'));
    assert.deepEqual(snapshot.agentsMdHints, [{ kind: 'test', command: 'npm run test:ci' }]);
  });

  it('AGENTS.md hints win over CLAUDE.md hints for the same kind', async (t) => {
    const root = await makeFixture(t, {
      'AGENTS.md': '```bash\n# test:\nFROM_AGENTS\n```\n',
      'CLAUDE.md': '```bash\n# test:\nFROM_CLAUDE\n# lint:\nFROM_CLAUDE_LINT\n```\n',
    });
    const snapshot = await buildRepoCommandsSnapshot(root);
    assert.deepEqual(snapshot.agentsMdHints, [
      { kind: 'test', command: 'FROM_AGENTS' },
      { kind: 'lint', command: 'FROM_CLAUDE_LINT' },
    ]);
  });

  it('handles a missing package.json gracefully', async (t) => {
    const root = await makeFixture(t, { 'biome.json': '{}' });
    const snapshot = await buildRepoCommandsSnapshot(root);
    assert.equal(snapshot.packageScripts, undefined);
    assert.deepEqual(snapshot.configFiles, ['biome.json']);
    assert.deepEqual(snapshot.agentsMdHints, []);
  });

  it('ignores invalid package.json without throwing', async (t) => {
    const root = await makeFixture(t, { 'package.json': '{ not json' });
    const snapshot = await buildRepoCommandsSnapshot(root);
    assert.equal(snapshot.packageScripts, undefined);
  });
});

describe('listConfigFiles directory rejection', () => {
  beforeEach(() => resetRepoCommandsMemo());

  it('skips directories that share a config-file name', async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-repo-commands-'));
    t.after(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });
    // `biome.json` exists as a directory, not a file. It must not be picked
    // up as a config-file signal.
    await fs.mkdir(path.join(root, 'biome.json'), { recursive: true });
    await fs.writeFile(path.join(root, 'tsconfig.json'), '{}', 'utf8');

    const snapshot = await buildRepoCommandsSnapshot(root);
    assert.ok(!snapshot.configFiles?.includes('biome.json'));
    assert.ok(snapshot.configFiles?.includes('tsconfig.json'));
  });

  it('returns config files in KNOWN_CONFIG_FILES order', async (t) => {
    const root = await makeFixture(t, {
      'tsconfig.json': '{}',
      'biome.json': '{}',
      'jest.config.js': 'module.exports = {};',
      'vitest.config.ts': 'export default {};',
    });
    const snapshot = await buildRepoCommandsSnapshot(root);
    // KNOWN_CONFIG_FILES has vitest before jest before biome before tsconfig.
    const found = snapshot.configFiles ?? [];
    const idx = (n) => found.indexOf(n);
    assert.ok(idx('vitest.config.ts') < idx('jest.config.js'));
    assert.ok(idx('jest.config.js') < idx('biome.json'));
    assert.ok(idx('biome.json') < idx('tsconfig.json'));
  });
});

describe('loadRepoCommands', () => {
  beforeEach(() => resetRepoCommandsMemo());

  it('walks up from a subdirectory to the actual repo root', async (t) => {
    const root = await makeFixture(t, {
      'package.json': JSON.stringify({
        name: 'fixture',
        scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' },
      }),
      'AGENTS.md': '```bash\n# test:\nnpm run test:ci\n```\n',
      // Create a `.git` marker so resolveRepoRoot anchors here.
      '.git/HEAD': 'ref: refs/heads/main\n',
      // A nested subdirectory the CLI might be launched from.
      'app/src/.gitkeep': '',
    });
    const subdir = path.join(root, 'app', 'src');

    const commands = await loadRepoCommands(subdir);
    // Resolution should have walked up to `root` and read the root files.
    assert.equal(commands.test?.command, 'npm run test:ci');
    assert.equal(commands.test?.source, 'agents-md');
    assert.equal(commands.typecheck?.command, 'npm run typecheck');
  });

  it('returns derived commands end-to-end', async (t) => {
    const root = await makeFixture(t, {
      'package.json': JSON.stringify({
        name: 'fixture',
        scripts: {
          test: 'vitest run',
          lint: 'biome check .',
          typecheck: 'tsc --noEmit',
          check: 'npm run lint && npm run typecheck && npm run test',
        },
      }),
      'biome.json': '{}',
      'tsconfig.json': '{}',
      'AGENTS.md': '```bash\n# test:\nnpm run test:ci\n```\n',
    });

    const commands = await loadRepoCommands(root);
    assert.equal(commands.test?.command, 'npm run test:ci');
    assert.equal(commands.test?.source, 'agents-md');
    assert.equal(commands.lint?.command, 'npm run lint');
    assert.equal(commands.lint?.source, 'package-script');
    assert.equal(commands.typecheck?.command, 'npm run typecheck');
    assert.equal(commands.check?.command, 'npm run check');
  });

  it('memoizes per cwd within a process', async (t) => {
    const root = await makeFixture(t, {
      'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
    });
    const first = await loadRepoCommands(root);
    // Mutate the file after the first call. Memo must keep returning the
    // original result — recompute is per-process boot, not per-call.
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { test: 'jest' } }),
      'utf8',
    );
    const second = await loadRepoCommands(root);
    assert.equal(first, second);
  });

  it('resetRepoCommandsMemo forces recompute', async (t) => {
    const root = await makeFixture(t, {
      'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
    });
    const first = await loadRepoCommands(root);
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { 'test:unit': 'jest' } }),
      'utf8',
    );
    resetRepoCommandsMemo();
    const second = await loadRepoCommands(root);
    assert.notEqual(first, second);
    assert.equal(second.test?.command, 'npm run test:unit');
  });
});

// ---------------------------------------------------------------------------
// ensureRepoCommandsSeeded
// ---------------------------------------------------------------------------

describe('ensureRepoCommandsSeeded', () => {
  beforeEach(() => resetRepoCommandsMemo());

  it('seeds validationCommands onto the working memory', async (t) => {
    const root = await makeFixture(t, {
      'package.json': JSON.stringify({
        scripts: { test: 'vitest run', typecheck: 'tsc --noEmit' },
      }),
    });
    const state = { cwd: root, workingMemory: {} };
    await ensureRepoCommandsSeeded(state);
    assert.equal(state.workingMemory.validationCommands?.test?.command, 'npm run test');
    assert.equal(state.workingMemory.validationCommands?.typecheck?.command, 'npm run typecheck');
  });

  it('is a no-op when validationCommands is already set', async (t) => {
    const root = await makeFixture(t, {
      'package.json': JSON.stringify({ scripts: { test: 'vitest run' } }),
    });
    const preset = {
      test: { command: 'npm run preset', source: 'agents-md', confidence: 'explicit' },
    };
    const state = { cwd: root, workingMemory: { validationCommands: preset } };
    await ensureRepoCommandsSeeded(state);
    assert.equal(state.workingMemory.validationCommands, preset);
  });

  it('swallows discovery failures silently', async (t) => {
    const root = await makeFixture(t, { 'package.json': '{ not json' });
    const state = { cwd: root, workingMemory: {} };
    await ensureRepoCommandsSeeded(state);
    // No package scripts and no AGENTS hints means an empty RepoCommands
    // object — but discovery should not throw.
    assert.ok(state.workingMemory.validationCommands);
  });
});

// ---------------------------------------------------------------------------
// Renderer parity — pin both formatCoderState implementations to the same
// output for a given input. If `validationCommands` is added to one but not
// the other, this test fails CI. Transitional debt until the duplicate
// rendering in lib/coder-agent.ts is folded into lib/working-memory.ts.
// ---------------------------------------------------------------------------

describe('formatCoderState renderer parity', () => {
  it('emits the Validation line identically across both modules', () => {
    const memory = {
      plan: 'Ship it',
      validationCommands: {
        test: { command: 'npm run test:cli', source: 'agents-md', confidence: 'explicit' },
        lint: { command: 'npx biome check .', source: 'config-file', confidence: 'heuristic' },
        typecheck: {
          command: 'npm run typecheck',
          source: 'package-script',
          confidence: 'explicit',
        },
      },
    };
    const fromWorkingMemory = formatCoderStateFromWorkingMemory(memory, 0);
    const fromCoderAgent = formatCoderStateFromCoderAgent(memory, 0);
    assert.equal(fromWorkingMemory, fromCoderAgent);
    assert.match(fromWorkingMemory, /Validation: test=npm run test:cli \[agents-md\]/);
    assert.match(fromWorkingMemory, /lint=npx biome check \. \[config-file\]/);
  });

  it('omits the Validation line when validationCommands is absent', () => {
    const memory = { plan: 'Ship it' };
    const fromWorkingMemory = formatCoderStateFromWorkingMemory(memory, 0);
    const fromCoderAgent = formatCoderStateFromCoderAgent(memory, 0);
    assert.equal(fromWorkingMemory, fromCoderAgent);
    assert.ok(!fromWorkingMemory.includes('Validation:'));
  });
});
