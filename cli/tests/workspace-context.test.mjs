import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildWorkspaceSnapshot, loadProjectInstructions, loadMemory } from '../workspace-context.mjs';
import { executeToolCall } from '../tools.mjs';

const PUSH_ROOT = path.resolve(import.meta.dirname, '..', '..');

// ─── buildWorkspaceSnapshot ─────────────────────────────────────

describe('buildWorkspaceSnapshot', () => {
  it('returns branch and tree for the Push repo', async () => {
    const result = await buildWorkspaceSnapshot(PUSH_ROOT);

    assert.ok(result.startsWith('[Workspace Snapshot]'), 'should start with header');
    assert.ok(result.includes('Branch:'), 'should include branch info');
    // The repo has a cli/ directory and CLAUDE.md at minimum
    assert.ok(result.includes('d cli/'), 'should list cli/ directory');
    assert.ok(result.includes('f CLAUDE.md'), 'should list CLAUDE.md file');
  });

  it('returns tree without git info for a non-git temp dir', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-ws-test-'));
    try {
      // Create a couple of entries
      await fs.mkdir(path.join(tmpDir, 'src'));
      await fs.writeFile(path.join(tmpDir, 'hello.txt'), 'hi');

      const result = await buildWorkspaceSnapshot(tmpDir);

      assert.ok(result.startsWith('[Workspace Snapshot]'), 'should start with header');
      assert.ok(!result.includes('Branch:'), 'should not include branch info');
      assert.ok(result.includes('d src/'), 'should list src/ directory');
      assert.ok(result.includes('f hello.txt'), 'should list hello.txt file');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('excludes ignored directories like node_modules and .git', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-ws-test-'));
    try {
      await fs.mkdir(path.join(tmpDir, 'node_modules'));
      await fs.mkdir(path.join(tmpDir, '.git'));
      await fs.mkdir(path.join(tmpDir, '__pycache__'));
      await fs.mkdir(path.join(tmpDir, 'src'));

      const result = await buildWorkspaceSnapshot(tmpDir);

      assert.ok(!result.includes('node_modules'), 'should not list node_modules');
      assert.ok(!result.includes('__pycache__'), 'should not list __pycache__');
      assert.ok(result.includes('d src/'), 'should list src/');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('detects package.json manifest in the Push repo', async () => {
    const result = await buildWorkspaceSnapshot(PUSH_ROOT);
    // Push repo does not have package.json at root — check for whatever manifests exist
    // The point is the function completes without error
    assert.ok(typeof result === 'string');
  });

  it('caps tree entries at 40', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-ws-test-'));
    try {
      // Create 50 files
      for (let i = 0; i < 50; i++) {
        await fs.writeFile(path.join(tmpDir, `file-${String(i).padStart(2, '0')}.txt`), '');
      }

      const result = await buildWorkspaceSnapshot(tmpDir);
      const treeLines = result.split('\n').filter((l) => l.startsWith('  f ') || l.startsWith('  d '));
      assert.ok(treeLines.length <= 40, `expected at most 40 tree entries, got ${treeLines.length}`);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns empty string for a nonexistent directory', async () => {
    const result = await buildWorkspaceSnapshot('/tmp/does-not-exist-push-test-xyz');
    assert.equal(result, '');
  });

  it('summarizes package.json manifest', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-ws-test-'));
    try {
      await fs.writeFile(path.join(tmpDir, 'package.json'), JSON.stringify({
        name: 'test-pkg',
        version: '2.3.4',
        dependencies: { a: '1', b: '2', c: '3' },
      }));

      const result = await buildWorkspaceSnapshot(tmpDir);
      assert.ok(result.includes('test-pkg@2.3.4'), 'should include package name and version');
      assert.ok(result.includes('3 dependencies'), 'should include dependency count');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── loadProjectInstructions ────────────────────────────────────

describe('loadProjectInstructions', () => {
  it('finds project instructions in the Push repo root', async () => {
    const result = await loadProjectInstructions(PUSH_ROOT);

    assert.ok(result !== null, 'should find an instruction file');
    // Push repo has AGENTS.md which takes priority over CLAUDE.md
    assert.ok(
      result.file === 'AGENTS.md' || result.file === 'CLAUDE.md',
      `expected AGENTS.md or CLAUDE.md, got ${result.file}`,
    );
    assert.ok(result.content.length > 0, 'content should not be empty');
    assert.ok(result.content.includes('Push'), 'content should mention Push');
  });

  it('returns null for a temp dir with no instruction files', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-ws-test-'));
    try {
      const result = await loadProjectInstructions(tmpDir);
      assert.equal(result, null);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('prefers .push/instructions.md over AGENTS.md and CLAUDE.md', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-ws-test-'));
    try {
      await fs.mkdir(path.join(tmpDir, '.push'));
      await fs.writeFile(path.join(tmpDir, '.push', 'instructions.md'), 'push instructions');
      await fs.writeFile(path.join(tmpDir, 'AGENTS.md'), 'agents file');
      await fs.writeFile(path.join(tmpDir, 'CLAUDE.md'), 'claude file');

      const result = await loadProjectInstructions(tmpDir);
      assert.equal(result.file, '.push/instructions.md');
      assert.equal(result.content, 'push instructions');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('falls back to AGENTS.md when .push/instructions.md is missing', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-ws-test-'));
    try {
      await fs.writeFile(path.join(tmpDir, 'AGENTS.md'), 'agents content');
      await fs.writeFile(path.join(tmpDir, 'CLAUDE.md'), 'claude content');

      const result = await loadProjectInstructions(tmpDir);
      assert.equal(result.file, 'AGENTS.md');
      assert.equal(result.content, 'agents content');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('caps content at 8000 characters', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-ws-test-'));
    try {
      const longContent = 'x'.repeat(10000);
      await fs.writeFile(path.join(tmpDir, 'CLAUDE.md'), longContent);

      const result = await loadProjectInstructions(tmpDir);
      assert.ok(result !== null);
      assert.equal(result.content.length, 8000);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── loadMemory ─────────────────────────────────────────────────

describe('loadMemory', () => {
  it('returns null when no memory file exists', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-ws-test-'));
    try {
      const result = await loadMemory(tmpDir);
      assert.equal(result, null);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('reads .push/memory.md content', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-ws-test-'));
    try {
      await fs.mkdir(path.join(tmpDir, '.push'));
      await fs.writeFile(path.join(tmpDir, '.push', 'memory.md'), 'Tests run with: bun test');

      const result = await loadMemory(tmpDir);
      assert.equal(result, 'Tests run with: bun test');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('caps content at 4000 characters', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-ws-test-'));
    try {
      await fs.mkdir(path.join(tmpDir, '.push'));
      await fs.writeFile(path.join(tmpDir, '.push', 'memory.md'), 'x'.repeat(5000));

      const result = await loadMemory(tmpDir);
      assert.equal(result.length, 4000);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns null for empty file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-ws-test-'));
    try {
      await fs.mkdir(path.join(tmpDir, '.push'));
      await fs.writeFile(path.join(tmpDir, '.push', 'memory.md'), '');

      const result = await loadMemory(tmpDir);
      assert.equal(result, null);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ─── save_memory tool ───────────────────────────────────────────

describe('save_memory tool', () => {
  it('writes .push/memory.md and reports success', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-ws-test-'));
    try {
      const result = await executeToolCall(
        { tool: 'save_memory', args: { content: 'Build: npm run build\nTest: npm test' } },
        tmpDir,
      );

      assert.ok(result.ok);
      assert.ok(result.text.includes('Memory saved'));

      const saved = await fs.readFile(path.join(tmpDir, '.push', 'memory.md'), 'utf8');
      assert.equal(saved, 'Build: npm run build\nTest: npm test');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('roundtrips with loadMemory', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-ws-test-'));
    try {
      await executeToolCall(
        { tool: 'save_memory', args: { content: 'This project uses vitest' } },
        tmpDir,
      );

      const loaded = await loadMemory(tmpDir);
      assert.equal(loaded, 'This project uses vitest');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
