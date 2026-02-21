import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  executeToolCall,
  backupFile,
  isReadOnlyToolCall,
  TOOL_PROTOCOL,
} from '../tools.mjs';

const PUSH_ROOT = path.resolve(import.meta.dirname, '..', '..');

// ─── read_symbols ────────────────────────────────────────────────

describe('read_symbols', () => {
  let tmpDir;

  after(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('finds functions and classes in a JS file', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-symbols-'));
    const content = [
      'export function greet(name) {',
      '  return `Hello, ${name}`;',
      '}',
      '',
      'class Animal {',
      '  constructor(name) { this.name = name; }',
      '}',
      '',
      'const add = (a, b) => a + b;',
      '',
      'export default async function fetchData() {}',
      '',
      'interface User {',
      '  name: string;',
      '}',
      '',
      'type ID = string;',
    ].join('\n');
    await fs.writeFile(path.join(tmpDir, 'sample.js'), content, 'utf8');

    const result = await executeToolCall(
      { tool: 'read_symbols', args: { path: 'sample.js' } },
      tmpDir,
    );

    assert.equal(result.ok, true);
    assert.ok(result.meta.symbolCount >= 4, `expected >= 4 symbols, got ${result.meta.symbolCount}`);
    assert.ok(result.text.includes('[function]'), 'should contain [function]');
    assert.ok(result.text.includes('[class]'), 'should contain [class]');
    assert.ok(result.text.includes('[interface]'), 'should contain [interface]');
    assert.ok(result.text.includes('[type]'), 'should contain [type]');
  });

  it('reports no symbols for an empty file', async () => {
    tmpDir = tmpDir || await fs.mkdtemp(path.join(os.tmpdir(), 'push-symbols-'));
    await fs.writeFile(path.join(tmpDir, 'empty.txt'), '', 'utf8');

    const result = await executeToolCall(
      { tool: 'read_symbols', args: { path: 'empty.txt' } },
      tmpDir,
    );

    assert.equal(result.ok, true);
    assert.equal(result.text, 'No symbols found');
    assert.equal(result.meta.symbolCount, 0);
  });

  it('is classified as read-only', () => {
    assert.equal(isReadOnlyToolCall({ tool: 'read_symbols' }), true);
  });
});

// ─── git_status ──────────────────────────────────────────────────

describe('git_status', () => {
  it('returns structured output in a real git repo', async () => {
    const result = await executeToolCall(
      { tool: 'git_status', args: {} },
      PUSH_ROOT,
    );

    assert.equal(result.ok, true);
    assert.ok(result.meta.branch, 'should have a branch name');
    assert.equal(typeof result.meta.changedFiles, 'number');
    assert.equal(typeof result.meta.staged, 'number', 'should have staged count');
    assert.equal(typeof result.meta.unstaged, 'number', 'should have unstaged count');
    assert.equal(typeof result.meta.untracked, 'number', 'should have untracked count');
    assert.ok(result.text.includes('Branch:'), 'structured output should include Branch: line');
  });

  it('is classified as read-only', () => {
    assert.equal(isReadOnlyToolCall({ tool: 'git_status' }), true);
  });
});

// ─── git_diff ────────────────────────────────────────────────────

describe('git_diff', () => {
  it('runs without error in a real git repo', async () => {
    const result = await executeToolCall(
      { tool: 'git_diff', args: {} },
      PUSH_ROOT,
    );

    assert.equal(result.ok, true);
    assert.equal(typeof result.text, 'string');
    assert.equal(result.meta.staged, false);
    assert.equal(result.meta.path, null);
    assert.equal(typeof result.meta.filesChanged, 'number', 'should have filesChanged count');
    assert.equal(typeof result.meta.insertions, 'number', 'should have insertions count');
    assert.equal(typeof result.meta.deletions, 'number', 'should have deletions count');
    assert.ok(Array.isArray(result.meta.files), 'should have files array');
  });

  it('accepts staged flag', async () => {
    const result = await executeToolCall(
      { tool: 'git_diff', args: { staged: true } },
      PUSH_ROOT,
    );

    assert.equal(result.ok, true);
    assert.equal(result.meta.staged, true);
  });

  it('is classified as read-only', () => {
    assert.equal(isReadOnlyToolCall({ tool: 'git_diff' }), true);
  });
});

// ─── git_commit is NOT read-only ─────────────────────────────────

