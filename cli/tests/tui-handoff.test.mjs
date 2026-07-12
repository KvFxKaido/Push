/**
 * Terminal handoff/reclaim (issue #1423).
 *
 * Part A unit-tests `createTerminalHandoff` against a fake `TuiIo`: the
 * suspend→child→resume sequencing contract, reentrancy rejection, and the
 * spawn-failure path (terminal must be reclaimed even when the child never
 * ran). Part B drives the real `/editor` flow headlessly through the
 * tui-driver harness with an injected fake child — including a daemon event
 * emitted mid-suspension that must be visible after resume (acceptance #3/#4).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTerminalHandoff, resolveEditorCommand } from '../tui-handoff.ts';
import { startHeadlessTui } from './tui-driver.mjs';

function createFakeIo({ isTTY = true } = {}) {
  const calls = [];
  const stderrChunks = [];
  const stdin = new EventEmitter();
  stdin.isTTY = isTTY;
  stdin.setRawMode = (mode) => calls.push(`rawMode:${mode}`);
  stdin.pause = () => calls.push('stdin:pause');
  stdin.resume = () => calls.push('stdin:resume');
  stdin.setEncoding = () => {};
  return {
    io: {
      stdin,
      stdout: {
        write: (chunk) => calls.push(`stdout:${chunk}`),
        on: () => {},
        removeListener: () => {},
      },
      stderr: { write: (chunk) => stderrChunks.push(String(chunk)) },
      exit: () => {},
      addSignalHandler: (sig) => calls.push(`signal:add:${sig}`),
      removeSignalHandler: (sig) => calls.push(`signal:remove:${sig}`),
    },
    calls,
    stderrChunks,
    logEvents: () =>
      stderrChunks
        .join('')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line).event),
  };
}

function createHandoff(fake, { runChild, onSuspend, onResume } = {}) {
  return createTerminalHandoff({
    io: fake.io,
    suspendSequence: () => '<SUSPEND>',
    resumeSequence: () => '<RESUME>',
    onSuspend: () => {
      fake.calls.push('onSuspend');
      onSuspend?.();
    },
    onResume: () => {
      fake.calls.push('onResume');
      onResume?.();
    },
    runChild:
      runChild ??
      (async () => {
        fake.calls.push('child:run');
        return { exitCode: 0, signal: null };
      }),
  });
}

describe('createTerminalHandoff', () => {
  it('sequences suspend → child → resume in the contract order', async () => {
    const fake = createFakeIo();
    const handoff = createHandoff(fake);

    const result = await handoff.run({ command: 'vi', args: ['x'] });

    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(fake.calls, [
      'onSuspend',
      'rawMode:false',
      'stdin:pause',
      'stdout:<SUSPEND>',
      'signal:add:SIGINT',
      'child:run',
      'signal:remove:SIGINT',
      'stdout:<RESUME>',
      'rawMode:true',
      'stdin:resume',
      'onResume',
    ]);
    assert.deepEqual(fake.logEvents(), [
      'tui_handoff_started',
      'tui_handoff_child_exited',
      'tui_handoff_resumed',
    ]);
  });

  it('never touches raw mode on a non-TTY stdin', async () => {
    const fake = createFakeIo({ isTTY: false });
    const handoff = createHandoff(fake);
    await handoff.run({ command: 'vi', args: [] });
    assert.ok(!fake.calls.some((c) => c.startsWith('rawMode:')));
  });

  it('rejects a reentrant handoff while the terminal is handed off', async () => {
    const fake = createFakeIo();
    let releaseChild;
    const gate = new Promise((resolve) => {
      releaseChild = resolve;
    });
    const handoff = createHandoff(fake, {
      runChild: async () => {
        await gate;
        return { exitCode: 0, signal: null };
      },
    });

    const first = handoff.run({ command: 'vi', args: [] });
    assert.equal(handoff.isActive(), true);
    const second = await handoff.run({ command: 'less', args: [] });
    assert.equal(second.ok, false);
    assert.match(second.error, /already active/);
    assert.ok(fake.logEvents().includes('tui_handoff_rejected_reentrant'));

    releaseChild();
    const firstResult = await first;
    assert.equal(firstResult.ok, true);
    assert.equal(handoff.isActive(), false);
  });

  it('reclaims the terminal when the child fails to spawn', async () => {
    const fake = createFakeIo();
    const handoff = createHandoff(fake, {
      runChild: async () => {
        throw new Error('ENOENT: no such editor');
      },
    });

    const result = await handoff.run({ command: 'missing-editor', args: [] });

    assert.equal(result.ok, false);
    assert.match(result.error, /ENOENT/);
    // The resume half of the sequence must still run in full.
    const resumeIdx = fake.calls.indexOf('stdout:<RESUME>');
    assert.ok(resumeIdx !== -1);
    assert.deepEqual(fake.calls.slice(resumeIdx), [
      'stdout:<RESUME>',
      'rawMode:true',
      'stdin:resume',
      'onResume',
    ]);
    assert.deepEqual(fake.logEvents(), [
      'tui_handoff_started',
      'tui_handoff_spawn_failed',
      'tui_handoff_resumed',
    ]);
  });
});

describe('resolveEditorCommand', () => {
  it('prefers PUSH_EDITOR over VISUAL over EDITOR', () => {
    assert.deepEqual(
      resolveEditorCommand({ PUSH_EDITOR: 'micro', VISUAL: 'vim', EDITOR: 'nano' }, 'linux'),
      { command: 'micro', args: [] },
    );
    assert.deepEqual(resolveEditorCommand({ VISUAL: 'vim', EDITOR: 'nano' }, 'linux'), {
      command: 'vim',
      args: [],
    });
    assert.deepEqual(resolveEditorCommand({ EDITOR: 'nano' }, 'linux'), {
      command: 'nano',
      args: [],
    });
  });

  it('splits editor values that carry arguments', () => {
    assert.deepEqual(resolveEditorCommand({ EDITOR: 'code --wait' }, 'linux'), {
      command: 'code',
      args: ['--wait'],
    });
  });

  it('falls back per platform when nothing is set', () => {
    assert.deepEqual(resolveEditorCommand({}, 'win32'), { command: 'notepad', args: [] });
    assert.deepEqual(resolveEditorCommand({}, 'linux'), { command: 'vi', args: [] });
  });
});

describe('/editor headless flow (tui-driver + fake child)', () => {
  it('captures edited content and shows a mid-suspension daemon event after resume', async () => {
    const { writeFile } = await import('node:fs/promises');
    process.env.EDITOR = 'fake-editor --flag';

    let releaseChild;
    const childGate = new Promise((resolve) => {
      releaseChild = resolve;
    });
    let childSpec = null;
    const runHandoffChild = async (spec) => {
      childSpec = spec;
      // Simulate the user editing + saving in $EDITOR (trailing newline
      // included, as editors conventionally append one on save).
      await writeFile(spec.args.at(-1), 'edited prompt from $EDITOR\n', 'utf8');
      await childGate;
      return { exitCode: 0, signal: null };
    };

    const h = await startHeadlessTui({ deps: { runHandoffChild } });
    try {
      await h.type('/editor');
      h.io.stdin.emit('data', Buffer.from('\r'));
      await h.waitFor(() => childSpec !== null);

      // Suspended: the terminal left the alt screen...
      assert.ok(h.stdoutChunks.join('').includes('\x1b[?1049l'));
      assert.equal(childSpec.command, 'fake-editor');
      assert.deepEqual(childSpec.args.slice(0, 1), ['--flag']);
      assert.match(childSpec.args.at(-1), /push-editor-.*\.md$/);

      // ...and a daemon event arriving mid-suspension lands in state (not on
      // the child's screen) — the frame count must not grow while suspended.
      const framesWhileSuspended = h.stdoutChunks.length;
      h.emitDaemonEvent({
        v: 1,
        kind: 'event',
        sessionId: 'stub-session',
        runId: 'run_from_phone',
        seq: 1,
        ts: Date.now(),
        type: 'user_message',
        payload: { chars: 20, preview: 'sent while suspended' },
      });
      // Let any (incorrect) render attempt drain through the scheduler.
      await new Promise((resolve) => setTimeout(resolve, 60));
      assert.equal(h.stdoutChunks.length, framesWhileSuspended);

      releaseChild();
      // Resume: alt screen re-entered, composer holds the edited content
      // (trailing newline trimmed), and the suspended-era event is visible.
      await h.waitFor(() => h.composer?.getText() === 'edited prompt from $EDITOR');
      assert.equal(h.composer.getText(), 'edited prompt from $EDITOR');
      const afterResume = h.stdoutChunks.slice(framesWhileSuspended).join('');
      assert.ok(afterResume.includes('\x1b[?1049h'));
      assert.ok(
        (h.tuiState?.transcript ?? []).some(
          (e) => typeof e.text === 'string' && e.text.includes('sent while suspended'),
        ),
      );
    } finally {
      // Ctrl+D (stop) only exits on an empty composer; drop the edited text
      // so teardown actually tears down.
      h.composer?.clear();
      await h.stop();
    }
  });

  it('leaves the composer unchanged and warns when the editor exits nonzero', async () => {
    process.env.EDITOR = 'fake-editor';
    const runHandoffChild = async () => ({ exitCode: 1, signal: null });
    const h = await startHeadlessTui({ deps: { runHandoffChild } });
    try {
      await h.typeLine('/editor');
      await h.waitFor(() =>
        (h.tuiState?.transcript ?? []).some(
          (e) => typeof e.text === 'string' && e.text.includes('exited 1'),
        ),
      );
      assert.equal(h.composer.getText(), '');
    } finally {
      await h.stop();
    }
  });
});
