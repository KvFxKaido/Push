import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFileLedger,
  updateFileLedger,
  getLedgerSummary,
} from '../file-ledger.mjs';

describe('getLedgerSummary', () => {
  it('returns empty files array for fresh ledger', () => {
    const ledger = createFileLedger();
    const summary = getLedgerSummary(ledger);
    assert.deepEqual(summary, { total: 0, files: [] });
  });

  it('includes file paths with status, reads, and writes', () => {
    const ledger = createFileLedger();

    updateFileLedger(ledger, { tool: 'read_file' }, {
      ok: true,
      meta: { path: 'src/foo.ts', total_lines: 10, start_line: 1, end_line: 5 },
    });

    updateFileLedger(ledger, { tool: 'read_file' }, {
      ok: true,
      meta: { path: 'src/bar.ts', total_lines: 20, start_line: 1, end_line: 20 },
    });

    updateFileLedger(ledger, { tool: 'write_file' }, {
      ok: true,
      meta: { path: 'src/baz.ts' },
    });

    const summary = getLedgerSummary(ledger);
    assert.equal(summary.total, 3);
    assert.equal(summary.files.length, 3);

    const foo = summary.files.find(f => f.path === 'src/foo.ts');
    assert.ok(foo);
    assert.equal(foo.status, 'partial_read');
    assert.equal(foo.reads, 1);
    assert.equal(foo.writes, 0);

    const bar = summary.files.find(f => f.path === 'src/bar.ts');
    assert.ok(bar);
    assert.equal(bar.status, 'fully_read');
    assert.equal(bar.reads, 1);
    assert.equal(bar.writes, 0);

    const baz = summary.files.find(f => f.path === 'src/baz.ts');
    assert.ok(baz);
    assert.equal(baz.status, 'model_authored');
    assert.equal(baz.reads, 0);
    assert.equal(baz.writes, 1);
  });

  it('tracks multiple reads and writes per file', () => {
    const ledger = createFileLedger();

    updateFileLedger(ledger, { tool: 'read_file' }, {
      ok: true,
      meta: { path: 'lib/utils.ts', total_lines: 50, start_line: 1, end_line: 25 },
    });

    updateFileLedger(ledger, { tool: 'read_file' }, {
      ok: true,
      meta: { path: 'lib/utils.ts', total_lines: 50, start_line: 1, end_line: 50 },
    });

    updateFileLedger(ledger, { tool: 'edit_file' }, {
      ok: true,
      meta: { path: 'lib/utils.ts' },
    });

    const summary = getLedgerSummary(ledger);
    assert.equal(summary.total, 1);

    const entry = summary.files[0];
    assert.equal(entry.path, 'lib/utils.ts');
    assert.equal(entry.status, 'model_authored');
    assert.equal(entry.reads, 2);
    assert.equal(entry.writes, 1);
  });

  it('does not include aggregate status counts', () => {
    const ledger = createFileLedger();
    updateFileLedger(ledger, { tool: 'read_file' }, {
      ok: true,
      meta: { path: 'a.ts', total_lines: 10, start_line: 1, end_line: 10 },
    });

    const summary = getLedgerSummary(ledger);
    assert.equal(summary.never_read, undefined);
    assert.equal(summary.partial_read, undefined);
    assert.equal(summary.fully_read, undefined);
    assert.equal(summary.model_authored, undefined);
  });
});
