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
  it('does not treat `function` keywords inside string literals as edited symbols', () => {
    const ledger = new FileAwarenessLedger();
    // Read a file fully so symbol-aware editing kicks in (no symbols recorded).
    ledger.recordRead('foo.ts', {
      symbols: [{ name: 'real', kind: 'function', lineRange: { start: 1, end: 1 } }],
    });

    // Edit content contains `function` only inside a string literal — not a real declaration.
    const editContent = 'const x = "function fake";';
    const verdict = ledger.checkSymbolicEditAllowed('foo.ts', editContent);

    // No symbols should be detected; the edit falls back to line-based checking and is allowed.
    expect(verdict.allowed).toBe(true);
  });
});
