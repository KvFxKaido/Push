import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { launchTui } from '../cli.ts';

const nodeMajor = Number(process.versions.node.split('.')[0]);
const silverySkip =
  nodeMajor < 24 ? `silvery 0.21 requires Node >=24 (current: ${process.version})` : false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class FakeStdout extends EventEmitter {
  constructor(columns = 72, rows = 16) {
    super();
    this.isTTY = true;
    this.columns = columns;
    this.rows = rows;
    this.bytes = '';
  }

  write(chunk) {
    this.bytes += String(chunk);
    return true;
  }

  get writableHighWaterMark() {
    return 16_384;
  }
}

class FakeStdin extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
  }

  setRawMode() {
    return this;
  }

  resume() {
    return this;
  }

  pause() {
    return this;
  }

  setEncoding() {
    return this;
  }

  ref() {
    return this;
  }

  unref() {
    return this;
  }

  read() {
    return null;
  }
}

describe('silvery TUI launch routing', () => {
  const options = {
    sessionId: 'session-1',
    provider: 'anthropic',
    model: 'claude-sonnet',
    cwd: '/repo',
    maxRounds: 12,
    explicitMaxRounds: true,
  };

  it('routes true/1 to silvery with the shared options and symmetric log', async () => {
    for (const silveryFlag of ['true', '1']) {
      const calls = [];
      const logs = [];
      const result = await launchTui(options, {
        silveryFlag,
        nodeMajor: 24,
        log: (line) => logs.push(JSON.parse(line)),
        loadSilvery: async () => ({
          runTuiSilvery: async (received) => {
            calls.push(['silvery', received]);
            return 17;
          },
        }),
        loadAnsi: async () => ({
          runTUI: async (received) => {
            calls.push(['ansi', received]);
            return 18;
          },
        }),
      });

      assert.equal(result, 17);
      assert.deepEqual(calls, [['silvery', options]]);
      assert.deepEqual(logs, [{ level: 'info', event: 'tui_launch_silvery' }]);
    }
  });

  it('keeps ANSI as the default and does not load silvery', async () => {
    for (const silveryFlag of ['', '0', 'false', 'TRUE']) {
      const calls = [];
      const logs = [];
      const result = await launchTui(options, {
        silveryFlag,
        log: (line) => logs.push(JSON.parse(line)),
        loadSilvery: async () => {
          calls.push(['silvery']);
          return { runTuiSilvery: async () => 17 };
        },
        loadAnsi: async () => ({
          runTUI: async (received) => {
            calls.push(['ansi', received]);
            return 18;
          },
        }),
      });

      assert.equal(result, 18);
      assert.deepEqual(calls, [['ansi', options]]);
      assert.deepEqual(logs, [{ level: 'info', event: 'tui_launch_ansi' }]);
    }
  });

  it('fails before importing silvery below Node 24', async () => {
    let loaded = false;
    await assert.rejects(
      launchTui(options, {
        silveryFlag: '1',
        nodeMajor: 22,
        loadSilvery: async () => {
          loaded = true;
          return { runTuiSilvery: async () => 0 };
        },
      }),
      /requires Node >=24/,
    );
    assert.equal(loaded, false);
  });

  it('keeps silvery external in every single-binary compile command', async () => {
    const workflow = await readFile(
      path.resolve(import.meta.dirname, '..', '..', '.github', 'workflows', 'ci.yml'),
      'utf8',
    );
    const compileLines = workflow
      .split('\n')
      .filter((line) => line.includes('bun build --compile') && line.includes('cli/cli.ts'));

    assert.equal(compileLines.length, 4, 'expected host compile plus three cross-compiles');
    for (const line of compileLines) assert.match(line, /--external silvery/);
  });
});

