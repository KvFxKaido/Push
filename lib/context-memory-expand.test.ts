import { describe, it, expect } from 'vitest';
import { createInMemoryStore } from './context-memory-store';
import { createMemoryRecord } from './context-memory';
import { expandMemoryRecords, grepMemory } from './context-memory-expand';
import { createInMemoryVerbatimLog } from './verbatim-log';
import type { ContextMemoryStore } from './context-memory-store';
import type { MemoryRecordKind } from './runtime-contract';

const repo = 'owner/repo';
const branch = 'main';

function seed(store: ContextMemoryStore) {
  const decision = createMemoryRecord({
    kind: 'decision',
    summary: 'Use httpOnly cookies for the GitHub token',
    detail:
      'Question: localStorage vs httpOnly cookies for the GitHub token? Answer: deferred — the ' +
      'current defenses (Content-Security-Policy, origin allowlist, a 1-hour token TTL, and ' +
      'server-side revocation via the session endpoint) make the migration low-urgency for now. ' +
      'Revisit this decision if the token TTL is extended, if server-side revocation is removed, ' +
      'or if a new XSS sink is introduced into the web surface.',
    scope: { repoFullName: repo, branch },
    source: { kind: 'orchestrator', label: 'Interactive Checkpoint Decision' },
  });
  const finding = createMemoryRecord({
    kind: 'finding',
    summary: 'Auth refresh is guarded in useAuth.ts',
    scope: { repoFullName: repo, branch, role: 'explorer' },
    source: { kind: 'explorer', label: 'Explorer investigation' },
    relatedFiles: ['app/src/hooks/useAuth.ts'],
    relatedSymbols: ['useAuth'],
  });
  store.write(decision);
  store.write(finding);
  return { decision, finding };
}

describe('expandMemoryRecords', () => {
  it('returns verbatim detail, not the packer-truncated summary', async () => {
    const store = createInMemoryStore();
    const { decision } = seed(store);

    const result = await expandMemoryRecords({ ids: [decision.id], store });

    expect(result.missing).toEqual([]);
    expect(result.found).toHaveLength(1);
    // The full stored detail comes back, well beyond the packer's 220-char summary slice.
    expect(result.found[0].detail).toBe(decision.detail);
    expect(result.found[0].detail!.length).toBeGreaterThan(220);
  });

  it('preserves requested order and de-duplicates repeated ids', async () => {
    const store = createInMemoryStore();
    const { decision, finding } = seed(store);

    const result = await expandMemoryRecords({
      ids: [finding.id, decision.id, finding.id],
      store,
    });

    expect(result.found.map((r) => r.id)).toEqual([finding.id, decision.id]);
  });

  it('reports unknown ids as missing rather than throwing', async () => {
    const store = createInMemoryStore();
    const { decision } = seed(store);

    const result = await expandMemoryRecords({ ids: [decision.id, 'mem_nope'], store });

    expect(result.found.map((r) => r.id)).toEqual([decision.id]);
    expect(result.missing).toEqual(['mem_nope']);
  });

  it('excludes out-of-scope records via the scope guard', async () => {
    const store = createInMemoryStore();
    const { decision } = seed(store);

    const result = await expandMemoryRecords({
      ids: [decision.id],
      store,
      scope: { repoFullName: repo, branch: 'other-branch' },
    });

    expect(result.found).toEqual([]);
    expect(result.missing).toEqual([decision.id]);
  });

  it('excludes expired records unless includeExpired is set', async () => {
    const store = createInMemoryStore();
    const expired = createMemoryRecord({
      kind: 'finding',
      summary: 'stale finding',
      scope: { repoFullName: repo, branch },
      source: { kind: 'explorer', label: 'old' },
      freshness: 'expired',
    });
    store.write(expired);

    const hidden = await expandMemoryRecords({ ids: [expired.id], store });
    expect(hidden.missing).toEqual([expired.id]);

    const shown = await expandMemoryRecords({ ids: [expired.id], store, includeExpired: true });
    expect(shown.found.map((r) => r.id)).toEqual([expired.id]);
  });
});

