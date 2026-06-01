/**
 * Tests for buildAuditorGateRuntimeContext — the CLI Auditor commit-gate's
 * retrieved-memory context. Verifies:
 *   - Auditor-scoped records are retrieved and the top record's verbatim
 *     `detail` (e.g. prior verification output) is surfaced, matching the web
 *     Auditor's includeTopDetail opt-in.
 *   - An empty repo scope short-circuits to '' (no retrieval).
 *   - File hints derived from the diff scope the retrieval.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildAuditorGateRuntimeContext } from '../auditor-gate-memory.ts';
import { createInMemoryStore } from '../../lib/context-memory-store.ts';
import { createMemoryRecord } from '../../lib/context-memory.ts';

const repo = 'owner/repo';
const branch = 'main';

function diffTouching(path) {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    '+const changed = true;',
    '',
  ].join('\n');
}

describe('buildAuditorGateRuntimeContext', () => {
  it('surfaces verbatim verification detail from a prior auditor-scoped record', async () => {
    const store = createInMemoryStore();
    store.write(
      createMemoryRecord({
        kind: 'verification_result',
        summary: 'typecheck: failed (exit 2)',
        detail: 'src/auth.ts(12,5): error TS2554: Expected 1 arguments, but got 2.',
        scope: { repoFullName: repo, branch, role: 'coder' },
        source: { kind: 'coder', label: 'Verification: typecheck' },
        relatedFiles: ['src/auth.ts'],
      }),
    );

    const block = await buildAuditorGateRuntimeContext({
      scope: { repoFullName: repo, branch },
      diff: diffTouching('src/auth.ts'),
      store,
    });

    assert.match(block, /\[RETRIEVED_VERIFICATION\]/);
    // The verbatim TS error from `detail` is surfaced, not just the summary.
    assert.match(block, /error TS2554/);
  });

  it('returns empty string when there is no repo scope', async () => {
    const store = createInMemoryStore();
    const block = await buildAuditorGateRuntimeContext({
      scope: { repoFullName: '', branch },
      diff: diffTouching('src/auth.ts'),
      store,
    });
    assert.equal(block, '');
  });

  it('returns empty string when no records match the scope', async () => {
    const store = createInMemoryStore();
    store.write(
      createMemoryRecord({
        kind: 'finding',
        summary: 'unrelated finding in another repo',
        scope: { repoFullName: 'someone/else', branch },
        source: { kind: 'explorer', label: 'other' },
      }),
    );

    const block = await buildAuditorGateRuntimeContext({
      scope: { repoFullName: repo, branch },
      diff: diffTouching('src/auth.ts'),
      store,
    });
    assert.equal(block, '');
  });
});
