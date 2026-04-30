import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import nodePath from 'node:path';
import {
  awarenessGuardForCall,
  canonicalizeAwarenessPath,
  recordAwarenessFromCall,
} from '../engine.ts';
import { FileAwarenessLedger } from '../../lib/file-awareness-ledger.ts';

function cliLedger() {
  return new FileAwarenessLedger({
    readToolName: 'read_file',
    writeToolName: 'write_file',
  });
}

async function makeWorkspace() {
  const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), 'push-awareness-'));
  await fs.mkdir(nodePath.join(root, 'src'), { recursive: true });
  return root;
}

describe('canonicalizeAwarenessPath', () => {
  it('returns relative POSIX paths regardless of input form', () => {
    const root = '/tmp/workspace';
    assert.equal(canonicalizeAwarenessPath('src/foo.ts', root), 'src/foo.ts');
    assert.equal(canonicalizeAwarenessPath('/tmp/workspace/src/foo.ts', root), 'src/foo.ts');
    assert.equal(canonicalizeAwarenessPath('./src/foo.ts', root), 'src/foo.ts');
  });

  it('produces matching keys for the relative call.args.path and the absolute meta.path', () => {
    // The bug Codex/Copilot caught: tools return absolute paths in meta.path
    // (via ensureInsideWorkspace) but the model passes relative paths in
    // call.args.path. Both must canonicalize to the same key.
    const root = '/tmp/workspace';
    const fromArgs = canonicalizeAwarenessPath('src/foo.ts', root);
    const fromMeta = canonicalizeAwarenessPath('/tmp/workspace/src/foo.ts', root);
    assert.equal(fromArgs, fromMeta);
  });
});

describe('awarenessGuardForCall', () => {
  it('passes through non-write/non-edit calls', async () => {
    const ledger = cliLedger();
    const blocked = await awarenessGuardForCall(
      { tool: 'read_file', args: { path: 'src/foo.ts' } },
      ledger,
      '/tmp/workspace',
    );
    assert.equal(blocked, null);
  });

  it('passes through write_file/edit_file calls without a string path arg', async () => {
    const ledger = cliLedger();
    const blocked = await awarenessGuardForCall(
      { tool: 'write_file', args: {} },
      ledger,
      '/tmp/workspace',
    );
    assert.equal(blocked, null);
  });

  it('allows write_file to a brand-new file (does not exist on disk)', async () => {
    const root = await makeWorkspace();
    const ledger = cliLedger();
    // No prior read, file does not exist — the guard should let the write
    // through so write_file's create-file behavior is preserved.
    const blocked = await awarenessGuardForCall(
      { tool: 'write_file', args: { path: 'src/new.ts', content: 'export const x = 1;' } },
      ledger,
      root,
    );
    assert.equal(blocked, null);
  });

  it('blocks write_file with READ_REQUIRED on an unread file that exists on disk', async () => {
    const root = await makeWorkspace();
    await fs.writeFile(nodePath.join(root, 'src', 'existing.ts'), 'existing content', 'utf8');
    const ledger = cliLedger();
    const blocked = await awarenessGuardForCall(
      { tool: 'write_file', args: { path: 'src/existing.ts', content: 'x' } },
      ledger,
      root,
    );
    assert.ok(blocked, 'expected guard to block overwrite of unread existing file');
    assert.equal(blocked.structuredError?.code, 'READ_REQUIRED');
    assert.equal(blocked.structuredError?.retryable, true);
    assert.match(blocked.structuredError?.message ?? '', /read_file/);
    assert.match(blocked.text, /Awareness guard — write_file/);
  });

  it('blocks edit_file with READ_REQUIRED even when the file does not exist (no creation exception)', async () => {
    const root = await makeWorkspace();
    const ledger = cliLedger();
    const blocked = await awarenessGuardForCall(
      { tool: 'edit_file', args: { path: 'src/missing.ts', edits: [] } },
      ledger,
      root,
    );
    // edit_file requires existing content to apply hashline edits; the
    // creation exception is intentionally write_file-only.
    assert.ok(blocked, 'expected edit_file to be blocked even on missing files');
    assert.equal(blocked.structuredError?.code, 'READ_REQUIRED');
  });

  it('blocks edit_file with PARTIAL_READ on a file that has only been partially read', async () => {
    const root = await makeWorkspace();
    await fs.writeFile(nodePath.join(root, 'src', 'foo.ts'), '', 'utf8');
    const ledger = cliLedger();
    // Tool meta.path is absolute (mirrors what the real executor returns).
    recordAwarenessFromCall(
      { tool: 'read_file', args: { path: 'src/foo.ts' } },
      {
        ok: true,
        text: '',
        meta: {
          path: nodePath.join(root, 'src', 'foo.ts'),
          start_line: 1,
          end_line: 5,
          total_lines: 100,
        },
      },
      ledger,
      root,
    );
    const blocked = await awarenessGuardForCall(
      { tool: 'edit_file', args: { path: 'src/foo.ts', edits: [] } },
      ledger,
      root,
    );
    assert.ok(blocked);
    assert.equal(blocked.structuredError?.code, 'PARTIAL_READ');
  });

  it('allows write_file after a full read — guard accepts even though args.path is relative and meta.path was absolute', async () => {
    const root = await makeWorkspace();
    await fs.writeFile(nodePath.join(root, 'src', 'foo.ts'), 'content', 'utf8');
    const ledger = cliLedger();
    // Simulate the real CLI flow: read_file's meta.path is the absolute
    // resolved path returned by ensureInsideWorkspace.
    recordAwarenessFromCall(
      { tool: 'read_file', args: { path: 'src/foo.ts' } },
      {
        ok: true,
        text: '',
        meta: { path: nodePath.join(root, 'src', 'foo.ts') },
      },
      ledger,
      root,
    );
    // Guard receives the relative path the model wrote in call.args.path.
    // Without canonicalization the keys diverge and this case wrongly blocks.
    const blocked = await awarenessGuardForCall(
      { tool: 'write_file', args: { path: 'src/foo.ts', content: 'x' } },
      ledger,
      root,
    );
    assert.equal(blocked, null);
  });

  it('allows immediate follow-up edit_file after a successful write_file (no deadlock)', async () => {
    const root = await makeWorkspace();
    const ledger = cliLedger();
    // Simulate the recorder's view of a successful write_file (absolute meta.path).
    recordAwarenessFromCall(
      { tool: 'write_file', args: { path: 'src/new.ts', content: 'x' } },
      { ok: true, text: '', meta: { path: nodePath.join(root, 'src', 'new.ts') } },
      ledger,
      root,
    );
    // Need the file to exist so the no-creation path applies for edit_file.
    await fs.writeFile(nodePath.join(root, 'src', 'new.ts'), 'x', 'utf8');
    const blocked = await awarenessGuardForCall(
      { tool: 'edit_file', args: { path: 'src/new.ts', edits: [] } },
      ledger,
      root,
    );
    assert.equal(blocked, null);
  });
});

