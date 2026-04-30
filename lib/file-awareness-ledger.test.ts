import { describe, it, expect, beforeEach } from 'vitest';
import {
  FileAwarenessLedger,
  extractSignatures,
  extractSignaturesWithLines,
} from './file-awareness-ledger.js';

describe('FileAwarenessLedger.checkLinesCovered', () => {
  let ledger: FileAwarenessLedger;

  beforeEach(() => {
    ledger = new FileAwarenessLedger();
  });

  it('blocks lines for never-read files', () => {
    const result = ledger.checkLinesCovered('foo.ts', [1, 2, 3]);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('not been read');
    }
  });

  it('allows all lines for fully-read files', () => {
    ledger.recordRead('foo.ts');
    const result = ledger.checkLinesCovered('foo.ts', [1, 50, 999]);
    expect(result.allowed).toBe(true);
  });

  it('allows all lines for model-authored files', () => {
    ledger.recordCreation('foo.ts');
    const result = ledger.checkLinesCovered('foo.ts', [1, 50]);
    expect(result.allowed).toBe(true);
  });

  it('allows lines within partial read ranges', () => {
    ledger.recordRead('foo.ts', { startLine: 10, endLine: 50 });
    const result = ledger.checkLinesCovered('foo.ts', [10, 25, 50]);
    expect(result.allowed).toBe(true);
  });

  it('blocks lines outside partial read ranges', () => {
    ledger.recordRead('foo.ts', { startLine: 10, endLine: 50 });
    const result = ledger.checkLinesCovered('foo.ts', [5, 25, 60]);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('5');
      expect(result.reason).toContain('60');
    }
  });

  it('handles multiple disjoint read ranges', () => {
    ledger.recordRead('foo.ts', { startLine: 1, endLine: 50 });
    ledger.recordRead('foo.ts', { startLine: 100, endLine: 150 });

    // Lines within both ranges
    expect(ledger.checkLinesCovered('foo.ts', [25, 125]).allowed).toBe(true);

    // Line in the gap
    const result = ledger.checkLinesCovered('foo.ts', [25, 75, 125]);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('75');
    }
  });

  it('formats uncovered lines as ranges', () => {
    ledger.recordRead('foo.ts', { startLine: 1, endLine: 10 });
    const result = ledger.checkLinesCovered('foo.ts', [15, 16, 17, 20]);
    expect(result.allowed).toBe(false);
    // Should show "15-17, 20" not "15, 16, 17, 20"
    if (!result.allowed) {
      expect(result.reason).toContain('15-17');
      expect(result.reason).toContain('20');
    }
  });

  it('allows empty line numbers array', () => {
    const result = ledger.checkLinesCovered('foo.ts', []);
    expect(result.allowed).toBe(true);
  });

  it('blocks stale files even if lines were previously in range', () => {
    ledger.recordRead('foo.ts', { startLine: 1, endLine: 100 });
    ledger.markStale('foo.ts');
    // Stale files are blocked — consistent with checkWriteAllowed()
    const result = ledger.checkLinesCovered('foo.ts', [50]);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toContain('may have changed');
    }
  });
});

describe('extractSignatures — export default handling', () => {
  it('captures the class name on `export default class Foo`, not the `class` keyword', () => {
    const summary = extractSignatures('export default class Foo {}\n');
    expect(summary).not.toBeNull();
    expect(summary).toContain('export default class Foo');
    expect(summary).not.toContain('export default class,');
  });

  it('captures default-exported functions and bare identifiers', () => {
    const summary = extractSignatures(
      ['export default function bar() {}', 'export default someValue;'].join('\n'),
    );
    expect(summary).not.toBeNull();
    expect(summary).toContain('export default function bar');
    expect(summary).toContain('export default someValue');
  });
});

describe('extractSignaturesWithLines — export default handling', () => {
  it('records `export default class Foo` as the symbol `Foo`, not `class`', () => {
    const symbols = extractSignaturesWithLines('export default class Foo {}\n');
    const names = symbols.map((s) => s.name);
    expect(names).toContain('Foo');
    expect(names).not.toContain('class');
  });

  it('records `export default function bar` under both `function` and `export` kinds', () => {
    const symbols = extractSignaturesWithLines('export default function bar() {}\n');
    const named = symbols.filter((s) => s.name === 'bar');
    const kinds = named.map((s) => s.kind).sort();
    expect(kinds).toEqual(['export', 'function']);
  });
});

describe('FileAwarenessLedger.checkSymbolicEditAllowed — line anchoring', () => {
  it('does not treat a `function` keyword inside a string literal as an edited declaration', () => {
    const ledger = new FileAwarenessLedger();
    // partial_read forces checkSymbolicEditAllowed to actually run extractSymbolsFromEdit;
    // a fully_read entry would short-circuit and leave the regex anchoring untested.
    ledger.recordRead('foo.ts', {
      startLine: 1,
      endLine: 1,
      symbols: [{ name: 'real', kind: 'function', lineRange: { start: 1, end: 1 } }],
    });

    // Pre-fix: the unanchored regex matches `function fake` inside the string and treats
    // `fake` as an edited declaration, blocking the write. With the line-start anchor it
    // only sees `function real` at column 0, which the model has read.
    const editContent = 'function real() { const x = "function fake"; }';
    const verdict = ledger.checkSymbolicEditAllowed('foo.ts', editContent);

    expect(verdict.allowed).toBe(true);
  });
});