describe('git_commit classification', () => {
  it('is NOT classified as read-only', () => {
    assert.equal(isReadOnlyToolCall({ tool: 'git_commit' }), false);
  });
});

// ─── backupFile ──────────────────────────────────────────────────

describe('backupFile', () => {
  let tmpDir;

  after(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates backup files in .push/backups/', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-backup-'));
    const filePath = path.join(tmpDir, 'target.txt');
    await fs.writeFile(filePath, 'original content', 'utf8');

    await backupFile(filePath, tmpDir);

    const backupDir = path.join(tmpDir, '.push', 'backups');
    const entries = await fs.readdir(backupDir);
    assert.equal(entries.length, 1, 'should have exactly one backup');
    assert.ok(entries[0].startsWith('target.txt.'), `backup name should start with target.txt., got ${entries[0]}`);
    assert.ok(entries[0].endsWith('.bak'), `backup name should end with .bak, got ${entries[0]}`);

    const backupContent = await fs.readFile(path.join(backupDir, entries[0]), 'utf8');
    assert.equal(backupContent, 'original content');
  });

  it('does not fail when file does not exist', async () => {
    tmpDir = tmpDir || await fs.mkdtemp(path.join(os.tmpdir(), 'push-backup-'));
    const nonExistent = path.join(tmpDir, 'ghost.txt');

    // Should not throw
    await backupFile(nonExistent, tmpDir);
  });

  it('flattens nested paths with underscores', async () => {
    tmpDir = tmpDir || await fs.mkdtemp(path.join(os.tmpdir(), 'push-backup-'));
    const nested = path.join(tmpDir, 'src', 'lib');
    await fs.mkdir(nested, { recursive: true });
    const filePath = path.join(nested, 'index.ts');
    await fs.writeFile(filePath, 'nested content', 'utf8');

    await backupFile(filePath, tmpDir);

    const backupDir = path.join(tmpDir, '.push', 'backups');
    const entries = await fs.readdir(backupDir);
    const nestedBackup = entries.find(e => e.startsWith('src__lib__index.ts.'));
    assert.ok(nestedBackup, `expected flattened path in backup name, got ${entries.join(', ')}`);
  });
});

// ─── edit_file context preview ───────────────────────────────────

describe('edit_file context preview', () => {
  let tmpDir;

  after(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('includes context lines around edit site', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-editctx-'));
    const lines = ['line1', 'line2', 'line3', 'line4', 'line5', 'line6', 'line7', 'line8'];
    const content = lines.join('\n');
    await fs.writeFile(path.join(tmpDir, 'ctx.txt'), content, 'utf8');

    // First read to get anchors
    const read = await executeToolCall(
      { tool: 'read_file', args: { path: 'ctx.txt' } },
      tmpDir,
    );
    assert.equal(read.ok, true);

    // Get hash for line 5
    const anchorLine = read.text.split('\n')[4]; // 0-indexed, line 5
    const match = anchorLine.match(/^(\d+)\|([a-f0-9]{7})\|/i);
    assert.ok(match, 'should parse anchor line');
    const ref = `${match[1]}:${match[2]}`;

    const edit = await executeToolCall(
      {
        tool: 'edit_file',
        args: {
          path: 'ctx.txt',
          edits: [{ op: 'replace_line', ref, content: 'REPLACED' }],
        },
      },
      tmpDir,
    );

    assert.equal(edit.ok, true);
    assert.ok(edit.text.includes('Context after edits:'), 'should contain context header');
    assert.ok(edit.text.includes('REPLACED'), 'should contain the replacement text');
    // Should show surrounding lines
    assert.ok(edit.text.includes('line2') || edit.text.includes('line3'), 'should show lines before edit site');
    assert.ok(edit.text.includes('line6') || edit.text.includes('line7'), 'should show lines after edit site');
  });

  it('edit_file creates a backup before editing', async () => {
    tmpDir = tmpDir || await fs.mkdtemp(path.join(os.tmpdir(), 'push-editctx-'));
    const content = 'aaa\nbbb\nccc\n';
    await fs.writeFile(path.join(tmpDir, 'bak.txt'), content, 'utf8');

    const read = await executeToolCall(
      { tool: 'read_file', args: { path: 'bak.txt' } },
      tmpDir,
    );
    const anchorLine = read.text.split('\n')[0];
    const match = anchorLine.match(/^(\d+)\|([a-f0-9]{7})\|/i);
    const ref = `${match[1]}:${match[2]}`;

    await executeToolCall(
      {
        tool: 'edit_file',
        args: {
          path: 'bak.txt',
          edits: [{ op: 'replace_line', ref, content: 'AAA' }],
        },
      },
      tmpDir,
    );

    const backupDir = path.join(tmpDir, '.push', 'backups');
    const entries = await fs.readdir(backupDir);
    const bakEntry = entries.find(e => e.startsWith('bak.txt.'));
    assert.ok(bakEntry, 'should have created a backup for bak.txt');

    // Backup should contain original content
    const backupContent = await fs.readFile(path.join(backupDir, bakEntry), 'utf8');
    assert.equal(backupContent, content);
  });
});

