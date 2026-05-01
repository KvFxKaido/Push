import { describe, expect, it } from 'vitest';
import {
  clearMutationFailure,
  extractMutatedPaths,
  formatMutationHardFailure,
  recordMutationFailure,
  type MutationFailureEntry,
} from './coder-mutation-results.js';

describe('coder mutation result helpers', () => {
  it('extracts every patchset edit path', () => {
    expect(
      extractMutatedPaths(
        'sandbox_apply_patchset',
        { edits: [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 42 }] },
        '',
      ),
    ).toEqual(['a.ts', 'b.ts']);
  });

  it('falls back to the primary path for single-file mutations', () => {
    expect(extractMutatedPaths('sandbox_write_file', {}, 'app/src/file.ts')).toEqual([
      'app/src/file.ts',
    ]);
  });

  it('increments repeated failures for the same tool, file, and error type', () => {
    const failures = new Map<string, MutationFailureEntry>();

    expect(recordMutationFailure(failures, 'sandbox_write_file', 'a.ts', 'EPERM')).toMatchObject({
      count: 1,
    });
    expect(recordMutationFailure(failures, 'sandbox_write_file', 'a.ts', 'EPERM')).toMatchObject({
      count: 2,
    });
  });

  it('resets the count when the error type changes', () => {
    const failures = new Map<string, MutationFailureEntry>();

    recordMutationFailure(failures, 'sandbox_write_file', 'a.ts', 'EPERM');
    expect(recordMutationFailure(failures, 'sandbox_write_file', 'a.ts', 'EIO')).toMatchObject({
      errorType: 'EIO',
      count: 1,
    });
  });

  it('clears failures using the same mutation key', () => {
    const failures = new Map<string, MutationFailureEntry>();
    recordMutationFailure(failures, 'sandbox_write_file', 'a.ts', 'EPERM');

    clearMutationFailure(failures, 'sandbox_write_file', 'a.ts');

    expect(failures.size).toBe(0);
  });

  it('formats the hard-failure instruction block', () => {
    expect(
      formatMutationHardFailure({
        tool: 'sandbox_write_file',
        file: 'a.ts',
        errorType: 'EPERM',
        count: 3,
      }),
    ).toContain('sandbox_write_file has failed 3 consecutive times on a.ts');
  });
});
