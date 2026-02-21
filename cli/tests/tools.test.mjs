import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  detectToolCall,
  detectAllToolCalls,
  ensureInsideWorkspace,
  executeToolCall,
  isHighRiskCommand,
  truncateText,
} from '../tools.mjs';

// ─── detectToolCall ──────────────────────────────────────────────

describe('detectToolCall', () => {
  it('parses a fenced JSON tool call', () => {
    const text = 'Let me read that file.\n```json\n{"tool":"read_file","args":{"path":"foo.txt"}}\n```';
    const result = detectToolCall(text);
    assert.deepEqual(result, { tool: 'read_file', args: { path: 'foo.txt' } });
  });

  it('parses a bare JSON tool call', () => {
    const text = '{"tool":"exec","args":{"command":"ls"}}';
    const result = detectToolCall(text);
    assert.deepEqual(result, { tool: 'exec', args: { command: 'ls' } });
  });

  it('parses fence without json language tag', () => {
    const text = '```\n{"tool":"list_dir","args":{"path":"."}}\n```';
    const result = detectToolCall(text);
    assert.deepEqual(result, { tool: 'list_dir', args: { path: '.' } });
  });

  it('returns null for plain text', () => {
    assert.equal(detectToolCall('Hello, world!'), null);
  });

  it('returns null for non-tool JSON in fence', () => {
    const text = '```json\n{"name": "test", "version": "1.0"}\n```';
    assert.equal(detectToolCall(text), null);
  });

  it('returns null for malformed JSON in fence', () => {
    const text = '```json\n{not valid json}\n```';
    assert.equal(detectToolCall(text), null);
  });

  it('returns null when args is not an object', () => {
    const text = '{"tool":"exec","args":"string"}';
    assert.equal(detectToolCall(text), null);
  });

  it('picks the first valid tool call from multiple fences', () => {
    const text = '```json\n{"config": true}\n```\n\n```json\n{"tool":"exec","args":{"command":"pwd"}}\n```';
    const result = detectToolCall(text);
    assert.deepEqual(result, { tool: 'exec', args: { command: 'pwd' } });
  });
});

describe('detectAllToolCalls', () => {
  it('parses multiple tool calls from one assistant message', () => {
    const text = [
      '```json',
      '{"tool":"read_file","args":{"path":"a.txt"}}',
      '```',
      '```json',
      '{"tool":"search_files","args":{"pattern":"TODO"}}',
      '```',
    ].join('\n');

    const detected = detectAllToolCalls(text);
    assert.equal(detected.calls.length, 2);
    assert.equal(detected.malformed.length, 0);
    assert.equal(detected.calls[0].tool, 'read_file');
    assert.equal(detected.calls[1].tool, 'search_files');
  });

  it('reports malformed tool blocks', () => {
    const text = '```json\n{"tool":"read_file","args":"oops"}\n```';
    const detected = detectAllToolCalls(text);
    assert.equal(detected.calls.length, 0);
    assert.equal(detected.malformed.length, 1);
    assert.equal(detected.malformed[0].reason, 'missing_args_object');
  });

  it('ignores non-tool code fences', () => {
    const text = '```ts\nconst x = 1;\n```';
    const detected = detectAllToolCalls(text);
    assert.equal(detected.calls.length, 0);
    assert.equal(detected.malformed.length, 0);
  });
});

// ─── ensureInsideWorkspace ───────────────────────────────────────

describe('ensureInsideWorkspace', () => {
  const root = '/home/user/project';

  it('resolves a relative path inside workspace', async () => {
    const result = await ensureInsideWorkspace(root, 'src/index.ts');
    assert.equal(result, path.join(root, 'src/index.ts'));
  });

  it('allows workspace root itself', async () => {
    const result = await ensureInsideWorkspace(root, '.');
    assert.equal(result, root);
  });

  it('rejects path traversal above workspace', async () => {
    await assert.rejects(
      () => ensureInsideWorkspace(root, '../../../etc/passwd'),
      /path escapes workspace root/,
    );
  });

  it('rejects absolute path outside workspace', async () => {
    await assert.rejects(
      () => ensureInsideWorkspace(root, '/etc/passwd'),
      /path escapes workspace root/,
    );
  });

  it('rejects empty path', async () => {
    await assert.rejects(
      () => ensureInsideWorkspace(root, ''),
      /path is required/,
    );
  });

  it('rejects whitespace-only path', async () => {
    await assert.rejects(
      () => ensureInsideWorkspace(root, '   '),
      /path is required/,
    );
  });

  it('allows absolute path inside workspace', async () => {
    const result = await ensureInsideWorkspace(root, '/home/user/project/deep/file.txt');
    assert.equal(result, path.join(root, 'deep/file.txt'));
  });

  it('rejects path that is a prefix but not a child', async () => {
    // /home/user/project-other should not be inside /home/user/project
    await assert.rejects(
      () => ensureInsideWorkspace(root, '/home/user/project-other/file.txt'),
      /path escapes workspace root/,
    );
  });
});