// ─── TOOL_PROTOCOL includes new tools ────────────────────────────

describe('TOOL_PROTOCOL', () => {
  it('includes read_symbols', () => {
    assert.ok(TOOL_PROTOCOL.includes('read_symbols'), 'TOOL_PROTOCOL should mention read_symbols');
  });

  it('includes git_status', () => {
    assert.ok(TOOL_PROTOCOL.includes('git_status'), 'TOOL_PROTOCOL should mention git_status');
  });

  it('includes git_diff', () => {
    assert.ok(TOOL_PROTOCOL.includes('git_diff'), 'TOOL_PROTOCOL should mention git_diff');
  });

  it('includes git_commit', () => {
    assert.ok(TOOL_PROTOCOL.includes('git_commit'), 'TOOL_PROTOCOL should mention git_commit');
  });

  it('includes undo_edit', () => {
    assert.ok(TOOL_PROTOCOL.includes('undo_edit'), 'TOOL_PROTOCOL should mention undo_edit');
  });
});

// ─── undo_edit ────────────────────────────────────────────────────

describe('undo_edit', () => {
  let tmpDir;

  after(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('restores a file from its most recent backup', async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-undo-'));
    const filePath = path.join(tmpDir, 'target.txt');
    await fs.writeFile(filePath, 'original', 'utf8');

    // Create a backup (simulates what write_file/edit_file does)
    await backupFile(filePath, tmpDir);

    // Overwrite the file
    await fs.writeFile(filePath, 'modified', 'utf8');
    assert.equal(await fs.readFile(filePath, 'utf8'), 'modified');

    // Undo should restore from backup
    const result = await executeToolCall(
      { tool: 'undo_edit', args: { path: 'target.txt' } },
      tmpDir,
    );

    assert.equal(result.ok, true);
    assert.ok(result.text.includes('Restored'), 'should report restore');
    assert.equal(result.meta.availableBackups, 1);
    assert.equal(await fs.readFile(filePath, 'utf8'), 'original');
  });

  it('picks the most recent backup when multiple exist', async () => {
    tmpDir = tmpDir || await fs.mkdtemp(path.join(os.tmpdir(), 'push-undo-'));
    const filePath = path.join(tmpDir, 'multi.txt');

    // Create two backups with different content
    await fs.writeFile(filePath, 'v1', 'utf8');
    await backupFile(filePath, tmpDir);
    // Small delay to ensure different timestamps
    await new Promise(r => setTimeout(r, 10));
    await fs.writeFile(filePath, 'v2', 'utf8');
    await backupFile(filePath, tmpDir);

    // Overwrite
    await fs.writeFile(filePath, 'v3', 'utf8');

    const result = await executeToolCall(
      { tool: 'undo_edit', args: { path: 'multi.txt' } },
      tmpDir,
    );

    assert.equal(result.ok, true);
    assert.equal(result.meta.availableBackups, 2);
    assert.equal(await fs.readFile(filePath, 'utf8'), 'v2');
  });

  it('returns error when no backups exist', async () => {
    tmpDir = tmpDir || await fs.mkdtemp(path.join(os.tmpdir(), 'push-undo-'));
    const result = await executeToolCall(
      { tool: 'undo_edit', args: { path: 'nonexistent.txt' } },
      tmpDir,
    );

    assert.equal(result.ok, false);
    assert.ok(result.text.includes('No backups found'));
    assert.equal(result.structuredError.code, 'NO_BACKUP');
  });

  it('is NOT classified as read-only', () => {
    assert.equal(isReadOnlyToolCall({ tool: 'undo_edit' }), false);
  });
});
