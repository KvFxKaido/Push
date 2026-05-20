/**
 * workspace-patch-card.test.mjs — drift detector for the persisted
 * `workspace-patch` chat card.
 *
 * PR 1 ships the card *shape* only (no capture, no replay, no UI). This
 * test pins the shape so a future PR can't quietly drift one side of the
 * contract — the constants, the apply-state variants, the refusal
 * reasons, and the validator's behaviour on canonical fixtures.
 *
 * The card is JSON-persisted alongside chat messages (today in
 * `localStorage` under `diff_conversations`; tomorrow possibly server-
 * side), and consumed by both surfaces. The round-trip case below
 * proves the CLI can re-validate a card that came off the wire as
 * JSON, which is the only contract V1 storage needs to satisfy.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  APPLY_STATE_VARIANT_KEYS,
  WORKSPACE_PATCH_APPLY_KINDS,
  WORKSPACE_PATCH_CARD_SCHEMA_VERSION,
  WORKSPACE_PATCH_REFUSAL_REASONS,
  validateWorkspacePatchCard,
} from '../../lib/protocol-schema.ts';

function baseCard(overrides = {}) {
  return {
    schemaVersion: WORKSPACE_PATCH_CARD_SCHEMA_VERSION,
    repoFullName: 'kvfxkaido/push',
    branch: 'claude/persist-diffs-chat-ZU4LO',
    baseSha: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0',
    diffBytes:
      'diff --git a/README.md b/README.md\n' +
      'index 0000001..0000002 100644\n' +
      '--- a/README.md\n' +
      '+++ b/README.md\n' +
      '@@ -1,1 +1,1 @@\n' +
      '-old line\n' +
      '+new line\n',
    truncated: false,
    capturedAt: 1_712_345_678_901,
    applyState: { kind: 'pending' },
    ...overrides,
  };
}

describe('workspace-patch card — schema pins', () => {
  it('pins the schema version (bumping it is a breaking change)', () => {
    assert.equal(WORKSPACE_PATCH_CARD_SCHEMA_VERSION, 1);
  });

  it('pins the apply-state kind list', () => {
    assert.deepEqual([...WORKSPACE_PATCH_APPLY_KINDS].sort(), [
      'applied',
      'conflict',
      'pending',
      'refused',
    ]);
  });

  it('pins the refusal-reason list', () => {
    assert.deepEqual([...WORKSPACE_PATCH_REFUSAL_REASONS].sort(), [
      'base-mismatch',
      'binary-placeholder',
      'truncated',
    ]);
  });
});

describe('workspace-patch card — canonical fixture', () => {
  it('accepts a minimal pending card', () => {
    assert.deepEqual(validateWorkspacePatchCard(baseCard()), []);
  });

  it('accepts an empty diffBytes (workspace touched, net-clean)', () => {
    assert.deepEqual(validateWorkspacePatchCard(baseCard({ diffBytes: '' })), []);
  });

  it('round-trips through JSON.stringify → JSON.parse and re-validates', () => {
    const card = baseCard();
    const reparsed = JSON.parse(JSON.stringify(card));
    assert.deepEqual(validateWorkspacePatchCard(reparsed), []);
    assert.deepEqual(reparsed, card);
  });

  it('tolerates unknown extra fields (forward-compat)', () => {
    // Convention in this module: extra fields don't break validation, so
    // a future optional field added by one surface doesn't fail readers
    // on the other surface.
    const card = baseCard({ futureField: 'ignored', anotherOne: 42 });
    assert.deepEqual(validateWorkspacePatchCard(card), []);
  });
});

describe('workspace-patch card — apply-state variants', () => {
  it("accepts applyState.kind === 'pending' with no extra fields", () => {
    assert.deepEqual(validateWorkspacePatchCard(baseCard({ applyState: { kind: 'pending' } })), []);
  });

  it("accepts applyState.kind === 'applied' with appliedAt", () => {
    assert.deepEqual(
      validateWorkspacePatchCard(
        baseCard({ applyState: { kind: 'applied', appliedAt: 1_712_345_679_000 } }),
      ),
      [],
    );
  });

  it("rejects applyState.kind === 'applied' without appliedAt", () => {
    const issues = validateWorkspacePatchCard(baseCard({ applyState: { kind: 'applied' } }));
    assert.equal(
      issues.some((i) => i.path === 'applyState.appliedAt'),
      true,
    );
  });

  it('accepts every documented refusal reason', () => {
    for (const reason of WORKSPACE_PATCH_REFUSAL_REASONS) {
      assert.deepEqual(
        validateWorkspacePatchCard(baseCard({ applyState: { kind: 'refused', reason } })),
        [],
        `refusal reason ${reason} should validate`,
      );
    }
  });

  it('rejects an undocumented refusal reason', () => {
    const issues = validateWorkspacePatchCard(
      baseCard({ applyState: { kind: 'refused', reason: 'made-up-reason' } }),
    );
    assert.equal(
      issues.some((i) => i.path === 'applyState.reason'),
      true,
    );
  });

  it("accepts applyState.kind === 'conflict' with non-empty detail", () => {
    assert.deepEqual(
      validateWorkspacePatchCard(
        baseCard({ applyState: { kind: 'conflict', detail: 'patch does not apply' } }),
      ),
      [],
    );
  });

  it("rejects applyState.kind === 'conflict' without detail", () => {
    const issues = validateWorkspacePatchCard(
      baseCard({ applyState: { kind: 'conflict', detail: '' } }),
    );
    assert.equal(
      issues.some((i) => i.path === 'applyState.detail'),
      true,
    );
  });

  it('rejects an unknown apply-state kind', () => {
    const issues = validateWorkspacePatchCard(baseCard({ applyState: { kind: 'frobnicated' } }));
    assert.equal(
      issues.some((i) => i.path === 'applyState.kind'),
      true,
    );
  });
});

describe('workspace-patch card — applyState variant-key isolation', () => {
  it('pins the per-variant required-key table', () => {
    assert.deepEqual(APPLY_STATE_VARIANT_KEYS, {
      pending: [],
      applied: ['appliedAt'],
      refused: ['reason'],
      conflict: ['detail'],
    });
  });

  it("rejects 'pending' carrying any other variant's field", () => {
    for (const stray of [
      { appliedAt: 1_712_345_679_000 },
      { reason: 'truncated' },
      { detail: 'leftover' },
    ]) {
      const [strayKey] = Object.keys(stray);
      const issues = validateWorkspacePatchCard(
        baseCard({ applyState: { kind: 'pending', ...stray } }),
      );
      assert.equal(
        issues.some((i) => i.path === `applyState.${strayKey}`),
        true,
        `pending + ${strayKey} should be rejected`,
      );
    }
  });

  it("rejects 'applied' carrying a refused/conflict field", () => {
    for (const stray of [{ reason: 'truncated' }, { detail: 'leftover' }]) {
      const [strayKey] = Object.keys(stray);
      const issues = validateWorkspacePatchCard(
        baseCard({ applyState: { kind: 'applied', appliedAt: 1, ...stray } }),
      );
      assert.equal(
        issues.some((i) => i.path === `applyState.${strayKey}`),
        true,
        `applied + ${strayKey} should be rejected`,
      );
    }
  });

  it("rejects 'refused' carrying an applied/conflict field", () => {
    for (const stray of [{ appliedAt: 1 }, { detail: 'leftover' }]) {
      const [strayKey] = Object.keys(stray);
      const issues = validateWorkspacePatchCard(
        baseCard({ applyState: { kind: 'refused', reason: 'truncated', ...stray } }),
      );
      assert.equal(
        issues.some((i) => i.path === `applyState.${strayKey}`),
        true,
        `refused + ${strayKey} should be rejected`,
      );
    }
  });

  it("rejects 'conflict' carrying an applied/refused field", () => {
    for (const stray of [{ appliedAt: 1 }, { reason: 'truncated' }]) {
      const [strayKey] = Object.keys(stray);
      const issues = validateWorkspacePatchCard(
        baseCard({ applyState: { kind: 'conflict', detail: 'd', ...stray } }),
      );
      assert.equal(
        issues.some((i) => i.path === `applyState.${strayKey}`),
        true,
        `conflict + ${strayKey} should be rejected`,
      );
    }
  });

  it('still allows truly novel forward-compat keys inside applyState', () => {
    // Only the *known* cross-variant keys are policed. A future
    // optional field (e.g. an unrelated `metadata` blob) must keep
    // round-tripping cleanly through old readers.
    assert.deepEqual(
      validateWorkspacePatchCard(
        baseCard({ applyState: { kind: 'pending', futureMetadata: { foo: 'bar' } } }),
      ),
      [],
    );
  });
});

describe('workspace-patch card — required-field rejection', () => {
  it('rejects non-objects', () => {
    for (const value of [null, undefined, 'string', 42, []]) {
      const issues = validateWorkspacePatchCard(value);
      assert.equal(issues.length > 0, true, `value ${JSON.stringify(value)} should be rejected`);
    }
  });

  it('rejects a card with a wrong schemaVersion', () => {
    const issues = validateWorkspacePatchCard(baseCard({ schemaVersion: 2 }));
    assert.equal(
      issues.some((i) => i.path === 'schemaVersion'),
      true,
    );
  });

  for (const field of ['repoFullName', 'branch', 'baseSha']) {
    it(`rejects an empty ${field}`, () => {
      const issues = validateWorkspacePatchCard(baseCard({ [field]: '' }));
      assert.equal(
        issues.some((i) => i.path === field),
        true,
      );
    });

    it(`rejects a non-string ${field}`, () => {
      const issues = validateWorkspacePatchCard(baseCard({ [field]: 42 }));
      assert.equal(
        issues.some((i) => i.path === field),
        true,
      );
    });
  }

  it('rejects a non-string diffBytes', () => {
    const issues = validateWorkspacePatchCard(baseCard({ diffBytes: 42 }));
    assert.equal(
      issues.some((i) => i.path === 'diffBytes'),
      true,
    );
  });

  it('rejects a non-boolean truncated', () => {
    const issues = validateWorkspacePatchCard(baseCard({ truncated: 'false' }));
    assert.equal(
      issues.some((i) => i.path === 'truncated'),
      true,
    );
  });

  it('rejects a non-integer capturedAt', () => {
    const issues = validateWorkspacePatchCard(baseCard({ capturedAt: 1.5 }));
    assert.equal(
      issues.some((i) => i.path === 'capturedAt'),
      true,
    );
  });

  it('rejects a negative capturedAt', () => {
    const issues = validateWorkspacePatchCard(baseCard({ capturedAt: -1 }));
    assert.equal(
      issues.some((i) => i.path === 'capturedAt'),
      true,
    );
  });

  it('rejects a missing applyState', () => {
    const card = baseCard();
    delete card.applyState;
    const issues = validateWorkspacePatchCard(card);
    assert.equal(
      issues.some((i) => i.path === 'applyState'),
      true,
    );
  });
});
