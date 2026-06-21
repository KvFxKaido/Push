import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { retainReducedOutput } from './verbatim-retain';
import { createInMemoryVerbatimLog } from './verbatim-log';
import type { ReducedOutput } from './tool-output-reducers';

const repo = 'owner/repo';

function reduced(over: Partial<ReducedOutput> = {}): ReducedOutput {
  return {
    stdout: 'short',
    stderr: '',
    reduced: true,
    reducerId: 'npm',
    originalChars: 5000,
    reducedChars: 200,
    savedChars: 4800,
    ...over,
  };
}

// stderr logging is incidental; keep the test output quiet.
beforeEach(() => vi.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('retainReducedOutput', () => {
  it('stores the raw output and returns a recall marker with the ref', async () => {
    const verbatimLog = createInMemoryVerbatimLog();
    const rawText = 'FULL OUTPUT\n'.repeat(500);

    const { ref, marker } = await retainReducedOutput({
      reduced: reduced(),
      rawText,
      command: 'npm install',
      scope: { repoFullName: repo, branch: 'main' },
      verbatimLog,
    });

    expect(ref).toBeTruthy();
    expect(marker).toContain('memory_expand');
    expect(marker).toContain(ref!);
    expect((await verbatimLog.read(ref!))?.text).toBe(rawText); // byte-exact
  });

  it('is a no-op when the output was not reduced', async () => {
    const verbatimLog = createInMemoryVerbatimLog();
    const res = await retainReducedOutput({
      reduced: reduced({ reduced: false }),
      rawText: 'whatever',
      scope: { repoFullName: repo },
      verbatimLog,
    });
    expect(res).toEqual({});
    expect(await verbatimLog.size()).toBe(0);
  });

  it('is a no-op when no scope is available (nothing to scope-guard a recall to)', async () => {
    const verbatimLog = createInMemoryVerbatimLog();
    const res = await retainReducedOutput({
      reduced: reduced(),
      rawText: 'big output',
      scope: { repoFullName: '' },
      verbatimLog,
    });
    expect(res).toEqual({});
    expect(await verbatimLog.size()).toBe(0);
  });

  it('degrades to no marker when the log append throws (best-effort)', async () => {
    const brokenLog = {
      ...createInMemoryVerbatimLog(),
      append: () => Promise.reject(new Error('disk full')),
    };
    const res = await retainReducedOutput({
      reduced: reduced(),
      rawText: 'big output',
      scope: { repoFullName: repo },
      verbatimLog: brokenLog,
    });
    expect(res).toEqual({});
  });
});
