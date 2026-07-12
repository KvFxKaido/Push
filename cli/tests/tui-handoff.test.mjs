/**
 * Terminal handoff/reclaim (issue #1423 / #1424).
 *
 * Unit-tests `createTerminalHandoff` against a fake `TuiIo`: the
 * suspend→child→resume sequencing contract, reentrancy rejection, and the
 * spawn-failure path (terminal must be reclaimed even when the child never
 * ran). Silvery wires the same primitive via controller `/editor` + Instance
 * pause/resume (see silvery-tui-p0 / controller deps.runHandoffChild).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createTerminalHandoff, resolveEditorCommand } from '../tui-handoff.ts';

function createFakeIo({ isTTY = true, stderrIsTTY = false } = {}) {
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
      stderr: { isTTY: stderrIsTTY, write: (chunk) => stderrChunks.push(String(chunk)) },
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

  it('suppresses structured logs when stderr is the live terminal', async () => {
    // fugu review on #1424: in a real session stderr IS the terminal — a JSON
    // line would flash on the user's screen mid-handoff and print over the
    // repainted alt screen on resume. Logs are for redirected sinks only.
    const fake = createFakeIo({ stderrIsTTY: true });
    const handoff = createHandoff(fake);
    await handoff.run({ command: 'vi', args: [] });
    assert.deepEqual(fake.stderrChunks, []);
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

  it('keeps a quoted executable path with spaces as one token', () => {
    assert.deepEqual(
      resolveEditorCommand({ EDITOR: '"C:\\Program Files\\Editor\\ed.exe" --wait' }, 'win32'),
      { command: 'C:\\Program Files\\Editor\\ed.exe', args: ['--wait'] },
    );
    assert.deepEqual(
      resolveEditorCommand(
        { EDITOR: "'/Applications/Visual Studio Code.app/bin/code' -w" },
        'darwin',
      ),
      { command: '/Applications/Visual Studio Code.app/bin/code', args: ['-w'] },
    );
  });

  it('falls back per platform when nothing is set', () => {
    assert.deepEqual(resolveEditorCommand({}, 'win32'), { command: 'notepad', args: [] });
    assert.deepEqual(resolveEditorCommand({}, 'linux'), { command: 'vi', args: [] });
  });
});
