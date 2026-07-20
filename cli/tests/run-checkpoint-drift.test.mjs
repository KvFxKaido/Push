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

test('pin: credential scan is DEEP — nested objects cannot smuggle secrets', () => {
  // Through a sanctioned object field…
  const viaProviderOptions = makeCheckpoint({
    providerOptions: { zenGo: true, apiKey: 'sk-leaked' },
  });
  assert.ok(
    validateRunCheckpoint(viaProviderOptions).some(
      (i) => i.path === 'providerOptions.apiKey' && i.message.includes('credential-shaped'),
    ),
    'providerOptions.apiKey must fail validation',
  );
  // …through working memory…
  const viaWorkingMemory = makeCheckpoint({
    workingMemory: { plan: 'x', observations: [{ note: 'y', githubToken: 'ghp_leaked' }] },
  });
  assert.ok(
    validateRunCheckpoint(viaWorkingMemory).some((i) => i.path.endsWith('githubToken')),
    'nested array-of-objects credential must fail validation',
  );
  // …and through a benign unknown extra.
  const viaExtra = makeCheckpoint({ futureField: { inner: { ownerToken: 'leaked' } } });
  assert.ok(
    validateRunCheckpoint(viaExtra).some((i) => i.path === 'futureField.inner.ownerToken'),
    'unknown-extra nested credential must fail validation',
  );
  // reasoningBlocks subtrees are provider-signed verbatim blobs — exempt.
  const viaReasoning = makeCheckpoint({
    messages: [
      {
        role: 'assistant',
        content: 'x',
        reasoningBlocks: [{ type: 'thinking', text: 'hm', signature: 'sig', token_count: 9 }],
      },
    ],
  });
  assert.deepEqual(validateRunCheckpoint(viaReasoning), []);
  const viaResponsesReasoning = makeCheckpoint({
    messages: [
      {
        role: 'assistant',
        content: 'x',
        responsesReasoningItems: [
          {
            type: 'reasoning',
            encrypted_content: 'opaque',
            summary: [{ credential_hint: 'provider-authored metadata' }],
          },
        ],
      },
    ],
  });
  assert.deepEqual(validateRunCheckpoint(viaResponsesReasoning), []);
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
  const badResponsesReasoning = makeCheckpoint({
    messages: [
      {
        role: 'assistant',
        content: 'x',
        responsesReasoningItems: [{ type: 'reasoning', id: 'missing-encrypted-content' }],
      },
    ],
  });
  assert.ok(
    validateRunCheckpoint(badResponsesReasoning).some(
      (i) => i.path === 'messages[0].responsesReasoningItems[0]',
    ),
  );
  const badToolUses = makeCheckpoint({
    messages: [{ role: 'assistant', content: 'x', toolUses: [{ type: 'tool_use', id: '' }] }],
  });
  assert.ok(
    validateRunCheckpoint(badToolUses).some((i) => i.path === 'messages[0].toolUses[0].id'),
  );
  const badToolResults = makeCheckpoint({
    messages: [
      {
        role: 'user',
        content: 'x',
        toolResults: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 42 }],
      },
    ],
  });
  assert.ok(
    validateRunCheckpoint(badToolResults).some(
      (i) => i.path === 'messages[0].toolResults[0].content',
    ),
  );
});

test('structured tool sidecars pass checkpoint validation', () => {
  const cp = makeCheckpoint({
    messages: [
      {
        role: 'assistant',
        content: '{"tool":"sandbox_read_file","args":{"path":"a.ts"}}',
        isToolCall: true,
        toolUses: [
          {
            type: 'tool_use',
            id: 'toolu_read_1',
            name: 'sandbox_read_file',
            input: { path: 'a.ts' },
          },
        ],
      },
      {
        role: 'user',
        content: '[TOOL_RESULT] contents [/TOOL_RESULT]',
        isToolResult: true,
        toolResults: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_read_1',
            content: 'contents',
          },
        ],
      },
    ],
  });
  assert.deepEqual(validateRunCheckpoint(cp), []);
});

test('multimodal contentParts round-trip: valid parts pass, malformed parts fail', () => {
  const good = makeCheckpoint({
    messages: [
      {
        role: 'user',
        content: 'see attached',
        contentParts: [
          { type: 'text', text: 'see attached' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ],
  });
  assert.deepEqual(validateRunCheckpoint(good), []);

  const badType = makeCheckpoint({
    messages: [{ role: 'user', content: 'x', contentParts: [{ type: 'video', src: 'v' }] }],
  });
  assert.ok(
    validateRunCheckpoint(badType).some((i) => i.path === 'messages[0].contentParts[0].type'),
  );
  const badImage = makeCheckpoint({
    messages: [{ role: 'user', content: 'x', contentParts: [{ type: 'image_url' }] }],
  });
  assert.ok(
    validateRunCheckpoint(badImage).some((i) => i.path === 'messages[0].contentParts[0].image_url'),
  );
  const notArray = makeCheckpoint({
    messages: [{ role: 'user', content: 'x', contentParts: 'nope' }],
  });
  assert.ok(validateRunCheckpoint(notArray).some((i) => i.path === 'messages[0].contentParts'));
});

test('multimodal contentBlocks round-trip: valid blocks pass, malformed blocks fail', () => {
  const good = makeCheckpoint({
    messages: [
      {
        role: 'user',
        content: 'see attached',
        contentBlocks: [
          { type: 'text', text: 'see attached' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'image', source: { type: 'url', url: 'https://example.com/shot.png' } },
        ],
      },
    ],
  });
  assert.deepEqual(validateRunCheckpoint(good), []);

  const badType = makeCheckpoint({
    messages: [{ role: 'user', content: 'x', contentBlocks: [{ type: 'video', src: 'v' }] }],
  });
  assert.ok(
    validateRunCheckpoint(badType).some((i) => i.path === 'messages[0].contentBlocks[0].type'),
  );
  const badImage = makeCheckpoint({
    messages: [{ role: 'user', content: 'x', contentBlocks: [{ type: 'image' }] }],
  });
  assert.ok(
    validateRunCheckpoint(badImage).some((i) => i.path === 'messages[0].contentBlocks[0].source'),
  );
  const notArray = makeCheckpoint({
    messages: [{ role: 'user', content: 'x', contentBlocks: 'nope' }],
  });
  assert.ok(validateRunCheckpoint(notArray).some((i) => i.path === 'messages[0].contentBlocks'));
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
