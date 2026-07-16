import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createDelegationExecutionAdapters } from '../pushd/delegation-execution.ts';
import { createSessionRuntime } from '../pushd/session-runtime.ts';
import { createSessionState, loadSessionEvents } from '../session-store.ts';

test('role-agent run events are persisted with the captured seq before broadcast', async () => {
  const originalSessionDir = process.env.PUSH_SESSION_DIR;
  const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pushd-delegation-execution-'));
  process.env.PUSH_SESSION_DIR = sessionDir;

  try {
    const runtime = createSessionRuntime({ isRelayRunning: () => false });
    const state = createSessionState({
      provider: 'ollama',
      model: 'test-model',
      cwd: sessionDir,
      messages: [],
    });
    const entry = { state, attachToken: state.attachToken };
    runtime.set(state.sessionId, entry);

    const observed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for run event')), 2_000);
      runtime.addClient(state.sessionId, (event) => {
        void loadSessionEvents(state.sessionId).then((events) => {
          clearTimeout(timer);
          resolve({ event, events });
        }, reject);
      });
    });

    const { emitRoleAgentRunEvent } = createDelegationExecutionAdapters(runtime);
    emitRoleAgentRunEvent(
      state.sessionId,
      entry,
      'run_test',
    )({
      type: 'assistant.turn_start',
      round: 1,
    });

    const { event, events } = await observed;
    assert.equal(event.type, 'assistant.turn_start');
    assert.equal(event.runId, 'run_test');
    assert.equal(event.seq, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].type, event.type);
    assert.equal(events[0].runId, event.runId);
    assert.equal(events[0].seq, event.seq);
  } finally {
    if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
    else process.env.PUSH_SESSION_DIR = originalSessionDir;
    await fs.rm(sessionDir, { recursive: true, force: true });
  }
});

test('a failed run-event append broadcasts only the structured warning', async () => {
  const originalSessionDir = process.env.PUSH_SESSION_DIR;
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pushd-delegation-failure-'));
  const invalidSessionRoot = path.join(tempRoot, 'not-a-directory');
  await fs.writeFile(invalidSessionRoot, 'occupied');
  process.env.PUSH_SESSION_DIR = invalidSessionRoot;

  try {
    const runtime = createSessionRuntime({ isRelayRunning: () => false });
    const state = createSessionState({
      provider: 'ollama',
      model: 'test-model',
      cwd: tempRoot,
      messages: [],
    });
    const entry = { state, attachToken: state.attachToken };
    runtime.set(state.sessionId, entry);

    const observed = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for warning')), 2_000);
      runtime.addClient(state.sessionId, (event) => {
        clearTimeout(timer);
        resolve(event);
      });
    });

    const { emitRoleAgentRunEvent } = createDelegationExecutionAdapters(runtime);
    emitRoleAgentRunEvent(
      state.sessionId,
      entry,
      null,
    )({
      type: 'assistant.turn_start',
      round: 1,
    });

    const event = await observed;
    assert.equal(event.type, 'warning');
    assert.equal(event.runId, undefined);
    assert.equal(event.seq, 1);
    assert.equal(event.payload.code, 'PROMPT_SNAPSHOT_PERSIST_FAILED');
    assert.match(event.payload.message, /Failed to persist assistant\.turn_start/);
  } finally {
    if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
    else process.env.PUSH_SESSION_DIR = originalSessionDir;
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