describe('grepMemory', () => {
  it('matches against verbatim detail and reports the matched field', async () => {
    const store = createInMemoryStore();
    seed(store);

    const result = await grepMemory({ repoFullName: repo, branch, pattern: 'revocation', store });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].record.kind).toBe('decision');
    expect(result.matches[0].matchedFields).toContain('detail');
  });

  it('is case-insensitive and matches related files', async () => {
    const store = createInMemoryStore();
    seed(store);

    const result = await grepMemory({ repoFullName: repo, branch, pattern: 'USEAUTH.TS', store });

    expect(result.matches.map((m) => m.record.kind)).toContain('finding');
    expect(result.matches[0].matchedFields).toContain('relatedFiles');
  });

  it('filters by kind', async () => {
    const store = createInMemoryStore();
    seed(store);

    const result = await grepMemory({
      repoFullName: repo,
      branch,
      pattern: 'guarded',
      kinds: ['decision'],
      store,
    });

    expect(result.matches).toEqual([]);
  });

  it('caps results at the limit and flags truncation', async () => {
    const store = createInMemoryStore();
    for (let i = 0; i < 5; i++) {
      store.write(
        createMemoryRecord({
          kind: 'finding',
          summary: `shared-needle finding ${i}`,
          scope: { repoFullName: repo, branch },
          source: { kind: 'explorer', label: 'seed', createdAt: 1_000 + i },
        }),
      );
    }

    const result = await grepMemory({
      repoFullName: repo,
      branch,
      pattern: 'shared-needle',
      limit: 2,
      store,
    });

    expect(result.matches).toHaveLength(2);
    expect(result.scanned).toBe(5);
    expect(result.truncated).toBe(true);
    // Newest first: createdAt 1004 then 1003.
    expect(result.matches[0].record.source.createdAt).toBe(1_004);
  });

  it('returns empty for a blank pattern without scanning', async () => {
    const store = createInMemoryStore();
    seed(store);

    const result = await grepMemory({ repoFullName: repo, branch, pattern: '   ', store });

    expect(result).toEqual({ matches: [], scanned: 0, truncated: false });
  });

  it('excludes other repos', async () => {
    const store = createInMemoryStore();
    seed(store);
    store.write(
      createMemoryRecord({
        kind: 'finding',
        summary: 'revocation logic in another repo',
        scope: { repoFullName: 'someone/else', branch },
        source: { kind: 'explorer', label: 'other' },
      }),
    );

    const result = await grepMemory({ repoFullName: repo, branch, pattern: 'revocation', store });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].record.kind).toBe('decision');
  });
});

// Guards against drift in the record-kind vocabulary the kernel filters on.
const KNOWN_KINDS: MemoryRecordKind[] = [
  'fact',
  'finding',
  'decision',
  'task_outcome',
  'verification_result',
  'file_change',
  'symbol_trace',
  'dependency_trace',
];

describe('grepMemory kind filter coverage', () => {
  it('accepts every known record kind', async () => {
    const store = createInMemoryStore();
    for (const kind of KNOWN_KINDS) {
      store.write(
        createMemoryRecord({
          kind,
          summary: `needle ${kind}`,
          scope: { repoFullName: repo, branch },
          source: { kind: 'explorer', label: kind },
        }),
      );
    }

    const result = await grepMemory({
      repoFullName: repo,
      branch,
      pattern: 'needle',
      kinds: KNOWN_KINDS,
      limit: 100,
      store,
    });

    expect(result.matches).toHaveLength(KNOWN_KINDS.length);
  });
});

describe('expandMemoryRecords — verbatim resolution (LCM Phase 3)', () => {
  it('replaces capped detail with the full original when a verbatimRef + log are present', async () => {
    const store = createInMemoryStore();
    const verbatimLog = createInMemoryVerbatimLog();

    const full = 'L'.repeat(9000); // far past the 2000-char detail cap
    const entry = await verbatimLog.append({ scope: { repoFullName: repo, branch }, text: full });

    const record = createMemoryRecord({
      kind: 'verification_result',
      summary: 'tests: failed (exit 1)',
      detail: full, // createMemoryRecord truncates this to the cap
      scope: { repoFullName: repo, branch, role: 'coder' },
      source: { kind: 'coder', label: 'Verification: tests' },
    });
    record.verbatimRef = entry.ref;
    await store.write(record);

    // No log → capped stored detail, not flagged verbatim.
    const capped = await expandMemoryRecords({ ids: [record.id], store });
    expect(capped.found[0]?.verbatim).toBeUndefined();
    expect(capped.found[0]?.detail!.length).toBeLessThanOrEqual(2000);
    // The ref is still surfaced so a caller knows a fuller version exists.
    expect(capped.found[0]?.verbatimRef).toBe(entry.ref);

    // With the log → full original, byte-for-byte, flagged verbatim.
    const resolved = await expandMemoryRecords({ ids: [record.id], store, verbatimLog });
    expect(resolved.found[0]?.verbatim).toBe(true);
    expect(resolved.found[0]?.detail).toBe(full);
  });

  it('degrades to capped detail when the verbatim entry was pruned', async () => {
    const store = createInMemoryStore();
    const verbatimLog = createInMemoryVerbatimLog();

    const record = createMemoryRecord({
      kind: 'finding',
      summary: 'big finding',
      detail: 'D'.repeat(5000),
      scope: { repoFullName: repo, branch },
      source: { kind: 'explorer', label: 'Explorer investigation' },
    });
    record.verbatimRef = 'vb_missing_5000'; // points at nothing (e.g. pruned)
    await store.write(record);

    const resolved = await expandMemoryRecords({ ids: [record.id], store, verbatimLog });
    expect(resolved.found[0]?.verbatim).toBeUndefined();
    expect(resolved.found[0]?.detail!.length).toBeLessThanOrEqual(2000);
  });
});
