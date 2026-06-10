/**
 * RunCheckpoint schema drift pin — Durable Runs Phase 1.
 *
 * Same discipline as protocol-drift.test.mjs: the exact field vocabulary
 * is pinned here so the schema can't grow or shrink silently. Extending
 * RunCheckpointV1 means updating this pin in the same PR — that's the
 * point.
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  CREDENTIAL_FIELD_PATTERN,
  RUN_CHECKPOINT_OPTIONAL_FIELDS,
  RUN_CHECKPOINT_REQUIRED_FIELDS,
  RUN_CHECKPOINT_VERSION,
  assertValidRunCheckpoint,
  estimateRunCheckpointBytes,
  isValidRunCheckpoint,
  validateRunCheckpoint,
} from '../../lib/run-checkpoint.ts';

function makeCheckpoint(overrides = {}) {
  return {
    v: RUN_CHECKPOINT_VERSION,
    chatId: 'chat-1',
    repoFullName: 'KvFxKaido/Push',
    branch: 'main',
    round: 3,
    phase: 'executing_tools',
    savedAt: 1781000000000,
    reason: 'turn',
    messages: [
      { role: 'system', content: 'You are Push.' },
      { role: 'user', content: 'Fix the bug in foo.ts' },
      { role: 'assistant', content: 'Reading foo.ts…', isToolCall: true },
      { role: 'user', content: '[tool result] contents…', isToolResult: true },
    ],
    accumulated: '',
    thinkingAccumulated: '',
    userGoal: 'Fix the bug in foo.ts',
    provider: 'zen',
    model: 'glm-5.1',
    approvalMode: 'supervised',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// THE PIN — exact field vocabulary, version, and credential boundary
// ---------------------------------------------------------------------------

test('pin: version and exact required/optional field sets', () => {
  assert.equal(RUN_CHECKPOINT_VERSION, 1);
  assert.deepEqual([...RUN_CHECKPOINT_REQUIRED_FIELDS].sort(), [
    'accumulated',
    'approvalMode',
    'branch',
    'chatId',
    'messages',
    'model',
    'phase',
    'provider',
    'reason',
    'repoFullName',
    'round',
    'savedAt',
    'thinkingAccumulated',
    'userGoal',
    'v',
  ]);
  assert.deepEqual([...RUN_CHECKPOINT_OPTIONAL_FIELDS].sort(), [
    'delegation',
    'lastEventSeq',
    'pendingApproval',
    'providerOptions',
    'runId',
    'sandboxSessionId',
    'savedDiff',
    'userAborted',
    'verificationPolicy',
    'workingMemory',
    'workspaceSessionId',
  ]);
});

test('pin: credential-shaped field names are rejected outright', () => {
  for (const field of [
    'ownerToken',
    'owner_token',
    'apiKey',
    'api_key',
    'githubToken',
    'sessionBearer',
    'clientSecret',
    'password',
    'credentials',
  ]) {
    assert.ok(CREDENTIAL_FIELD_PATTERN.test(field), `pattern must match "${field}"`);
    const issues = validateRunCheckpoint(makeCheckpoint({ [field]: 'sk-leaked' }));
    assert.ok(
      issues.some((i) => i.path === field && i.message.includes('credential-shaped')),
      `checkpoint with "${field}" must fail validation`,
    );
  }
  // Non-credential names must not false-positive.
  for (const benign of ['sandboxSessionId', 'lastEventSeq', 'workingMemory', 'userGoal']) {
    assert.ok(!CREDENTIAL_FIELD_PATTERN.test(benign), `pattern must not match "${benign}"`);
  }
});

// ---------------------------------------------------------------------------
// Validator behavior
// ---------------------------------------------------------------------------

test('a complete checkpoint validates clean', () => {
  const cp = makeCheckpoint({
    workspaceSessionId: 'ws-1',
    runId: 'run-1',
    userAborted: false,
    providerOptions: { zenGo: true },
    pendingApproval: { approvalId: 'a-1', kind: 'commit', title: 'commit gate' },
    workingMemory: { plan: 'fix foo', openTasks: ['edit foo.ts'] },
    delegation: { active: false, lastCoderState: null },
    sandboxSessionId: 'sb-1',
    savedDiff: 'diff --git a/foo b/foo',
    lastEventSeq: 41,
  });
  assert.deepEqual(validateRunCheckpoint(cp), []);
  assert.ok(isValidRunCheckpoint(cp));
  assert.doesNotThrow(() => assertValidRunCheckpoint(cp));
  assert.ok(estimateRunCheckpointBytes(cp) > 100);
});

test('every missing required field produces an issue', () => {
  for (const field of RUN_CHECKPOINT_REQUIRED_FIELDS) {
    const cp = makeCheckpoint();
    delete cp[field];
    const issues = validateRunCheckpoint(cp);
    assert.ok(
      issues.some((i) => i.path === field || i.path.startsWith(field)),
      `missing "${field}" must produce an issue (got: ${JSON.stringify(issues)})`,
    );
  }
});

test('enum fields reject unknown values', () => {
  assert.ok(validateRunCheckpoint(makeCheckpoint({ phase: 'dreaming' })).length > 0);
  assert.ok(validateRunCheckpoint(makeCheckpoint({ reason: 'because' })).length > 0);
  assert.ok(validateRunCheckpoint(makeCheckpoint({ approvalMode: 'yolo' })).length > 0);
  assert.ok(validateRunCheckpoint(makeCheckpoint({ v: 2 })).length > 0);
});

test('messages are structurally validated', () => {
  const badRole = makeCheckpoint({ messages: [{ role: 'narrator', content: 'hm' }] });
  assert.ok(validateRunCheckpoint(badRole).some((i) => i.path === 'messages[0].role'));
  const badContent = makeCheckpoint({ messages: [{ role: 'user', content: 42 }] });
  assert.ok(validateRunCheckpoint(badContent).some((i) => i.path === 'messages[0].content'));
  const badReasoning = makeCheckpoint({
    messages: [{ role: 'assistant', content: 'x', reasoningBlocks: 'sig' }],
  });
  assert.ok(
    validateRunCheckpoint(badReasoning).some((i) => i.path === 'messages[0].reasoningBlocks'),
  );
});

test('benign unknown extras pass (additive evolution stays cheap)', () => {
  const cp = makeCheckpoint({ futureField: { anything: true } });
  assert.deepEqual(validateRunCheckpoint(cp), []);
});

test('assertValidRunCheckpoint throws with joined issue detail', () => {
  assert.throws(
    () => assertValidRunCheckpoint(makeCheckpoint({ phase: 'dreaming', provider: '' })),
    /Invalid RunCheckpoint: .*phase.*provider|Invalid RunCheckpoint: .*provider.*phase/s,
  );
});
