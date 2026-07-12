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
    let aborts = 0;
    const exitCodes = [];
    const watchdog = installProcessWatchdog({
      events,
      getInstance: () => ({ unmount: () => unmounts++ }),
      abortActive: () => aborts++,
      stdout: { write: (chunk) => ((stdout += String(chunk)), true) },
      stderr: { write: (chunk) => ((stderr += String(chunk)), true) },
      exit: (code) => exitCodes.push(code),
    });

    events.emit('unhandledRejection', new Error('timer exploded'));
    events.emit('uncaughtException', new Error('second fault'));

    assert.equal(unmounts, 1);
    assert.equal(aborts, 1);
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

describe('silvery TUI Phase 1 chat surface', () => {
  it('maps real session rows and keeps the measured fallback pinned to the newest row', {
    skip: silverySkip,
  }, async () => {
    const { tailWindow } = await import('../silvery/surface.tsx');
    const { sessionMessagesToTranscriptRows } = await import('../tui-history.ts');
    const history = Array.from({ length: 12 }, (_, index) => [
      { role: 'user', content: `question ${index}` },
      { role: 'assistant', content: `answer ${index}` },
    ]).flat();
    const rows = sessionMessagesToTranscriptRows(history).map((row, index) => ({
      id: String(index),
      ...row,
    }));

    const visible = tailWindow(rows, 48, 8);
    assert.ok(visible.length < rows.length);
    assert.equal(visible.at(-1)?.text, 'answer 11');
    assert.equal(
      visible.some((row) => row.text === 'question 0'),
      false,
    );
  });

  it('submits through the shared turn kernel and exposes streamed assistant text', {
    skip: silverySkip,
  }, async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'p1-session',
      messages: [{ role: 'system', content: 'system' }],
      eventSeq: 0,
      updatedAt: Date.now(),
      cwd: '/repo',
      provider: 'ollama',
      model: 'test-model',
      rounds: 0,
      sessionName: '',
      workingMemory: {},
      mode: 'tui',
    };
    const snapshots = [];
    let received;
    const controller = await createSilveryController(
      { sessionId: state.sessionId },
      {
        loadConfig: async () => ({ safeExecPatterns: [] }),
        useDaemon: false,
        initSession: async () => state,
        gitStatus: async () => ({ branch: 'main', dirty: 0, ahead: 0, behind: 0 }),
        resolveKey: () => '',
        appendEvent: async () => undefined,
        saveState: async () => undefined,
        runTurn: async (receivedState, _provider, _key, text, _rounds, options) => {
          received = {
            receivedState,
            text,
            approved: await options.approvalFn('write_file'),
            answer: await options.askUserFn('Which implementation?'),
          };
          options.emit({
            type: 'assistant_token',
            payload: { text: 'streaming now' },
            runId: 'run-1',
            sessionId: state.sessionId,
          });
          await sleep(0);
          receivedState.messages.push({ role: 'assistant', content: 'streaming now' });
          options.emit({
            type: 'assistant_done',
            payload: {},
            runId: 'run-1',
            sessionId: state.sessionId,
          });
          return {
            outcome: 'success',
            finalAssistantText: 'streaming now',
            rounds: 1,
            runId: 'run-1',
          };
        },
      },
    );
    controller.subscribe(() => snapshots.push(controller.getSnapshot()));

    await controller.submit('hello kernel');

    assert.equal(received?.receivedState, state);
    assert.equal(received?.text, 'hello kernel');
    assert.equal(received?.approved, false);
    assert.match(received?.answer, /make a reasonable assumption/);
    assert.ok(
      snapshots.some((snapshot) =>
        snapshot.rows.some((row) => row.live && row.text === 'streaming now'),
      ),
    );
    assert.deepEqual(
      controller
        .getSnapshot()
        .rows.filter((row) => row.role === 'user' || row.role === 'assistant')
        .map((row) => row.text),
      ['hello kernel', 'streaming now'],
    );
    assert.equal(controller.getSnapshot().running, false);
    assert.ok(
      controller
        .getSnapshot()
        .rows.some((row) => row.role === 'status' && /needs approval; denied/.test(row.text)),
    );
    assert.ok(
      controller
        .getSnapshot()
        .rows.some((row) => row.role === 'status' && /Question deferred/.test(row.text)),
    );
    await controller.dispose();
  });

  it('keeps daemon turns display-only and omits event_v2 from the Silvery profile', async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'daemon-session',
      messages: [{ role: 'system', content: 'system' }],
      eventSeq: 0,
      updatedAt: Date.now(),
      cwd: '/repo',
      provider: 'ollama',
      model: 'test-model',
      rounds: 0,
      sessionName: '',
      workingMemory: {},
      mode: 'tui',
    };
    let hooks;
    let advertisedCapabilities;
    let sendPayload;
    let saves = 0;
    const client = {
      request: async (type, payload) => {
        if (type === 'send_user_message') {
          sendPayload = payload;
          queueMicrotask(() => {
            hooks.onEngineEvent({
              kind: 'event',
              type: 'assistant_token',
              payload: { text: 'daemon answer' },
            });
            hooks.onEngineEvent({ kind: 'event', type: 'assistant_done', payload: {} });
            hooks.onEngineEvent({ kind: 'event', type: 'run_complete', payload: {} });
          });
          return { payload: { runId: 'daemon-run' } };
        }
        return { payload: {} };
      },
    };
    const controller = await createSilveryController(
      { sessionId: state.sessionId },
      {
        loadConfig: async () => ({ safeExecPatterns: [] }),
        useDaemon: false,
        initSession: async () => state,
        gitStatus: async () => ({ branch: 'main', dirty: 0, ahead: 0, behind: 0 }),
        saveState: async () => saves++,
        createDaemon: (receivedHooks, capabilities) => {
          hooks = receivedHooks;
          advertisedCapabilities = [...capabilities];
          return {
            connected: true,
            sessionId: state.sessionId,
            attachToken: 'token',
            client,
            ensureConnected: async () => true,
            ensureReady: async () => true,
            noteSeenSeq: () => undefined,
            scheduleReconnect: () => undefined,
            teardown: () => undefined,
          };
        },
      },
    );

    await controller.submit('daemon question');

    assert.deepEqual(state.messages, [{ role: 'system', content: 'system' }]);
    assert.equal(saves, 0, 'daemon-backed turns must not save the local session mirror');
    assert.equal(advertisedCapabilities.includes('event_v2'), false);
    assert.equal(sendPayload.capabilities.includes('event_v2'), false);
    assert.deepEqual(
      controller
        .getSnapshot()
        .rows.filter((row) => row.role === 'user' || row.role === 'assistant')
        .map((row) => row.text),
      ['daemon question', 'daemon answer'],
    );
    await controller.dispose();
    assert.equal(saves, 0, 'disposing a stale daemon mirror must not overwrite daemon state');
  });

  it('settles an in-flight turn when the daemon socket closes', async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'disconnect-session',
      messages: [{ role: 'system', content: 'system' }],
      eventSeq: 0,
      updatedAt: Date.now(),
      cwd: '/repo',
      provider: 'ollama',
      model: 'test-model',
      rounds: 0,
      sessionName: '',
      workingMemory: {},
      mode: 'tui',
    };
    let hooks;
    let requestAccepted;
    const accepted = new Promise((resolve) => (requestAccepted = resolve));
    const controller = await createSilveryController(
      { sessionId: state.sessionId },
      {
        loadConfig: async () => ({ safeExecPatterns: [] }),
        useDaemon: false,
        initSession: async () => state,
        gitStatus: async () => ({ branch: 'main', dirty: 0, ahead: 0, behind: 0 }),
        saveState: async () => undefined,
        createDaemon: (receivedHooks) => {
          hooks = receivedHooks;
          return {
            connected: true,
            sessionId: state.sessionId,
            attachToken: 'token',
            client: {
              request: async () => {
                requestAccepted();
                return { payload: { runId: 'daemon-run' } };
              },
            },
            ensureConnected: async () => true,
            ensureReady: async () => true,
            noteSeenSeq: () => undefined,
            scheduleReconnect: () => undefined,
            teardown: () => undefined,
          };
        },
      },
    );

    const submission = controller.submit('will disconnect');
    await accepted;
    hooks.onSocketClose();
    await submission;

    assert.equal(controller.getSnapshot().running, false);
    assert.match(controller.getSnapshot().error, /disconnected before the turn completed/i);
    await controller.dispose();
  });

  it('cleans up and surfaces pre-turn persistence failures', async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'new-session',
      messages: [{ role: 'system', content: 'system' }],
      eventSeq: 0,
      updatedAt: Date.now(),
      cwd: '/repo',
      provider: 'ollama',
      model: 'test-model',
      rounds: 0,
      sessionName: '',
      workingMemory: {},
      mode: 'tui',
    };
    const controller = await createSilveryController(
      {},
      {
        loadConfig: async () => ({ safeExecPatterns: [] }),
        useDaemon: false,
        initSession: async () => state,
        gitStatus: async () => ({ branch: 'main', dirty: 0, ahead: 0, behind: 0 }),
        appendEvent: async () => {
          throw new Error('session disk unavailable');
        },
        saveState: async () => undefined,
      },
    );

    await controller.submit('cannot persist');

    assert.equal(controller.getSnapshot().running, false);
    assert.equal(controller.getSnapshot().startedAt, null);
    assert.match(controller.getSnapshot().error, /session disk unavailable/);
    await controller.dispose();
  });

  it('renders the newest real rows and hands focus to and from the command palette', {
    skip: silverySkip,
  }, async () => {
    const React = (await import('react')).default;
    const Silvery = await import('silvery');
    const { PushSurface } = await import('../silvery/surface.tsx');
    const stdout = new FakeStdout(72, 18);
    const stdin = new FakeStdin();
    const hook = {};
    const listeners = new Set();
    const snapshot = {
      rows: Array.from({ length: 16 }, (_, index) => ({
        id: String(index),
        role: index % 2 ? 'assistant' : 'user',
        text: `real row ${index}`,
      })),
      running: false,
      startedAt: null,
      provider: 'ollama',
      model: 'test-model',
      cwd: '/repo',
      gitStatus: { branch: 'main', dirty: 0, ahead: 0, behind: 0 },
      daemonConnected: false,
      error: null,
    };
    const controller = {
      getSnapshot: () => snapshot,
      subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
      submit: async () => undefined,
      cancel: () => undefined,
      clearDisplay: () => undefined,
      dispose: async () => undefined,
    };
    const handle = Silvery.render(
      React.createElement(PushSurface, { controller, hook }),
      { stdout, stdin },
      { exitOnCtrlC: false, alternateScreen: false, mode: 'fullscreen', mouse: true },
    );
    const lifecycle = handle.run();
    const instance = await handle;
    await sleep(180);

    assert.match(stdout.bytes, /real row 15/);
    assert.equal(hook.getState().inputActive, true);
    hook.openPalette();
    await sleep(120);
    assert.match(stdout.bytes, /Command Palette/);
    assert.deepEqual(hook.getState(), { paletteOpen: true, inputActive: false, rowCount: 16 });

    instance.unmount();
    await lifecycle;
  });

  it('keeps the ANSI renderer as the untouched default after Phase 1 modules exist', async () => {
    let silveryLoaded = false;
    const result = await launchTui(
      { sessionId: 'ansi-regression' },
      {
        silveryFlag: undefined,
        log: () => undefined,
        loadSilvery: async () => {
          silveryLoaded = true;
          return { runTuiSilvery: async () => 1 };
        },
        loadAnsi: async () => ({ runTUI: async () => 0 }),
      },
    );
    assert.equal(result, 0);
    assert.equal(silveryLoaded, false);
  });
});
