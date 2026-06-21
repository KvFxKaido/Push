import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createInMemoryStore } from './context-memory-store';
import { createMemoryRecord } from './context-memory';
import { runMemoryGrep, runMemoryExpand, createMemoryToolExecutor } from './memory-tool-exec';
import { createInMemoryVerbatimLog } from './verbatim-log';
import type { ContextMemoryStore } from './context-memory-store';

const repo = 'owner/repo';
const branch = 'main';

function seed(store: ContextMemoryStore) {
  const verify = createMemoryRecord({
    kind: 'verification_result',
    summary: 'typecheck: failed (exit 2)',
    detail: 'src/auth.ts(12,5): error TS2554: Expected 1 arguments, but got 2.',
    scope: { repoFullName: repo, branch, role: 'coder' },
    source: { kind: 'coder', label: 'Verification: typecheck' },
    relatedFiles: ['src/auth.ts'],
  });
  const decision = createMemoryRecord({
    kind: 'decision',
    summary: 'Gate the merge on typecheck',
    detail: 'Question: block merge? Answer: yes — auth seam, prior asymmetric allowlist.',
    scope: { repoFullName: repo, branch },
    source: { kind: 'orchestrator', label: 'Checkpoint' },
  });
  store.write(verify);
  store.write(decision);
  return { verify, decision };
}

// Silence the module's structured logs during tests.
beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe('runMemoryGrep', () => {
  it('returns matches with record id and verbatim detail', async () => {
    const store = createInMemoryStore();
    const { verify } = seed(store);

    const result = await runMemoryGrep(
      { pattern: 'TS2554' },
      { scope: { repoFullName: repo, branch }, store },
    );

    expect(result.text).toContain('[Tool Result — memory_grep]');
    expect(result.text).toContain(verify.id);
    expect(result.text).toContain('error TS2554');
    expect(result.meta.matches).toBe(1);
  });

  it('reports no matches without throwing', async () => {
    const store = createInMemoryStore();
    seed(store);
    const result = await runMemoryGrep(
      { pattern: 'nonexistent-xyz' },
      { scope: { repoFullName: repo, branch }, store },
    );
    expect(result.text).toContain('No memory records match');
    expect(result.meta.matches).toBe(0);
  });

  it('rejects an empty pattern', async () => {
    const store = createInMemoryStore();
    const result = await runMemoryGrep(
      { pattern: '   ' },
      { scope: { repoFullName: repo, branch }, store },
    );
    expect(result.text).toContain('[Tool Error — memory_grep]');
  });

  it('honors a kinds filter', async () => {
    const store = createInMemoryStore();
    seed(store);
    // "typecheck" appears in the verification record; restrict to decisions → no match.
    const result = await runMemoryGrep(
      { pattern: 'typecheck', kinds: ['decision'] },
      { scope: { repoFullName: repo, branch }, store },
    );
    expect(result.meta.matches).toBe(1); // the decision summary "Gate the merge on typecheck"
    expect(result.text).toContain('decision');
    expect(result.text).not.toContain('exit 2');
  });

  it('does not reach another repo', async () => {
    const store = createInMemoryStore();
    seed(store);
    const result = await runMemoryGrep(
      { pattern: 'TS2554' },
      { scope: { repoFullName: 'someone/else', branch }, store },
    );
    expect(result.meta.matches).toBe(0);
  });

  it('rejects an all-invalid kinds filter instead of silently broadening', async () => {
    const store = createInMemoryStore();
    seed(store);
    const result = await runMemoryGrep(
      { pattern: 'typecheck', kinds: ['decisions'] }, // typo — not a real kind
      { scope: { repoFullName: repo, branch }, store },
    );
    expect(result.text).toContain('[Tool Error — memory_grep]');
    expect(result.text).toContain('no valid kinds');
  });

  it('uses valid kinds and notes the ignored ones', async () => {
    const store = createInMemoryStore();
    seed(store);
    const result = await runMemoryGrep(
      { pattern: 'typecheck', kinds: ['decision', 'bogus'] },
      { scope: { repoFullName: repo, branch }, store },
    );
    expect(result.meta.matches).toBe(1);
    expect(result.text).toContain('Ignored unknown kinds: bogus');
  });
});