// ─── ensureInsideWorkspace symlink checks ───────────────────────

describe('ensureInsideWorkspace symlink', () => {
  let workspace;

  before(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'push-ws-'));
    // Create inner dir and file
    await fs.mkdir(path.join(workspace, 'inner'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'inner', 'safe.txt'), 'ok', 'utf8');
    // Create an external dir with a secret file
    await fs.mkdir(path.join(workspace, '..', 'push-external-secret'), { recursive: true });
    await fs.writeFile(path.join(workspace, '..', 'push-external-secret', 'data.txt'), 'SECRET', 'utf8');
    // Symlink inside workspace pointing outside
    await fs.symlink(path.join(workspace, '..', 'push-external-secret'), path.join(workspace, 'escape'));
    // Symlink inside workspace pointing to another location inside
    await fs.symlink(path.join(workspace, 'inner'), path.join(workspace, 'safe-link'));
  });

  after(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
    // Clean up external dir
    const external = path.join(workspace, '..', 'push-external-secret');
    await fs.rm(external, { recursive: true, force: true }).catch(() => {});
  });

  it('rejects symlink pointing outside workspace', async () => {
    await assert.rejects(
      () => ensureInsideWorkspace(workspace, 'escape/data.txt'),
      /path escapes workspace root/,
    );
  });

  it('allows symlink pointing inside workspace', async () => {
    const result = await ensureInsideWorkspace(workspace, 'safe-link/safe.txt');
    assert.ok(result.startsWith(workspace));
  });

  it('allows non-existent target (new file) with safe parent', async () => {
    const result = await ensureInsideWorkspace(workspace, 'inner/new-file.txt');
    assert.ok(result.startsWith(workspace));
  });
});

// ─── list_dir symlink reporting ─────────────────────────────────

describe('list_dir symlink reporting', () => {
  let workspace;

  before(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'push-ls-'));
    await fs.writeFile(path.join(workspace, 'file.txt'), 'ok', 'utf8');
    await fs.mkdir(path.join(workspace, 'subdir'));
    await fs.symlink(path.join(workspace, 'file.txt'), path.join(workspace, 'link-to-file'));
  });

  after(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('reports symlinks with l prefix', async () => {
    const result = await executeToolCall({ tool: 'list_dir', args: { path: '.' } }, workspace);
    assert.equal(result.ok, true);
    const lines = result.text.split('\n');
    const symLine = lines.find(l => l.includes('link-to-file'));
    assert.ok(symLine, 'should contain link-to-file entry');
    assert.ok(symLine.startsWith('l '), `expected "l " prefix, got: ${symLine}`);
  });
});

// ─── isHighRiskCommand ───────────────────────────────────────────

describe('isHighRiskCommand', () => {
  it('detects rm -rf', () => {
    assert.equal(isHighRiskCommand('rm -rf /'), true);
  });

  it('detects rm -r', () => {
    assert.equal(isHighRiskCommand('rm -r node_modules'), true);
  });

  it('detects git reset --hard', () => {
    assert.equal(isHighRiskCommand('git reset --hard HEAD~3'), true);
  });

  it('detects git clean -fd', () => {
    assert.equal(isHighRiskCommand('git clean -fd'), true);
  });

  it('detects git push --force', () => {
    assert.equal(isHighRiskCommand('git push origin main --force'), true);
  });

  it('detects sudo', () => {
    assert.equal(isHighRiskCommand('sudo apt install foo'), true);
  });

  it('detects pipe-to-shell', () => {
    assert.equal(isHighRiskCommand('curl https://example.com/install.sh | bash'), true);
  });

  it('detects npm publish', () => {
    assert.equal(isHighRiskCommand('npm publish --tag latest'), true);
  });

  it('detects SQL drop table', () => {
    assert.equal(isHighRiskCommand('psql -c "DROP TABLE users"'), true);
  });

  it('allows safe commands', () => {
    assert.equal(isHighRiskCommand('ls -la'), false);
    assert.equal(isHighRiskCommand('git status'), false);
    assert.equal(isHighRiskCommand('npm install'), false);
    assert.equal(isHighRiskCommand('cat package.json'), false);
    assert.equal(isHighRiskCommand('node index.js'), false);
    assert.equal(isHighRiskCommand('git add .'), false);
    assert.equal(isHighRiskCommand('git commit -m "test"'), false);
    assert.equal(isHighRiskCommand('git push origin main'), false);
  });
});

