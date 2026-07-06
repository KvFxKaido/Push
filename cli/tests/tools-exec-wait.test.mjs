import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  executeToolCall as _rawExecuteToolCall,
  READ_ONLY_TOOLS,
  REPEAT_EXEMPT_TOOLS,
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
