import { describe, it, expect } from 'vitest';
import { normalizeToolArgs } from './tool-arg-normalization.js';
import { PASS_THROUGH_CLI_SOURCE, createToolDispatcher } from './tool-dispatch.js';

/**
 * Coverage for the semantic-contract layer: same `{tool, args}` shape, but the
 * argument *types* drift across providers (the "valid JSON ≠ satisfies the
 * contract" gap). The unit block pins the coercion/report policy of the pure
 * primitive; the matrix block proves the drift is reconciled end-to-end through
 * the real dispatcher — the analogue of `tool-call-format-matrix.test.ts` but on
 * the value axis instead of the wire-format axis. New drift shapes get a row
 * here rather than being discovered one bug report at a time.
 */

describe('normalizeToolArgs — coercion policy', () => {
  it('coerces a quoted integer to a number (repo_read start/end line)', () => {
    const r = normalizeToolArgs('repo_read', {
      repo: 'o/r',
      path: 'a.ts',
      start_line: '5',
      end_line: '20',
    });
    expect(r.changed).toBe(true);
    expect(r.args.start_line).toBe(5);
    expect(r.args.end_line).toBe(20);
    expect(r.mismatches).toEqual([]);
    expect(r.coercions.map((c) => c.param).sort()).toEqual(['end_line', 'start_line']);
  });

  it('coerces a quoted pr number (fetch_pr)', () => {
    const r = normalizeToolArgs('pr', { repo: 'o/r', pr: '42' });
    expect(r.args.pr).toBe(42);
    expect(r.changed).toBe(true);
  });

  it('coerces string booleans (show_commit stat)', () => {
    expect(normalizeToolArgs('show_commit', { ref: 'HEAD', stat: 'true' }).args.stat).toBe(true);
    expect(normalizeToolArgs('show_commit', { ref: 'HEAD', stat: 'FALSE' }).args.stat).toBe(false);
  });

  it('stringifies a primitive emitted where a string is expected', () => {
    // Inverse of the model's number-quoting habit: a bare number for a string
    // param (message) is safely stringified.
    const r = normalizeToolArgs('commit', { message: 123 });
    expect(r.args.message).toBe('123');
    expect(r.changed).toBe(true);
  });

  it('leaves already-correct types untouched (no spurious change)', () => {
    const r = normalizeToolArgs('repo_read', { repo: 'o/r', path: 'a.ts', start_line: 5 });
    expect(r.changed).toBe(false);
    expect(r.coercions).toEqual([]);
    expect(r.mismatches).toEqual([]);
    expect(r.args.start_line).toBe(5);
  });

  it('does not mutate the input args object', () => {
    const input = { repo: 'o/r', pr: '42' };
    const r = normalizeToolArgs('pr', input);
    expect(input.pr).toBe('42'); // original untouched
    expect(r.args).not.toBe(input);
    expect(r.args.pr).toBe(42);
  });

  it('reports a non-coercible type mismatch without mutating', () => {
    const r = normalizeToolArgs('repo_read', { repo: 'o/r', path: 'a.ts', start_line: 'abc' });
    expect(r.changed).toBe(false);
    expect(r.args.start_line).toBe('abc');
    expect(r.mismatches).toEqual([
      { param: 'start_line', reason: 'type_mismatch', expected: 'integer', actualType: 'string' },
    ]);
  });

  it('does not stringify objects/arrays into a string param', () => {
    const r = normalizeToolArgs('commit', { message: { nested: true } });
    expect(r.mismatches[0]).toMatchObject({ param: 'message', reason: 'type_mismatch' });
    expect(r.args.message).toEqual({ nested: true });
  });

  it('reports a missing required field', () => {
    const r = normalizeToolArgs('pr', { repo: 'o/r' }); // pr required, absent
    expect(r.mismatches).toContainEqual({
      param: 'pr',
      reason: 'missing_required',
      expected: 'integer',
    });
  });

  it('does not flag absent optional fields', () => {
    const r = normalizeToolArgs('repo_read', { repo: 'o/r', path: 'a.ts' }); // start/end optional
    expect(r.mismatches).toEqual([]);
  });

  it('enforces the active-repo enum only when context is supplied', () => {
    const args = { repo: 'wrong/repo', path: 'a.ts' };
    expect(normalizeToolArgs('repo_read', args).mismatches).toEqual([]); // no ctx → no pin
    const pinned = normalizeToolArgs('repo_read', args, { activeRepo: 'o/r' });
    expect(pinned.mismatches).toContainEqual({
      param: 'repo',
      reason: 'enum_violation',
      expected: 'string',
      actualType: 'string',
      allowed: ['o/r'],
    });
  });

  it('passes unknown tools through untouched (no schema to validate)', () => {
    const r = normalizeToolArgs('not_a_real_tool', { anything: '5' });
    expect(r.changed).toBe(false);
    expect(r.mismatches).toEqual([]);
    expect(r.args.anything).toBe('5');
  });

  it('does not coerce floats into an integer param', () => {
    const r = normalizeToolArgs('repo_read', { repo: 'o/r', path: 'a.ts', start_line: '5.5' });
    expect(r.mismatches[0]).toMatchObject({ param: 'start_line', reason: 'type_mismatch' });
    expect(r.args.start_line).toBe('5.5');
  });

  it('treats a whitespace-only string as a mismatch, not a coercion (intent)', () => {
    // After trim the string is empty, so there is no integer to parse — it must
    // report a mismatch rather than silently coerce to 0 or NaN.
    const r = normalizeToolArgs('repo_read', { repo: 'o/r', path: 'a.ts', start_line: '   ' });
    expect(r.changed).toBe(false);
    expect(r.args.start_line).toBe('   ');
    expect(r.mismatches).toEqual([
      { param: 'start_line', reason: 'type_mismatch', expected: 'integer', actualType: 'string' },
    ]);
  });
});