describe('silvery Phase 0 fault shell', () => {
  it('renders an inline failure while the shell stays alive, then settles on unmount', {
    skip: silverySkip,
  }, async () => {
    const React = (await import('react')).default;
    const Silvery = await import('silvery');
    const { HelloPush } = await import('../silvery/hello.tsx');
    const { PushShell } = await import('../silvery/push-shell.tsx');
    let caught;

    class Bomb extends React.Component {
      render() {
        throw new Error('deliberate Phase 0 render fault');
      }
    }

    const stdout = new FakeStdout();
    const stdin = new FakeStdin();
    const tree = React.createElement(
      PushShell,
      { onRecoverableError: (error) => (caught = error) },
      React.createElement(
        Silvery.Box,
        { flexDirection: 'column' },
        React.createElement(HelloPush),
        React.createElement(Bomb),
      ),
    );
    const handle = Silvery.render(
      tree,
      { stdout, stdin },
      {
        exitOnCtrlC: false,
        alternateScreen: false,
        mode: 'fullscreen',
        mouse: false,
      },
    );
    const lifecycle = handle.run();
    const instance = await handle;

    await sleep(120);
    assert.equal(caught?.message, 'deliberate Phase 0 render fault');
    assert.match(stdout.bytes, /This screen failed to render/);
    assert.match(stdout.bytes, /Push is still running/);

    instance.unmount();
    await Promise.race([
      lifecycle,
      sleep(1_000).then(() => {
        throw new Error('silvery render lifecycle did not settle after unmount');
      }),
    ]);
  });

  it('restores terminal modes once, surfaces the async fault, and removes its listeners', {
    skip: silverySkip,
  }, async () => {
    const { installProcessWatchdog, TERMINAL_RESTORE_SEQUENCE } = await import(
      '../silvery/push-shell.tsx'
    );
    const events = new EventEmitter();
    let stdout = '';
    let stderr = '';
    let unmounts = 0;
    const exitCodes = [];
    const watchdog = installProcessWatchdog({
      events,
      getInstance: () => ({ unmount: () => unmounts++ }),
      stdout: { write: (chunk) => ((stdout += String(chunk)), true) },
      stderr: { write: (chunk) => ((stderr += String(chunk)), true) },
      exit: (code) => exitCodes.push(code),
    });

    events.emit('unhandledRejection', new Error('timer exploded'));
    events.emit('uncaughtException', new Error('second fault'));

    assert.equal(unmounts, 1);
    assert.equal(stdout, TERMINAL_RESTORE_SEQUENCE);
    assert.match(stderr, /\[push silvery watchdog\] unhandledRejection: Error: timer exploded/);
    assert.deepEqual(exitCodes, [1]);
    assert.equal(watchdog.restorer.restored, true);

    watchdog.dispose();
    assert.equal(events.listenerCount('unhandledRejection'), 0);
    assert.equal(events.listenerCount('uncaughtException'), 0);
  });

  it('recover() cleans up without exiting so the caller can return', {
    skip: silverySkip,
  }, async () => {
    const { installProcessWatchdog, TERMINAL_RESTORE_SEQUENCE } = await import(
      '../silvery/push-shell.tsx'
    );
    const events = new EventEmitter();
    let stdout = '';
    let stderr = '';
    let unmounts = 0;
    const exitCodes = [];
    const watchdog = installProcessWatchdog({
      events,
      getInstance: () => ({ unmount: () => unmounts++ }),
      stdout: { write: (chunk) => ((stdout += String(chunk)), true) },
      stderr: { write: (chunk) => ((stderr += String(chunk)), true) },
      exit: (code) => exitCodes.push(code),
    });

    // Synchronous recover: clean up + surface, but do NOT exit — so main()'s
    // finally (worktree teardown) runs instead of being skipped by process.exit.
    watchdog.recover('renderer', new Error('render rejected'));

    assert.equal(unmounts, 1);
    assert.equal(stdout, TERMINAL_RESTORE_SEQUENCE);
    assert.match(stderr, /\[push silvery watchdog\] renderer: Error: render rejected/);
    assert.deepEqual(exitCodes, [], 'recover must not exit');

    // A later async fault after recover must also not exit (idempotent), so a
    // clean `return 1` is never turned into a hard exit.
    events.emit('uncaughtException', new Error('late fault'));
    assert.deepEqual(exitCodes, [], 'no exit after recover already handled');
    assert.equal(unmounts, 1);

    watchdog.dispose();
  });
});
