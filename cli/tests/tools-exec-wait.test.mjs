import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  executeToolCall as _rawExecuteToolCall,
  READ_ONLY_TOOLS,
  REPEAT_EXEMPT_TOOLS,
  waitForSessionExit,
} from '../tools.ts';

// Match the exec-session harness convention (default role 'coder' so the
// kernel role check admits direct-executor unit tests).
const exec = (call, root, opts = {}) =>
  _rawExecuteToolCall(call, root, { role: 'coder', allowExec: true, ...opts });

const tmpRoot = () => fs.mkdtemp(path.join(os.tmpdir(), 'push-exec-wait-'));

describe('exec_wait: blocking wait collapses the exec_poll storm', () => {
  it('is classified read-only and repeat-exempt (sibling of exec_poll)', () => {
    assert.equal(READ_ONLY_TOOLS.has('exec_wait'), true);
    assert.equal(REPEAT_EXEMPT_TOOLS.has('exec_wait'), true);
  });

  it('blocks until the command exits and returns full output in ONE call', async () => {
    const root = await tmpRoot();
    let sessionId;
    try {
      const start = await exec(
        {
          tool: 'exec_start',
          args: { command: 'printf "line-1\\n"; sleep 1; printf "line-2\\n"' },
        },
        root,
      );
      assert.equal(start.ok, true);
      sessionId = start.meta?.session_id;
      assert.ok(sessionId, 'exec_start returns a session id');

      const t0 = Date.now();
      const wait = await exec({ tool: 'exec_wait', args: { session_id: sessionId } }, root);
      const elapsed = Date.now() - t0;

      assert.equal(wait.ok, true);
      assert.equal(wait.meta.running, false, 'the command has exited');
      assert.equal(wait.meta.waited, 'exited');
      assert.equal(wait.meta.exit_code, 0);
      assert.ok(
        wait.text.includes('line-1') && wait.text.includes('line-2'),
        'the full command output comes back in the single wait result',
      );
      // Event-driven early return: a ~1s command returns in ~1s, NOT after the
      // 120s default wait budget — the whole point of the tool.
      assert.ok(
        elapsed < 15_000,
        `exec_wait returned in ${elapsed}ms — should track command duration, not the wait budget`,
      );
    } finally {
      if (sessionId)
        await exec({ tool: 'exec_stop', args: { session_id: sessionId } }, root).catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reports waited=running when the budget elapses before exit (resumable by re-calling)', async () => {
    const root = await tmpRoot();
    let sessionId;
    try {
      const start = await exec(
        { tool: 'exec_start', args: { command: 'sleep 10; echo done' } },
        root,
      );
      sessionId = start.meta?.session_id;
      assert.ok(sessionId);

      const wait = await exec(
        { tool: 'exec_wait', args: { session_id: sessionId, timeout_ms: 1_000 } },
        root,
      );
      assert.equal(wait.meta.running, true, 'still running after the short wait budget');
      assert.equal(wait.meta.waited, 'running');
      assert.ok(
        wait.text.includes('still running'),
        'the result tells the model it can wait again or stop',
      );
    } finally {
      if (sessionId)
        await exec({ tool: 'exec_stop', args: { session_id: sessionId } }, root).catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('aborts the wait via options.signal without killing the command', async () => {
    const root = await tmpRoot();
    let sessionId;
    try {
      const start = await exec(
        { tool: 'exec_start', args: { command: 'sleep 10; echo done' } },
        root,
      );
      sessionId = start.meta?.session_id;
      assert.ok(sessionId);

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);
      const t0 = Date.now();
      const wait = await exec(
        { tool: 'exec_wait', args: { session_id: sessionId, timeout_ms: 60_000 } },
        root,
        { signal: controller.signal },
      );
      const elapsed = Date.now() - t0;

      assert.equal(wait.meta.waited, 'aborted');
      assert.equal(wait.meta.running, true, 'abort stops the wait but leaves the command running');
      assert.ok(elapsed < 5_000, `abort should return promptly (took ${elapsed}ms)`);
    } finally {
      if (sessionId)
        await exec({ tool: 'exec_stop', args: { session_id: sessionId } }, root).catch(() => {});
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('returns NOT_FOUND for an unknown session id', async () => {
    const root = await tmpRoot();
    try {
      const wait = await exec({ tool: 'exec_wait', args: { session_id: 'exec_bogus_9' } }, root);
      assert.equal(wait.ok, false);
      assert.equal(wait.structuredError?.code, 'NOT_FOUND');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

// Regression for the reviewer finding (push-agent WARNING + Codex P2): the
// slice loop called waitForSessionExit once per slice, and the old helper left
// its timed-out waiter in session.exitWaiters — so a long/oft-resumed wait
// leaked hundreds/thousands of dead closures. These pin the self-cleaning +
// abort-aware behavior directly, using a fake session (EXEC_SESSIONS is private).
describe('waitForSessionExit: self-cleaning + abort-aware', () => {
  it('removes its waiter on the timeout path — no accumulation across slices', async () => {
    const fake = { running: true, exitWaiters: [] };
    for (let i = 0; i < 5; i++) {
      await waitForSessionExit(fake, 10);
      assert.equal(fake.exitWaiters.length, 0, `no stale waiter after slice ${i + 1}`);
    }
  });

  it('resolves promptly on abort and cleans up its waiter', async () => {
    const fake = { running: true, exitWaiters: [] };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const t0 = Date.now();
    await waitForSessionExit(fake, 5_000, controller.signal);
    assert.ok(Date.now() - t0 < 1_000, 'abort resolves promptly, not at the 5s timeout');
    assert.equal(fake.exitWaiters.length, 0, 'waiter removed on abort');
  });

  it('resolves when the session exits and leaves no waiter behind', async () => {
    const fake = { running: true, exitWaiters: [] };
    const pending = waitForSessionExit(fake, 5_000);
    assert.equal(fake.exitWaiters.length, 1, 'waiter registered while blocking');
    // simulate notifySessionExit: splice all, invoke each
    for (const w of fake.exitWaiters.splice(0)) w();
    await pending;
    assert.equal(fake.exitWaiters.length, 0, 'no waiter left after exit');
  });

  it('returns immediately for an already-aborted signal (registers no waiter)', async () => {
    const fake = { running: true, exitWaiters: [] };
    const controller = new AbortController();
    controller.abort();
    await waitForSessionExit(fake, 5_000, controller.signal);
    assert.equal(fake.exitWaiters.length, 0, 'no waiter registered for a pre-aborted signal');
  });
});
