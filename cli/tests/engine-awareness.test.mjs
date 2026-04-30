import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { awarenessGuardForCall, recordAwarenessFromCall } from '../engine.ts';
import { FileAwarenessLedger } from '../../lib/file-awareness-ledger.ts';

function cliLedger() {
  return new FileAwarenessLedger({
    readToolName: 'read_file',
    writeToolName: 'write_file',
  });
}

describe('awarenessGuardForCall', () => {
  it('passes through non-write/non-edit calls', () => {
    const ledger = cliLedger();
    const blocked = awarenessGuardForCall(
      { tool: 'read_file', args: { path: 'src/foo.ts' } },
      ledger,
    );
    assert.equal(blocked, null);
  });

  it('passes through write_file/edit_file calls without a string path arg', () => {
    const ledger = cliLedger();
    const blocked = awarenessGuardForCall({ tool: 'write_file', args: {} }, ledger);
    assert.equal(blocked, null);
  });

  it('blocks write_file when the file has never been read with READ_REQUIRED', () => {
    const ledger = cliLedger();
    const blocked = awarenessGuardForCall(
      { tool: 'write_file', args: { path: 'src/new.ts', content: 'export const x = 1;' } },
      ledger,
    );
    assert.ok(blocked, 'expected guard to block');
    assert.equal(blocked.ok, false);
    assert.equal(blocked.structuredError?.code, 'READ_REQUIRED');
    assert.equal(blocked.structuredError?.retryable, true);
    assert.match(blocked.structuredError?.message ?? '', /read_file/);
    assert.match(blocked.text, /Awareness guard — write_file/);
  });

  it('blocks edit_file when the file has only been partially read with PARTIAL_READ', () => {
    const ledger = cliLedger();
    recordAwarenessFromCall(
      { tool: 'read_file', args: { path: 'src/foo.ts' } },
      {
        ok: true,
        text: '',
        meta: { path: 'src/foo.ts', start_line: 1, end_line: 5, total_lines: 100 },
      },
      ledger,
    );
    const blocked = awarenessGuardForCall(
      { tool: 'edit_file', args: { path: 'src/foo.ts', edits: [] } },
      ledger,
    );
    assert.ok(blocked, 'expected guard to block');
    assert.equal(blocked.structuredError?.code, 'PARTIAL_READ');
  });

  it('allows write_file after a full read', () => {
    const ledger = cliLedger();
    recordAwarenessFromCall(
      { tool: 'read_file', args: { path: 'src/foo.ts' } },
      { ok: true, text: '', meta: { path: 'src/foo.ts' } },
      ledger,
    );
    const blocked = awarenessGuardForCall(
      { tool: 'write_file', args: { path: 'src/foo.ts', content: 'x' } },
      ledger,
    );
    assert.equal(blocked, null);
  });

  it('allows immediate follow-up edit_file after a successful write_file (no deadlock)', () => {
    const ledger = cliLedger();
    // Simulate a successful write_file on a never-read file: the awareness
    // recorder marks it model_authored via recordCreation.
    recordAwarenessFromCall(
      { tool: 'write_file', args: { path: 'src/new.ts', content: 'x' } },
      { ok: true, text: '', meta: { path: 'src/new.ts' } },
      ledger,
    );
    // Follow-up edit must not be blocked.
    const blocked = awarenessGuardForCall(
      { tool: 'edit_file', args: { path: 'src/new.ts', edits: [] } },
      ledger,
    );
    assert.equal(blocked, null);
  });
});

describe('recordAwarenessFromCall', () => {
  it('does nothing when the result is not ok', () => {
    const ledger = cliLedger();
    recordAwarenessFromCall(
      { tool: 'read_file', args: { path: 'src/foo.ts' } },
      { ok: false, text: 'error' },
      ledger,
    );
    // Nothing recorded — a follow-up write should still be blocked as never_read.
    const blocked = awarenessGuardForCall(
      { tool: 'write_file', args: { path: 'src/foo.ts', content: 'x' } },
      ledger,
    );
    assert.equal(blocked?.structuredError?.code, 'READ_REQUIRED');
  });

  it('does nothing when meta.path is missing', () => {
    const ledger = cliLedger();
    recordAwarenessFromCall(
      { tool: 'read_file', args: { path: 'src/foo.ts' } },
      { ok: true, text: '', meta: {} },
      ledger,
    );
    const blocked = awarenessGuardForCall(
      { tool: 'write_file', args: { path: 'src/foo.ts', content: 'x' } },
      ledger,
    );
    assert.equal(blocked?.structuredError?.code, 'READ_REQUIRED');
  });

  it('records read_symbol with the symbol body line range', () => {
    const ledger = cliLedger();
    recordAwarenessFromCall(
      { tool: 'read_symbol', args: { path: 'src/foo.ts', symbol: 'foo' } },
      {
        ok: true,
        text: '',
        meta: { path: 'src/foo.ts', symbol: 'foo', start_line: 12, end_line: 30 },
      },
      ledger,
    );
    // Partial read inside the symbol body — write should still be blocked
    // as PARTIAL_READ until a full read covers the rest.
    const blocked = awarenessGuardForCall(
      { tool: 'write_file', args: { path: 'src/foo.ts', content: 'x' } },
      ledger,
    );
    assert.equal(blocked?.structuredError?.code, 'PARTIAL_READ');
  });
});
