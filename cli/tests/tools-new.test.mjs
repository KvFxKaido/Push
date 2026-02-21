import { describe, it, after, beforeEach, afterEach } from 'node:test';
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
const originalFetch = globalThis.fetch;
const originalPushTavilyKey = process.env.PUSH_TAVILY_API_KEY;
const originalTavilyKey = process.env.TAVILY_API_KEY;
const originalViteTavilyKey = process.env.VITE_TAVILY_API_KEY;
const originalPushOllamaKey = process.env.PUSH_OLLAMA_API_KEY;
const originalOllamaKey = process.env.OLLAMA_API_KEY;
const originalViteOllamaKey = process.env.VITE_OLLAMA_API_KEY;
const originalWebSearchBackend = process.env.PUSH_WEB_SEARCH_BACKEND;

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

// ─── web_search ───────────────────────────────────────────────────

describe('web_search', () => {
  beforeEach(() => {
    delete process.env.PUSH_TAVILY_API_KEY;
    delete process.env.TAVILY_API_KEY;
    delete process.env.VITE_TAVILY_API_KEY;
    delete process.env.PUSH_OLLAMA_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    delete process.env.VITE_OLLAMA_API_KEY;
    delete process.env.PUSH_WEB_SEARCH_BACKEND;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalPushTavilyKey === undefined) delete process.env.PUSH_TAVILY_API_KEY;
    else process.env.PUSH_TAVILY_API_KEY = originalPushTavilyKey;
    if (originalTavilyKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = originalTavilyKey;
    if (originalViteTavilyKey === undefined) delete process.env.VITE_TAVILY_API_KEY;
    else process.env.VITE_TAVILY_API_KEY = originalViteTavilyKey;
    if (originalPushOllamaKey === undefined) delete process.env.PUSH_OLLAMA_API_KEY;
    else process.env.PUSH_OLLAMA_API_KEY = originalPushOllamaKey;
    if (originalOllamaKey === undefined) delete process.env.OLLAMA_API_KEY;
    else process.env.OLLAMA_API_KEY = originalOllamaKey;
    if (originalViteOllamaKey === undefined) delete process.env.VITE_OLLAMA_API_KEY;
    else process.env.VITE_OLLAMA_API_KEY = originalViteOllamaKey;
    if (originalWebSearchBackend === undefined) delete process.env.PUSH_WEB_SEARCH_BACKEND;
    else process.env.PUSH_WEB_SEARCH_BACKEND = originalWebSearchBackend;
  });

  it('uses Tavily when PUSH_TAVILY_API_KEY is set', async () => {
    process.env.PUSH_TAVILY_API_KEY = 'tvly-test-key';

    let capturedUrl = '';
    let capturedBody = null;
    globalThis.fetch = async (url, init = {}) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init.body || '{}'));
      return new Response(
        JSON.stringify({
          results: [
            { title: 'Tavily Result', url: 'https://example.com/tavily', content: 'fresh context' },
          ],
        }),
        { status: 200 },
      );
    };

    const result = await executeToolCall(
      { tool: 'web_search', args: { query: 'push cli tavily', max_results: 3 } },
      PUSH_ROOT,
    );

    assert.equal(result.ok, true);
    assert.equal(capturedUrl, 'https://api.tavily.com/search');
    assert.equal(capturedBody.api_key, 'tvly-test-key');
    assert.equal(capturedBody.query, 'push cli tavily');
    assert.equal(capturedBody.max_results, 3);
    assert.equal(result.meta.source, 'tavily');
    assert.ok(result.text.includes('Tavily Result'));
  });

  it('parses DuckDuckGo HTML results', async () => {
    const html = [
      '<html><body>',
      '<a class="result__a" href="https://example.com/alpha">Alpha <b>Result</b></a>',
      '<a class="result__snippet">Alpha snippet text</a>',
      '<a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fbeta">Beta Result</a>',
      '<div class="result__snippet">Beta snippet &amp; details</div>',
      '</body></html>',
    ].join('\n');

    globalThis.fetch = async () => new Response(html, { status: 200 });

    const result = await executeToolCall(
      { tool: 'web_search', args: { query: 'push cli', max_results: 2 } },
      PUSH_ROOT,
    );

    assert.equal(result.ok, true);
    assert.equal(result.meta.results, 2);
    assert.equal(result.meta.source, 'duckduckgo_html');
    assert.ok(result.text.includes('Alpha Result'));
    assert.ok(result.text.includes('https://example.com/beta'));
    assert.ok(result.text.includes('Beta snippet & details'));
  });

  it('uses Ollama native search when provider is ollama and key is present', async () => {
    let capturedUrl = '';
    let capturedBody = null;
    let capturedAuth = '';
    globalThis.fetch = async (url, init = {}) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(String(init.body || '{}'));
      capturedAuth = String(init.headers?.Authorization || init.headers?.authorization || '');
      return new Response(
        JSON.stringify({
          results: [
            { title: 'Ollama Result', url: 'https://example.com/ollama', content: 'native search context' },
          ],
        }),
        { status: 200 },
      );
    };

    const result = await executeToolCall(
      { tool: 'web_search', args: { query: 'ollama native search' } },
      PUSH_ROOT,
      { providerId: 'ollama', providerApiKey: 'ollama-test-key' },
    );

    assert.equal(result.ok, true);
    assert.equal(capturedUrl, 'https://ollama.com/api/web_search');
    assert.equal(capturedBody.query, 'ollama native search');
    assert.equal(capturedAuth, 'Bearer ollama-test-key');
    assert.equal(result.meta.source, 'ollama_native');
    assert.ok(result.text.includes('Ollama Result'));
  });

  it('falls back to DuckDuckGo when provider is ollama but key is missing', async () => {
    let capturedUrl = '';
    globalThis.fetch = async (url) => {
      capturedUrl = String(url);
      return new Response(
        '<html><body><a class="result__a" href="https://example.com/ddg">DDG Result</a><a class="result__snippet">fallback path</a></body></html>',
        { status: 200 },
      );
    };

    const result = await executeToolCall(
      { tool: 'web_search', args: { query: 'fallback expected' } },
      PUSH_ROOT,
      { providerId: 'ollama' },
    );

    assert.equal(result.ok, true);
    assert.equal(result.meta.source, 'duckduckgo_html');
    assert.ok(capturedUrl.startsWith('https://html.duckduckgo.com/html/?q='));
  });

  it('honors PUSH_WEB_SEARCH_BACKEND=duckduckgo even when Tavily key is set', async () => {
    process.env.PUSH_TAVILY_API_KEY = 'tvly-test-key';
    process.env.PUSH_WEB_SEARCH_BACKEND = 'duckduckgo';

    let capturedUrl = '';
    globalThis.fetch = async (url) => {
      capturedUrl = String(url);
      return new Response(
        '<html><body><a class="result__a" href="https://example.com/ddg-only">DDG Only</a><a class="result__snippet">forced backend</a></body></html>',
        { status: 200 },
      );
    };

    const result = await executeToolCall(
      { tool: 'web_search', args: { query: 'forced duckduckgo' } },
      PUSH_ROOT,
      { providerId: 'ollama', providerApiKey: 'ollama-test-key' },
    );

    assert.equal(result.ok, true);
    assert.equal(result.meta.backend, 'duckduckgo');
    assert.equal(result.meta.source, 'duckduckgo_html');
    assert.ok(capturedUrl.startsWith('https://html.duckduckgo.com/html/?q='));
  });

  it('returns clear error when backend=tavily and key is missing', async () => {
    process.env.PUSH_WEB_SEARCH_BACKEND = 'tavily';

    const result = await executeToolCall(
      { tool: 'web_search', args: { query: 'tavily required' } },
      PUSH_ROOT,
    );

    assert.equal(result.ok, false);
    assert.equal(result.structuredError.code, 'WEB_SEARCH_ERROR');
    assert.equal(result.meta.backend, 'tavily');
    assert.equal(result.meta.source, 'tavily');
    assert.ok(result.text.includes('search backend=tavily'));
  });

  it('returns clear error when backend=ollama and key is missing', async () => {
    process.env.PUSH_WEB_SEARCH_BACKEND = 'ollama';

    const result = await executeToolCall(
      { tool: 'web_search', args: { query: 'ollama required' } },
      PUSH_ROOT,
      { providerId: 'openrouter' },
    );

    assert.equal(result.ok, false);
    assert.equal(result.structuredError.code, 'WEB_SEARCH_ERROR');
    assert.equal(result.meta.backend, 'ollama');
    assert.equal(result.meta.source, 'ollama_native');
    assert.ok(result.text.includes('search backend=ollama'));
  });

  it('returns no-results message when parser finds none', async () => {
    globalThis.fetch = async () => new Response('<html><body>No hits</body></html>', { status: 200 });

    const result = await executeToolCall(
      { tool: 'web_search', args: { query: 'no results expected' } },
      PUSH_ROOT,
    );

    assert.equal(result.ok, true);
    assert.equal(result.meta.results, 0);
    assert.ok(result.text.includes('No web results found'));
  });

  it('returns structured error when upstream returns non-2xx', async () => {
    globalThis.fetch = async () => new Response('upstream unavailable', { status: 503 });

    const result = await executeToolCall(
      { tool: 'web_search', args: { query: 'service outage test' } },
      PUSH_ROOT,
    );

    assert.equal(result.ok, false);
    assert.equal(result.structuredError.code, 'WEB_SEARCH_ERROR');
    assert.ok(result.text.includes('DuckDuckGo returned 503'));
  });

  it('returns Tavily-specific error when Tavily request fails', async () => {
    process.env.PUSH_TAVILY_API_KEY = 'tvly-test-key';
    globalThis.fetch = async () => new Response('invalid key', { status: 401 });

    const result = await executeToolCall(
      { tool: 'web_search', args: { query: 'bad tavily key' } },
      PUSH_ROOT,
    );

    assert.equal(result.ok, false);
    assert.equal(result.structuredError.code, 'WEB_SEARCH_ERROR');
    assert.equal(result.meta.source, 'tavily');
    assert.ok(result.text.includes('Web search (tavily) failed'));
    assert.ok(result.text.includes('Tavily returned 401'));
  });

  it('is classified as read-only', () => {
    assert.equal(isReadOnlyToolCall({ tool: 'web_search' }), true);
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

  it('includes web_search', () => {
    assert.ok(TOOL_PROTOCOL.includes('web_search'), 'TOOL_PROTOCOL should mention web_search');
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