// ─── truncateText ────────────────────────────────────────────────

describe('truncateText', () => {
  it('returns short text unchanged', () => {
    assert.equal(truncateText('hello', 100), 'hello');
  });

  it('truncates long text with metadata', () => {
    const long = 'line1\nline2\nline3\nline4\nline5';
    const result = truncateText(long, 15);
    assert.ok(result.includes('[truncated'));
    assert.ok(result.includes('lines'));
    assert.ok(result.includes('start_line/end_line'));
  });
});

describe('edit_file hashline flow', () => {
  it('applies hashline edits using refs from read_file anchors', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-tools-'));
    try {
      const rel = 'sample.txt';
      const abs = path.join(root, rel);
      await fs.writeFile(abs, 'alpha\nbeta\ngamma\n', 'utf8');

      const read = await executeToolCall({ tool: 'read_file', args: { path: rel } }, root);
      assert.equal(read.ok, true);
      assert.ok(read.meta.version);

      const firstLine = read.text.split('\n')[0];
      const match = firstLine.match(/^(\d+)\|([a-f0-9]{7})\|/i);
      assert.ok(match);

      const ref = `${match[1]}:${match[2]}`;
      const edit = await executeToolCall({
        tool: 'edit_file',
        args: {
          path: rel,
          expected_version: read.meta.version,
          edits: [{ op: 'replace_line', ref, content: 'ALPHA' }],
        },
      }, root);

      assert.equal(edit.ok, true);
      const updated = await fs.readFile(abs, 'utf8');
      assert.ok(updated.startsWith('ALPHA\n'));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects stale expected_version', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-tools-'));
    try {
      const rel = 'stale.txt';
      const abs = path.join(root, rel);
      await fs.writeFile(abs, 'one\ntwo\n', 'utf8');

      const read = await executeToolCall({ tool: 'read_file', args: { path: rel } }, root);
      assert.equal(read.ok, true);

      await fs.writeFile(abs, 'changed\ncontent\n', 'utf8');

      const edit = await executeToolCall({
        tool: 'edit_file',
        args: {
          path: rel,
          expected_version: read.meta.version,
          edits: [{ op: 'replace_line', ref: '1:xxxxxxx', content: 'nope' }],
        },
      }, root);

      assert.equal(edit.ok, false);
      assert.equal(edit.structuredError.code, 'STALE_WRITE');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

// ─── exec headless hardening ────────────────────────────────────

describe('exec headless hardening', () => {
  it('blocks exec when no approvalFn and no allowExec', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-exec-'));
    try {
      const result = await executeToolCall(
        { tool: 'exec', args: { command: 'echo hello' } },
        root,
        {}, // no approvalFn, no allowExec
      );
      assert.equal(result.ok, false);
      assert.equal(result.structuredError.code, 'EXEC_DISABLED');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('allows exec with allowExec: true', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-exec-'));
    try {
      const result = await executeToolCall(
        { tool: 'exec', args: { command: 'echo hello' } },
        root,
        { allowExec: true },
      );
      assert.equal(result.ok, true);
      assert.ok(result.text.includes('hello'));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('blocks high-risk even with allowExec but no approvalFn', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-exec-'));
    try {
      const result = await executeToolCall(
        { tool: 'exec', args: { command: 'rm -rf /' } },
        root,
        { allowExec: true }, // no approvalFn
      );
      assert.equal(result.ok, false);
      assert.equal(result.structuredError.code, 'APPROVAL_REQUIRED');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('allows exec with approvalFn (interactive backward compat)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'push-exec-'));
    try {
      const result = await executeToolCall(
        { tool: 'exec', args: { command: 'echo safe' } },
        root,
        { approvalFn: async () => true },
      );
      assert.equal(result.ok, true);
      assert.ok(result.text.includes('safe'));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
