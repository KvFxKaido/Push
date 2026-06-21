import { describe, it, expect } from 'vitest';
import {
  createInMemoryVerbatimLog,
  verbatimBaseRef,
  getDefaultVerbatimLog,
  setDefaultVerbatimLog,
} from './verbatim-log';

const repo = 'owner/repo';
const branch = 'main';

describe('verbatim-log', () => {
  it('stores and reads back the exact original text, untruncated', async () => {
    const log = createInMemoryVerbatimLog();
    // Far larger than the typed store's 2000/800 detail caps — the whole point.
    const huge = 'x'.repeat(50_000) + '\n  indented\ttabbed line that must survive';
    const entry = await log.append({ scope: { repoFullName: repo, branch }, text: huge });

    expect(entry.byteLen).toBe(huge.length);
    const read = await log.read(entry.ref);
    expect(read?.text).toBe(huge); // lossless: byte-for-byte
  });

  it('is idempotent on identical (scope, text) — repeat append reuses the entry', async () => {
    const log = createInMemoryVerbatimLog();
    const text = 'npm install output line A\nline B\n';
    const first = await log.append({ scope: { repoFullName: repo, branch }, text });
    const second = await log.append({ scope: { repoFullName: repo, branch }, text });

    expect(second.ref).toBe(first.ref);
    expect(await log.size()).toBe(1);
  });

  it('distinct texts never share a ref and always round-trip exactly', async () => {
    const log = createInMemoryVerbatimLog();
    const a = 'first';
    const b = 'second';
    const ea = await log.append({ scope: { repoFullName: repo }, text: a });
    const eb = await log.append({ scope: { repoFullName: repo }, text: b });

    expect(ea.ref).not.toBe(eb.ref);
    expect((await log.read(ea.ref))?.text).toBe(a);
    expect((await log.read(eb.ref))?.text).toBe(b);
    expect(verbatimBaseRef(a).startsWith('vb_')).toBe(true);
  });

  it('returns undefined for an unknown or pruned ref', async () => {
    const log = createInMemoryVerbatimLog();
    expect(await log.read('vb_deadbeef_10')).toBeUndefined();
  });

  it('filters by scope with soft matching, newest-first', async () => {
    const log = createInMemoryVerbatimLog();
    await log.append({ scope: { repoFullName: repo, branch: 'main' }, text: 'on main', now: 1 });
    await log.append({ scope: { repoFullName: repo, branch: 'feat' }, text: 'on feat', now: 2 });
    await log.append({
      scope: { repoFullName: 'other/repo', branch: 'main' },
      text: 'elsewhere',
      now: 3,
    });

    // Query without a branch matches both branches of the repo (soft match),
    // excludes the other repo, and is ordered newest-first.
    const repoOnly = await log.listByScope({ repoFullName: repo });
    expect(repoOnly.map((e) => e.text)).toEqual(['on feat', 'on main']);

    // Naming the branch narrows to it.
    const mainOnly = await log.listByScope({ repoFullName: repo, branch: 'main' });
    expect(mainOnly.map((e) => e.text)).toEqual(['on main']);
  });

  it('prunes entries older than a cutoff and returns the count removed', async () => {
    const log = createInMemoryVerbatimLog();
    await log.append({ scope: { repoFullName: repo }, text: 'old', now: 100 });
    await log.append({ scope: { repoFullName: repo }, text: 'new', now: 200 });

    const removed = await log.pruneOlderThan(150);
    expect(removed).toBe(1);
    expect(await log.size()).toBe(1);
    expect((await log.listByScope({ repoFullName: repo }))[0]?.text).toBe('new');
  });

  it('carries optional kind/label provenance but omits them when absent', async () => {
    const log = createInMemoryVerbatimLog();
    const tagged = await log.append({
      scope: { repoFullName: repo },
      text: 'tagged',
      kind: 'tool_output',
      label: 'npm install',
    });
    const bare = await log.append({ scope: { repoFullName: repo }, text: 'bare' });

    expect(tagged.kind).toBe('tool_output');
    expect(tagged.label).toBe('npm install');
    expect('kind' in bare).toBe(false);
    expect('label' in bare).toBe(false);
  });

  it('exposes a swappable process default, like the typed store', async () => {
    const original = getDefaultVerbatimLog();
    expect(getDefaultVerbatimLog()).toBe(original); // stable singleton

    const replacement = createInMemoryVerbatimLog();
    setDefaultVerbatimLog(replacement);
    expect(getDefaultVerbatimLog()).toBe(replacement);

    setDefaultVerbatimLog(null); // reset so later tests get a fresh lazy default
    expect(getDefaultVerbatimLog()).not.toBe(replacement);
  });
});
