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
    // The bug Codex/Copilot caught in #454: tools return absolute paths in
    // meta.path (via ensureInsideWorkspace) but the model passes relative
    // paths in call.args.path. Both must canonicalize to the same key.
    const root = '/tmp/workspace';
    const fromArgs = canonicalizeAwarenessPath('src/foo.ts', root);
    const fromMeta = canonicalizeAwarenessPath('/tmp/workspace/src/foo.ts', root);
    assert.equal(fromArgs, fromMeta);
  });
});

describe('awarenessGuardForCall — pass-through cases', () => {
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
});

describe('awarenessGuardForCall — auto-recovery succeeds', () => {
  it('allows write_file on a previously-unread existing file (auto-recovery reads it)', async () => {
    const root = await makeWorkspace();
    await fs.writeFile(nodePath.join(root, 'src', 'existing.ts'), 'existing content', 'utf8');
    const ledger = cliLedger();
    // No prior recordRead; pre-#454 the guard would have blocked READ_REQUIRED.
    // With auto-recovery the harness reads the file, marks fully_read, retries.
    const blocked = await awarenessGuardForCall(
      { tool: 'write_file', args: { path: 'src/existing.ts', content: 'x' } },
      ledger,
      root,
    );
    assert.equal(blocked, null);
  });

  it('allows edit_file on a previously partially-read file (auto-recovery upgrades to fully_read)', async () => {
    const root = await makeWorkspace();
    await fs.writeFile(nodePath.join(root, 'src', 'foo.ts'), 'function existing() {}\n', 'utf8');
    const ledger = cliLedger();
    // Simulate a prior partial read that didn't cover the whole file. Pre-PR
    // the guard would PARTIAL_READ-block; auto-recovery reads the rest and
    // upgrades to fully_read, so the symbolic check then allows the edit.
    recordAwarenessFromCall(
      { tool: 'read_file', args: { path: 'src/foo.ts' } },
      {
        ok: true,
        text: '',
        meta: {
          path: nodePath.join(root, 'src', 'foo.ts'),
          start_line: 1,
          end_line: 1,
          total_lines: 1,
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
    assert.equal(blocked, null);
  });

  it('allows write_file to a brand-new file (does not exist on disk)', async () => {
    const root = await makeWorkspace();
    const ledger = cliLedger();
    // Auto-recovery's read fails with ENOENT; the ENOENT branch allows
    // write_file through (creation), preserving its create-file behavior.
    const blocked = await awarenessGuardForCall(
      { tool: 'write_file', args: { path: 'src/new.ts', content: 'export const x = 1;' } },
      ledger,
      root,
    );
    assert.equal(blocked, null);
  });
});

describe('awarenessGuardForCall — auto-recovery cannot help', () => {
  it('blocks edit_file with READ_REQUIRED on a missing file (no creation exception)', async () => {
    const root = await makeWorkspace();
    const ledger = cliLedger();
    // Auto-recovery's read fails ENOENT; edit_file is intentionally NOT given
    // the ENOENT pass — hashline edits require existing content to apply.
    const blocked = await awarenessGuardForCall(
      { tool: 'edit_file', args: { path: 'src/missing.ts', edits: [] } },
      ledger,
      root,
    );
    assert.ok(blocked, 'expected edit_file to be blocked even on missing files');
    assert.equal(blocked.structuredError?.code, 'READ_REQUIRED');
    assert.equal(blocked.structuredError?.retryable, true);
    assert.match(blocked.structuredError?.message ?? '', /read_file/);
    assert.match(blocked.text, /Awareness guard — edit_file/);
  });

  it('propagates the original verdict when auto-recovery hits a non-ENOENT error (e.g. EISDIR)', async () => {
    const root = await makeWorkspace();
    // A directory at the path: fs.readFile throws EISDIR. Auto-recovery's
    // catch surfaces the original verdict rather than an opaque crash.
    await fs.mkdir(nodePath.join(root, 'src', 'is-a-dir'));
    const ledger = cliLedger();
    const blocked = await awarenessGuardForCall(
      { tool: 'write_file', args: { path: 'src/is-a-dir', content: 'x' } },
      ledger,
      root,
    );
    assert.ok(blocked, 'expected guard to block when auto-recovery cannot read');
    assert.equal(blocked.structuredError?.code, 'READ_REQUIRED');
  });
});

describe('awarenessGuardForCall — verdict already allows', () => {
  it('allows write_file after a full read — args.path relative, recorded meta.path absolute', async () => {
    const root = await makeWorkspace();
    await fs.writeFile(nodePath.join(root, 'src', 'foo.ts'), 'content', 'utf8');
    const ledger = cliLedger();
    // Simulate the real CLI flow: read_file's meta.path is the absolute
    // resolved path returned by ensureInsideWorkspace.
    recordAwarenessFromCall(
      { tool: 'read_file', args: { path: 'src/foo.ts' } },
      { ok: true, text: '', meta: { path: nodePath.join(root, 'src', 'foo.ts') } },
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
    recordAwarenessFromCall(
      { tool: 'write_file', args: { path: 'src/new.ts', content: 'x' } },
      { ok: true, text: '', meta: { path: nodePath.join(root, 'src', 'new.ts') } },
      ledger,
      root,
    );
    await fs.writeFile(nodePath.join(root, 'src', 'new.ts'), 'x', 'utf8');
    const blocked = await awarenessGuardForCall(
      { tool: 'edit_file', args: { path: 'src/new.ts', edits: [] } },
      ledger,
      root,
    );
    assert.equal(blocked, null);
  });
});

describe('awarenessGuardForCall — symbolic precision wired through auto-recovery', () => {
  it('allows edit_file declaring a new symbol because auto-recovery upgrades to fully_read', async () => {
    const root = await makeWorkspace();
    // File contains function `existing`; model has no prior reads. Edit
    // synthesizes content declaring a different symbol `unrelated` — the
    // canonical's `checkSymbolicEditAllowed` is wired in for edit_file (vs.
    // `checkWriteAllowed`), but auto-recovery upgrades the file to
    // fully_read first, and `checkSymbolicEditAllowed` short-circuits on
    // fully_read. Net effect: allowed. Documents the (intentional)
    // dominance of auto-recovery over the symbolic check.
    await fs.writeFile(
      nodePath.join(root, 'src', 'foo.ts'),
      'export function existing() { return 1; }\n',
      'utf8',
    );
    const ledger = cliLedger();
    const blocked = await awarenessGuardForCall(
      {
        tool: 'edit_file',
        args: {
          path: 'src/foo.ts',
          edits: [
            {
              op: 'insert_after',
              ref: 'existing',
              content: 'export function unrelated() { return 2; }',
            },
          ],
        },
      },
      ledger,
      root,
    );
    assert.equal(blocked, null);
  });
});

describe('awarenessGuardForCall — workspace boundary enforcement', () => {
  it('rejects write_file with a `..` traversal without touching the filesystem', async () => {
    const root = await makeWorkspace();
    const ledger = cliLedger();
    const blocked = await awarenessGuardForCall(
      {
        tool: 'write_file',
        args: { path: '../escape.ts', content: 'export const pwned = true;' },
      },
      ledger,
      root,
    );
    // ensureInsideWorkspace rejects the path; auto-recovery falls through
    // to the original verdict instead of reading or stat'ing out-of-scope.
    assert.ok(blocked, 'expected guard to block path-escape attempts');
    assert.equal(blocked.structuredError?.code, 'READ_REQUIRED');
  });

  it('rejects edit_file with an absolute path outside the workspace', async () => {
    const root = await makeWorkspace();
    const ledger = cliLedger();
    const blocked = await awarenessGuardForCall(
      { tool: 'edit_file', args: { path: '/etc/passwd', edits: [] } },
      ledger,
      root,
    );
    assert.ok(blocked, 'expected guard to block absolute-path escape attempts');
    assert.equal(blocked.structuredError?.code, 'READ_REQUIRED');
  });
});

describe('recordAwarenessFromCall', () => {
  it('does nothing when the result is not ok', async () => {
    const root = await makeWorkspace();
    const ledger = cliLedger();
    recordAwarenessFromCall(
      { tool: 'read_file', args: { path: 'src/foo.ts' } },
      { ok: false, text: 'error' },
      ledger,
      root,
    );
    // No prior recordRead call recorded coverage. No file at the path either,
    // so auto-recovery hits ENOENT — write_file gets through (creation),
    // but edit_file remains blocked.
    const blocked = await awarenessGuardForCall(
      { tool: 'edit_file', args: { path: 'src/foo.ts', edits: [] } },
      ledger,
      root,
    );
    assert.equal(blocked?.structuredError?.code, 'READ_REQUIRED');
  });

  it('does nothing when meta.path is missing', async () => {
    const root = await makeWorkspace();
    const ledger = cliLedger();
    recordAwarenessFromCall(
      { tool: 'read_file', args: { path: 'src/foo.ts' } },
      { ok: true, text: '', meta: {} },
      ledger,
      root,
    );
    // Same shape: no recorded coverage, no file at the path → edit_file
    // blocked because hashline edits need existing content.
    const blocked = await awarenessGuardForCall(
      { tool: 'edit_file', args: { path: 'src/foo.ts', edits: [] } },
      ledger,
      root,
    );
    assert.equal(blocked?.structuredError?.code, 'READ_REQUIRED');
  });

  it('records read_symbol with the symbol body line range', async () => {
    const root = await makeWorkspace();
    await fs.writeFile(nodePath.join(root, 'src', 'foo.ts'), 'export function foo() {}\n', 'utf8');
    const ledger = cliLedger();
    recordAwarenessFromCall(
      { tool: 'read_symbol', args: { path: 'src/foo.ts', symbol: 'foo' } },
      {
        ok: true,
        text: '',
        meta: {
          path: nodePath.join(root, 'src', 'foo.ts'),
          symbol: 'foo',
          start_line: 1,
          end_line: 1,
        },
      },
      ledger,
      root,
    );
    // After read_symbol the entry is partial_read covering lines 1-1.
    // A subsequent write_file would have been PARTIAL_READ-blocked pre-PR;
    // with auto-recovery the harness reads the rest of the file and allows.
    const blocked = await awarenessGuardForCall(
      { tool: 'write_file', args: { path: 'src/foo.ts', content: 'x' } },
      ledger,
      root,
    );
    assert.equal(blocked, null);
  });
});