describe('runMemoryExpand', () => {
  it('returns verbatim records for the requested ids', async () => {
    const store = createInMemoryStore();
    const { decision } = seed(store);
    const result = await runMemoryExpand(
      { ids: [decision.id] },
      { scope: { repoFullName: repo, branch }, store },
    );
    expect(result.text).toContain('[Tool Result — memory_expand]');
    expect(result.text).toContain(decision.detail!);
    expect(result.meta.found).toBe(1);
  });

  it('tolerates the bracketed [mem_…] display form in ids', async () => {
    const store = createInMemoryStore();
    const { decision } = seed(store);
    const result = await runMemoryExpand(
      { ids: [`[${decision.id}]`] },
      { scope: { repoFullName: repo, branch }, store },
    );
    expect(result.meta.found).toBe(1);
    expect(result.text).toContain(decision.detail!);
  });

  it('lists ids that were not found', async () => {
    const store = createInMemoryStore();
    const { decision } = seed(store);
    const result = await runMemoryExpand(
      { ids: [decision.id, 'mem_missing'] },
      { scope: { repoFullName: repo, branch }, store },
    );
    expect(result.text).toContain('Not found: mem_missing');
    expect(result.meta.found).toBe(1);
  });

  it('rejects an empty id list', async () => {
    const store = createInMemoryStore();
    const result = await runMemoryExpand(
      { ids: [] },
      { scope: { repoFullName: repo, branch }, store },
    );
    expect(result.text).toContain('[Tool Error — memory_expand]');
  });

  it('does not expand a record from another repo', async () => {
    const store = createInMemoryStore();
    const { decision } = seed(store);
    const result = await runMemoryExpand(
      { ids: [decision.id] },
      { scope: { repoFullName: 'someone/else', branch }, store },
    );
    expect(result.meta.found).toBe(0);
    expect(result.text).toContain('Nothing found');
  });
});

describe('runMemoryExpand — verbatim refs', () => {
  it('recalls a verbatim entry by ref within scope', async () => {
    const store = createInMemoryStore();
    const verbatimLog = createInMemoryVerbatimLog();
    const full = 'npm error full log\n'.repeat(500);
    const entry = await verbatimLog.append({
      scope: { repoFullName: repo, branch },
      text: full,
      kind: 'tool_output',
      command: 'npm install',
    });

    const res = await runMemoryExpand(
      { refs: [entry.ref] },
      { scope: { repoFullName: repo, branch }, store, verbatimLog },
    );

    expect(res.text).toContain('content (verbatim)');
    expect(res.text).toContain('npm error full log');
    expect(res.meta.refsFound).toBe(1);
  });

  it('refuses a ref from another repo (scope guard)', async () => {
    const store = createInMemoryStore();
    const verbatimLog = createInMemoryVerbatimLog();
    const entry = await verbatimLog.append({
      scope: { repoFullName: 'other/repo', branch },
      text: 'secret from another repo',
    });

    const res = await runMemoryExpand(
      { refs: [entry.ref] },
      { scope: { repoFullName: repo, branch }, store, verbatimLog },
    );

    expect(res.text).toContain('Nothing found');
    expect(res.text).not.toContain('secret from another repo');
    expect(res.meta.refsMissing).toBe(1);
  });

  it('accepts ids and refs together, and tolerates the bracketed/quoted display form', async () => {
    const store = createInMemoryStore();
    const { verify } = seed(store);
    const verbatimLog = createInMemoryVerbatimLog();
    const entry = await verbatimLog.append({
      scope: { repoFullName: repo, branch },
      text: 'combined recall body',
    });

    const res = await runMemoryExpand(
      { ids: [`[${verify.id}]`], refs: [`"${entry.ref}"`] },
      { scope: { repoFullName: repo, branch }, store, verbatimLog },
    );

    expect(res.meta.found).toBe(1);
    expect(res.meta.refsFound).toBe(1);
    expect(res.text).toContain('combined recall body');
  });

  it('errors when neither ids nor refs are supplied', async () => {
    const res = await runMemoryExpand(
      {},
      { scope: { repoFullName: repo, branch }, store: createInMemoryStore() },
    );
    expect(res.text).toContain('ids');
    expect(res.text).toContain('refs');
  });
});

describe('createMemoryToolExecutor', () => {
  it('routes memory_grep through the shared runner with the bound scope', async () => {
    const store = createInMemoryStore();
    seed(store);
    const exec = createMemoryToolExecutor({ repoFullName: repo, branch }, store);
    const res = await exec('memory_grep', { pattern: 'typecheck' });
    expect(res.text).toContain('memory_grep');
    expect(res.text).toContain('typecheck');
  });

  it('routes memory_expand through the shared runner', async () => {
    const store = createInMemoryStore();
    const { verify } = seed(store);
    const exec = createMemoryToolExecutor({ repoFullName: repo, branch }, store);
    const res = await exec('memory_expand', { ids: [verify.id] });
    expect(res.text).toContain('memory_expand');
    expect(res.text).toContain(verify.id);
  });

  it('returns a benign error for an unknown memory tool', async () => {
    const exec = createMemoryToolExecutor({ repoFullName: repo, branch }, createInMemoryStore());
    const res = await exec('memory_delete', {});
    expect(res.text).toContain('Unknown memory tool');
  });

  it('binds scope from the executor, not model args — a different repo sees no records', async () => {
    const store = createInMemoryStore();
    seed(store); // records live under `repo`
    // Scope is captured at construction; the model only supplies the pattern.
    const exec = createMemoryToolExecutor({ repoFullName: 'someone/else', branch }, store);
    const res = await exec('memory_grep', { pattern: 'typecheck' });
    expect(res.text).toContain('No memory records match');
  });
});