interface DriftRow {
  label: string;
  /** Canonical tool-call JSON as it would leak into the content stream. */
  sample: string;
  /** Tool name as emitted (PASS_THROUGH preserves the model's spelling). */
  tool: string;
  /** Expected args after the dispatcher's normalization pass. */
  expectArgs: Record<string, unknown>;
}

const DRIFT_MATRIX: DriftRow[] = [
  {
    label: 'quoted integer line range (repo_read)',
    sample:
      '{"tool":"repo_read","args":{"repo":"o/r","path":"a.ts","start_line":"5","end_line":"20"}}',
    tool: 'repo_read',
    expectArgs: { repo: 'o/r', path: 'a.ts', start_line: 5, end_line: 20 },
  },
  {
    label: 'quoted pr number (pr)',
    sample: '{"tool":"pr","args":{"repo":"o/r","pr":"42"}}',
    tool: 'pr',
    expectArgs: { repo: 'o/r', pr: 42 },
  },
  {
    label: 'string boolean flag (show_commit stat)',
    sample: '{"tool":"show_commit","args":{"ref":"HEAD","stat":"true"}}',
    tool: 'show_commit',
    expectArgs: { ref: 'HEAD', stat: true },
  },
  {
    label: 'correct types are a no-op (edit_range)',
    sample:
      '{"tool":"edit_range","args":{"path":"/w/a.ts","start_line":10,"end_line":12,"content":"x"}}',
    tool: 'edit_range',
    expectArgs: { path: '/w/a.ts', start_line: 10, end_line: 12, content: 'x' },
  },
];

describe('tool-arg drift matrix (through the real dispatcher)', () => {
  const dispatcher = createToolDispatcher([PASS_THROUGH_CLI_SOURCE]);

  for (const row of DRIFT_MATRIX) {
    it(`reconciles: ${row.label}`, () => {
      const result = dispatcher.detectAllToolCalls(row.sample);
      expect(result.malformed).toEqual([]);
      expect(result.calls).toHaveLength(1);
      const call = result.calls[0] as { tool: string; args: Record<string, unknown> };
      expect(call.tool).toBe(row.tool);
      expect(call.args).toEqual(row.expectArgs);
    });
  }

  it('native function-calls get the same normalization (Kimi/GLM path)', () => {
    const result = dispatcher.detectNativeToolCalls([
      { name: 'pr', args: { repo: 'o/r', pr: '7' } },
    ]);
    expect(result.calls).toHaveLength(1);
    expect((result.calls[0] as { args: Record<string, unknown> }).args.pr).toBe(7);
  });
});
