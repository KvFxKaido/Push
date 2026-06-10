/**
 * Run-adoption loop vocabulary drift pin + unit tests — Durable Runs
 * (Adopt-on-Silence) Phase 2 loop.
 *
 * Pins the deferred-tool-source set, the note markers, and the checkpoint↔
 * kernel-state mapping the RunHost adoption runner relies on. The loop's
 * "do not silently drop" guarantee for chat-hook tools lives in this
 * vocabulary — extending it means updating this pin in the same PR (same
 * discipline as run-host-adoption.test.mjs).
 */

import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  ADOPTION_DEFERRED_NOTE_MARKER,
  ADOPTION_DEFERRED_TOOL_SOURCES,
  ADOPTION_EXTRA_ROUNDS,
  ADOPTION_PAUSE_NOTE_MARKER,
  ADOPTION_RESUME_NOTE_MARKER,
  buildAdoptionDeferralNote,
  buildAdoptionDetectors,
  buildAdoptionResumeNote,
  coderStateToRunCheckpoint,
  createAdoptionToolGate,
  runCheckpointToCoderResumeState,
} from '../../lib/run-adoption-loop.ts';
import { validateRunCheckpoint } from '../../lib/run-checkpoint.ts';

function makeCheckpoint(overrides = {}) {
  return {
    v: 1,
    chatId: 'chat-1',
    repoFullName: 'KvFxKaido/Push',
    branch: 'feat/x',
    runId: 'run-1',
    round: 4,
    phase: 'executing_tools',
    savedAt: 1781000000000,
    reason: 'turn',
    messages: [
      { role: 'user', content: 'Fix the bug in foo.ts' },
      { role: 'assistant', content: 'Reading foo.ts', isToolCall: true },
      { role: 'user', content: '[Tool Result] ...', isToolResult: true },
    ],
    accumulated: '',
    thinkingAccumulated: '',
    userGoal: 'Fix the bug in foo.ts',
    provider: 'zen',
    model: 'glm-5.1',
    approvalMode: 'supervised',
    sandboxSessionId: 'sb-1',
    workingMemory: { plan: 'fix foo' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// THE PIN — deferred sources, markers, constants
// ---------------------------------------------------------------------------

test('pin: exact deferred tool-source set', () => {
  assert.deepEqual(
    [...ADOPTION_DEFERRED_TOOL_SOURCES],
    ['scratchpad', 'todo', 'delegate', 'ask-user', 'artifacts', 'github'],
  );
});

test('pin: note markers + extra-rounds budget', () => {
  assert.equal(ADOPTION_RESUME_NOTE_MARKER, '[RUN_ADOPTED]');
  assert.equal(ADOPTION_DEFERRED_NOTE_MARKER, '[TOOL_DEFERRED]');
  assert.equal(ADOPTION_PAUSE_NOTE_MARKER, '[RUN_PAUSED_FOR_APPROVAL]');
  assert.equal(ADOPTION_EXTRA_ROUNDS, 30);
});

test('every deferred source produces a marked, non-empty deferral note', () => {
  for (const source of ADOPTION_DEFERRED_TOOL_SOURCES) {
    const note = buildAdoptionDeferralNote(source, `${source}_tool`);
    assert.ok(note.startsWith(ADOPTION_DEFERRED_NOTE_MARKER), `${source} note is marked`);
    assert.ok(note.length > ADOPTION_DEFERRED_NOTE_MARKER.length + 20, `${source} note has body`);
  }
});

// ---------------------------------------------------------------------------
// Checkpoint → resume seed
// ---------------------------------------------------------------------------

test('runCheckpointToCoderResumeState maps the transcript and appends the adoption note', () => {
  const cp = makeCheckpoint();
  const seed = runCheckpointToCoderResumeState(cp);
  assert.equal(seed.round, 4);
  assert.deepEqual(seed.workingMemory, { plan: 'fix foo' });
  assert.deepEqual(seed.cards, []);
  // Transcript verbatim + one trailing user note.
  assert.equal(seed.messages.length, cp.messages.length + 1);
  assert.equal(seed.messages[0].content, 'Fix the bug in foo.ts');
  assert.equal(seed.messages[1].isToolCall, true);
  assert.equal(seed.messages[2].isToolResult, true);
  const note = seed.messages[seed.messages.length - 1];
  assert.equal(note.role, 'user');
  assert.ok(note.content.startsWith(ADOPTION_RESUME_NOTE_MARKER));
  assert.ok(note.content.includes('Fix the bug in foo.ts'), 'carries the user-goal anchor');
});

test('checkpointed `tool` turns become user turns flagged isToolResult', () => {
  const cp = makeCheckpoint({
    messages: [{ role: 'tool', content: '[Tool Result] exit=0' }],
  });
  const seed = runCheckpointToCoderResumeState(cp);
  assert.equal(seed.messages[0].role, 'user');
  assert.equal(seed.messages[0].isToolResult, true);
});

test('resume note states the mode semantics', () => {
  assert.match(buildAdoptionResumeNote(makeCheckpoint()), /SUPERVISED/);
  assert.match(
    buildAdoptionResumeNote(makeCheckpoint({ approvalMode: 'full-auto' })),
    /continues uninterrupted/,
  );
});

// ---------------------------------------------------------------------------
// Kernel state → checkpoint (server-side per-round persistence)
// ---------------------------------------------------------------------------

test('coderStateToRunCheckpoint produces a valid checkpoint that keeps identity + lock', () => {
  const base = makeCheckpoint();
  const cp = coderStateToRunCheckpoint(
    base,
    {
      round: 7,
      messages: [
        { id: 'a', role: 'user', content: 'task', timestamp: 1 },
        { id: 'b', role: 'assistant', content: 'done', timestamp: 2, isToolCall: true },
      ],
      workingMemory: { plan: 'updated plan' },
    },
    { savedAt: 1781000001000 },
  );
  assert.deepEqual(validateRunCheckpoint(cp), []);
  assert.equal(cp.round, 7);
  assert.equal(cp.savedAt, 1781000001000);
  assert.equal(cp.runId, 'run-1');
  assert.equal(cp.provider, 'zen');
  assert.equal(cp.model, 'glm-5.1');
  assert.equal(cp.messages.length, 2);
  assert.equal(cp.messages[1].isToolCall, true);
  assert.deepEqual(cp.workingMemory, { plan: 'updated plan' });
  assert.equal(cp.pendingApproval, null);
});

test('coderStateToRunCheckpoint records a pending approval when paused', () => {
  const cp = coderStateToRunCheckpoint(
    makeCheckpoint(),
    {
      round: 5,
      messages: [{ id: 'a', role: 'user', content: 'x', timestamp: 1 }],
      workingMemory: {},
    },
    {
      savedAt: 1781000001000,
      pendingApproval: { approvalId: 'adopt-sandbox_push-r5', kind: 'remote_side_effect' },
    },
  );
  assert.deepEqual(validateRunCheckpoint(cp), []);
  assert.equal(cp.pendingApproval?.approvalId, 'adopt-sandbox_push-r5');
});

// ---------------------------------------------------------------------------
// The adoption tool gate
// ---------------------------------------------------------------------------

function makeGate({ mode, onPause = () => {}, executed = [] } = {}) {
  return createAdoptionToolGate({
    mode,
    execute: async (call) => {
      executed.push(call.call.tool);
      return { kind: 'executed', resultText: `ran ${call.call.tool}` };
    },
    hookContext: { sandboxId: 'sb-1', allowedRepo: 'KvFxKaido/Push' },
    onPause,
  });
}

test('gate defers chat-hook tools with a model-readable note (never silent)', async () => {
  const executed = [];
  const gate = makeGate({ mode: 'full-auto', executed });
  const result = await gate(
    { source: 'scratchpad', call: { tool: 'scratchpad_write', args: { content: 'x' } } },
    { round: 5 },
  );
  assert.equal(result.kind, 'executed');
  assert.ok(result.resultText.startsWith(ADOPTION_DEFERRED_NOTE_MARKER));
  assert.deepEqual(executed, []);
});

test('gate executes sandbox tools through the inner executor', async () => {
  const executed = [];
  const gate = makeGate({ mode: 'supervised', executed });
  const result = await gate(
    { source: 'sandbox', call: { tool: 'sandbox_read_file', args: { path: 'foo.ts' } } },
    { round: 5 },
  );
  assert.equal(result.kind, 'executed');
  assert.equal(result.resultText, 'ran sandbox_read_file');
  assert.deepEqual(executed, ['sandbox_read_file']);
});

test('supervised: a remote side effect pauses the run instead of acting', async () => {
  const executed = [];
  const pauses = [];
  const gate = makeGate({ mode: 'supervised', executed, onPause: (p) => pauses.push(p) });
  const result = await gate(
    { source: 'sandbox', call: { tool: 'sandbox_push', args: {} } },
    { round: 5 },
  );
  assert.deepEqual(executed, [], 'the gated tool never executed');
  assert.equal(pauses.length, 1);
  assert.equal(pauses[0].kind, 'remote_side_effect');
  assert.equal(pauses[0].approvalId, 'adopt-sandbox_push-r5');
  assert.equal(result.kind, 'executed');
  assert.ok(result.resultText.startsWith(ADOPTION_PAUSE_NOTE_MARKER));
  assert.equal(result.policyPost?.kind, 'halt');
});

test('supervised: a destructive sandbox_exec pauses; a benign one executes', async () => {
  const executed = [];
  const pauses = [];
  const gate = makeGate({ mode: 'supervised', executed, onPause: (p) => pauses.push(p) });

  const destructive = await gate(
    { source: 'sandbox', call: { tool: 'sandbox_exec', args: { command: 'git reset --hard' } } },
    { round: 6 },
  );
  assert.ok(destructive.resultText.startsWith(ADOPTION_PAUSE_NOTE_MARKER));
  assert.equal(pauses.length, 1);

  const benign = await gate(
    { source: 'sandbox', call: { tool: 'sandbox_exec', args: { command: 'npm test' } } },
    { round: 7 },
  );
  assert.equal(benign.resultText, 'ran sandbox_exec');
  assert.deepEqual(executed, ['sandbox_exec']);
});

test('supervised: ask_user pauses; full-auto: ask_user defers with a note', async () => {
  const pauses = [];
  const supervised = makeGate({ mode: 'supervised', onPause: (p) => pauses.push(p) });
  const paused = await supervised(
    { source: 'ask-user', call: { tool: 'ask_user', args: { question: '?' } } },
    { round: 3 },
  );
  assert.ok(paused.resultText.startsWith(ADOPTION_PAUSE_NOTE_MARKER));
  assert.equal(pauses[0].kind, 'ask_user');

  const fullAuto = makeGate({ mode: 'full-auto' });
  const deferred = await fullAuto(
    { source: 'ask-user', call: { tool: 'ask_user', args: { question: '?' } } },
    { round: 3 },
  );
  assert.ok(deferred.resultText.startsWith(ADOPTION_DEFERRED_NOTE_MARKER));
  assert.ok(/best judgment/.test(deferred.resultText));
});

test('full-auto: remote side effects execute uninterrupted (AFK is its meaning)', async () => {
  const executed = [];
  const pauses = [];
  const gate = makeGate({ mode: 'full-auto', executed, onPause: (p) => pauses.push(p) });
  const result = await gate(
    { source: 'sandbox', call: { tool: 'sandbox_push', args: {} } },
    { round: 5 },
  );
  assert.equal(result.resultText, 'ran sandbox_push');
  assert.deepEqual(pauses, []);
});

test('onPause fires once even if the model retries gated calls', async () => {
  const pauses = [];
  const gate = makeGate({ mode: 'supervised', onPause: (p) => pauses.push(p) });
  await gate({ source: 'sandbox', call: { tool: 'sandbox_push', args: {} } }, { round: 5 });
  await gate({ source: 'sandbox', call: { tool: 'sandbox_push', args: {} } }, { round: 6 });
  assert.equal(pauses.length, 1);
});

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

test('adoption detectors keep non-sandbox sources in the batch (no silent filtering)', () => {
  const scratchpadCall = { source: 'scratchpad', call: { tool: 'scratchpad_write', args: {} } };
  const raw = {
    detectAllToolCalls: () => ({
      readOnly: [scratchpadCall],
      fileMutations: [],
      mutating: { source: 'github', call: { tool: 'pr_create', args: {} } },
      extraMutations: [],
      droppedCandidates: [
        { rawToolName: 'coder_update_state', resolvedToolName: null },
        { rawToolName: 'totally_unknown', resolvedToolName: null },
      ],
    }),
    detectAnyToolCall: () => scratchpadCall,
  };
  const detectors = buildAdoptionDetectors(raw);
  const detected = detectors.detectAllToolCalls('...');
  // Deferred-family calls survive detection so the gate can answer them.
  assert.deepEqual(detected.readOnly, [scratchpadCall]);
  assert.equal(detected.mutating?.call.tool, 'pr_create');
  // Coder-internal pseudo-tools are filtered from droppedCandidates (the
  // kernel handles them inline); genuinely unknown names stay surfaced.
  assert.deepEqual(
    detected.droppedCandidates.map((c) => c.rawToolName),
    ['totally_unknown'],
  );
  assert.equal(detectors.detectAnyToolCall('...'), scratchpadCall);
});