describe('FileAwarenessLedger — verdict codes and tool-name parameterization', () => {
  it('attaches a READ_REQUIRED code on never-read writes', () => {
    const ledger = new FileAwarenessLedger();
    const verdict = ledger.checkWriteAllowed('foo.ts');
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.code).toBe('READ_REQUIRED');
      expect(verdict.reason).toContain('sandbox_read_file');
    }
  });

  it('attaches a PARTIAL_READ code on partial-read writes', () => {
    const ledger = new FileAwarenessLedger();
    ledger.recordRead('foo.ts', { startLine: 10, endLine: 50 });
    const verdict = ledger.checkWriteAllowed('foo.ts');
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.code).toBe('PARTIAL_READ');
    }
  });

  it('attaches a STALE_AWARENESS code on stale writes', () => {
    const ledger = new FileAwarenessLedger();
    ledger.recordRead('foo.ts');
    ledger.markStale('foo.ts');
    const verdict = ledger.checkWriteAllowed('foo.ts');
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.code).toBe('STALE_AWARENESS');
    }
  });

  it('attaches a UNREAD_LINES code when partial read does not cover edit lines', () => {
    const ledger = new FileAwarenessLedger();
    ledger.recordRead('foo.ts', { startLine: 1, endLine: 10 });
    const verdict = ledger.checkLinesCovered('foo.ts', [50]);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.code).toBe('UNREAD_LINES');
    }
  });

  it('uses CLI-flavored tool names in verdict reasons when configured', () => {
    const ledger = new FileAwarenessLedger({
      readToolName: 'read_file',
      writeToolName: 'write_file',
    });
    const verdict = ledger.checkWriteAllowed('foo.ts');
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toContain('read_file');
      expect(verdict.reason).not.toContain('sandbox_read_file');
    }
  });

  it('preserves sandbox-flavored tool names by default for web/Worker callers', () => {
    const ledger = new FileAwarenessLedger();
    ledger.recordRead('foo.ts', { startLine: 1, endLine: 10 });
    const partialVerdict = ledger.checkWriteAllowed('foo.ts');
    expect(partialVerdict.allowed).toBe(false);
    if (!partialVerdict.allowed) {
      expect(partialVerdict.reason).toContain('sandbox_read_file');
    }
  });
});

describe('FileAwarenessLedger — recovery loop with CLI tool names', () => {
  function cliLedger() {
    return new FileAwarenessLedger({
      readToolName: 'read_file',
      writeToolName: 'write_file',
    });
  }

  it('blocks write_file when the file has never been read', () => {
    const verdict = cliLedger().checkWriteAllowed('src/foo.ts');
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.code).toBe('READ_REQUIRED');
      expect(verdict.reason).toContain('read_file');
    }
  });

  it('blocks write_file when the file was only partially read', () => {
    const ledger = cliLedger();
    ledger.recordRead('src/foo.ts', { startLine: 1, endLine: 5, totalLines: 100 });
    const verdict = ledger.checkWriteAllowed('src/foo.ts');
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.code).toBe('PARTIAL_READ');
    }
  });

  it('allows write_file after a full read', () => {
    const ledger = cliLedger();
    ledger.recordRead('src/foo.ts');
    expect(ledger.checkWriteAllowed('src/foo.ts').allowed).toBe(true);
  });

  it('does not deadlock on follow-up edits to model-authored files', () => {
    const ledger = cliLedger();
    // Write to a never-read file simulates the "create new file" path the CLI
    // wires after a successful write_file by calling recordCreation.
    ledger.recordCreation('src/new.ts');
    // Subsequent edit_file (which the CLI guards via checkWriteAllowed for v1)
    // must be allowed without forcing a read of a file the model just wrote.
    const followUp = ledger.checkWriteAllowed('src/new.ts');
    expect(followUp.allowed).toBe(true);
  });
});

describe('signature regexes — async/abstract modifiers on default exports', () => {
  it('captures the function name on `export default async function foo`, not `async`', () => {
    const summary = extractSignatures('export default async function foo() {}\n');
    expect(summary).not.toBeNull();
    const items = summary!.replace(/^contains: /, '').split(', ');
    expect(items).toContain('export default async function foo');
    expect(items).not.toContain('export default async');
  });

  it('records `export default async function foo` under both `function` and `export` kinds with name=foo', () => {
    const symbols = extractSignaturesWithLines('export default async function foo() {}\n');
    const namesByKind = new Map<string, string[]>();
    for (const s of symbols) {
      const list = namesByKind.get(s.kind) ?? [];
      list.push(s.name);
      namesByKind.set(s.kind, list);
    }
    expect(namesByKind.get('function')).toEqual(['foo']);
    expect(namesByKind.get('export')).toEqual(['foo']);
    // No bogus `async` symbol from the export-default catch-all.
    const allNames = symbols.map((s) => s.name);
    expect(allNames).not.toContain('async');
  });

  it('captures the class name on `export default abstract class Foo`, not `abstract`', () => {
    const symbols = extractSignaturesWithLines('export default abstract class Foo {}\n');
    const exported = symbols.filter((s) => s.kind === 'export');
    expect(exported.map((s) => s.name)).toEqual(['Foo']);
    const allNames = symbols.map((s) => s.name);
    expect(allNames).not.toContain('abstract');
  });
});