describe('recordAwarenessFromCall', () => {
  it('does nothing when the result is not ok', async () => {
    const root = await makeWorkspace();
    await fs.writeFile(nodePath.join(root, 'src', 'foo.ts'), 'x', 'utf8');
    const ledger = cliLedger();
    recordAwarenessFromCall(
      { tool: 'read_file', args: { path: 'src/foo.ts' } },
      { ok: false, text: 'error' },
      ledger,
      root,
    );
    // Nothing recorded — a follow-up write of the existing file should still
    // be blocked as never_read.
    const blocked = await awarenessGuardForCall(
      { tool: 'write_file', args: { path: 'src/foo.ts', content: 'x' } },
      ledger,
      root,
    );
    assert.equal(blocked?.structuredError?.code, 'READ_REQUIRED');
  });

  it('does nothing when meta.path is missing', async () => {
    const root = await makeWorkspace();
    await fs.writeFile(nodePath.join(root, 'src', 'foo.ts'), 'x', 'utf8');
    const ledger = cliLedger();
    recordAwarenessFromCall(
      { tool: 'read_file', args: { path: 'src/foo.ts' } },
      { ok: true, text: '', meta: {} },
      ledger,
      root,
    );
    const blocked = await awarenessGuardForCall(
      { tool: 'write_file', args: { path: 'src/foo.ts', content: 'x' } },
      ledger,
      root,
    );
    assert.equal(blocked?.structuredError?.code, 'READ_REQUIRED');
  });

  it('records read_symbol with the symbol body line range', async () => {
    const root = await makeWorkspace();
    await fs.writeFile(nodePath.join(root, 'src', 'foo.ts'), 'x', 'utf8');
    const ledger = cliLedger();
    recordAwarenessFromCall(
      { tool: 'read_symbol', args: { path: 'src/foo.ts', symbol: 'foo' } },
      {
        ok: true,
        text: '',
        meta: {
          path: nodePath.join(root, 'src', 'foo.ts'),
          symbol: 'foo',
          start_line: 12,
          end_line: 30,
        },
      },
      ledger,
      root,
    );
    // Partial read inside the symbol body — write should still be blocked
    // as PARTIAL_READ until a full read covers the rest.
    const blocked = await awarenessGuardForCall(
      { tool: 'write_file', args: { path: 'src/foo.ts', content: 'x' } },
      ledger,
      root,
    );
    assert.equal(blocked?.structuredError?.code, 'PARTIAL_READ');
  });
});
