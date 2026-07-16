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

  it('routes the shared options to the sole silvery renderer', async () => {
    const calls = [];
    const logs = [];
    const result = await launchTui(options, {
      nodeMajor: 24,
      log: (line) => logs.push(JSON.parse(line)),
      loadSilvery: async () => ({
        runTuiSilvery: async (received) => {
          calls.push(['silvery', received]);
          return 17;
        },
      }),
    });

    assert.equal(result, 17);
    assert.deepEqual(calls, [['silvery', options]]);
    assert.deepEqual(logs, [{ level: 'info', event: 'tui_launch_silvery' }]);
  });

  it('ignores the removed migration flag and still launches silvery', async () => {
    const previous = process.env.PUSH_TUI_SILVERY;
    process.env.PUSH_TUI_SILVERY = '0';
    try {
      const result = await launchTui(options, {
        nodeMajor: 24,
        log: () => undefined,
        loadSilvery: async () => ({ runTuiSilvery: async () => 17 }),
      });
      assert.equal(result, 17);
    } finally {
      if (previous === undefined) delete process.env.PUSH_TUI_SILVERY;
      else process.env.PUSH_TUI_SILVERY = previous;
    }
  });

  it('fails before importing silvery below Node 24', async () => {
    let loaded = false;
    await assert.rejects(
      launchTui(options, {
        nodeMajor: 22,
        isBun: () => false,
        loadSilvery: async () => {
          loaded = true;
          return { runTuiSilvery: async () => 0 };
        },
      }),
      /requires Node >=24/,
    );
    assert.equal(loaded, false);
  });

  // Bun parses silvery's `using` syntax regardless of process.versions.node
  // (the single-binary path). The Node floor only applies off-Bun.
  it('allows Bun to launch silvery even when process.versions.node is old', async () => {
    let loaded = false;
    const result = await launchTui(options, {
      nodeMajor: 22,
      isBun: () => true,
      log: () => undefined,
      loadSilvery: async () => {
        loaded = true;
        return { runTuiSilvery: async () => 19 };
      },
    });
    assert.equal(loaded, true);
    assert.equal(result, 19);
  });

  it('bridges Tab around Silvery focus traversal without claiming other keys', {
    skip: silverySkip,
  }, async () => {
    const { bridgeSilveryCompletionKey } = await import('../silvery/entry.tsx');
    const directions = [];
    const hook = { complete: (reverse) => directions.push(reverse) };

    assert.equal(bridgeSilveryCompletionKey('\t', hook), true);
    assert.equal(bridgeSilveryCompletionKey('\x1b[Z', hook), true);
    assert.equal(bridgeSilveryCompletionKey('x', hook), false);
    assert.deepEqual(directions, [false, true]);
  });

  it('bundles silvery into every single-binary compile command', async () => {
    const workflow = await readFile(
      path.resolve(import.meta.dirname, '..', '..', '.github', 'workflows', 'ci.yml'),
      'utf8',
    );
    const compileLines = workflow
      .split('\n')
      .filter((line) => line.includes('bun build --compile') && line.includes('cli/cli.ts'));

    assert.equal(compileLines.length, 4, 'expected host compile plus three cross-compiles');
    for (const line of compileLines) assert.doesNotMatch(line, /--external silvery/);
  });
});

describe('silvery Phase 0 fault shell', () => {
  it('cancels an active turn on Ctrl+C but lets idle Ctrl+C exit', {
    skip: silverySkip,
  }, async () => {
    const { handleTuiInterrupt } = await import('../silvery/surface.tsx');
    let running = true;
    let cancels = 0;
    let exits = 0;

    handleTuiInterrupt(
      running,
      () => cancels++,
      () => exits++,
    );
    assert.equal(cancels, 1);
    assert.equal(exits, 0);
    running = false;
    handleTuiInterrupt(
      running,
      () => cancels++,
      () => exits++,
    );
    assert.equal(cancels, 1);
    assert.equal(exits, 1);
  });

  it('maps the restored composer hotkeys without borrowing modal focus', {
    skip: silverySkip,
  }, async () => {
    const { resolveComposerShortcut } = await import('../silvery/surface.tsx');
    assert.equal(resolveComposerShortcut('\t', { tab: true }), 'complete');
    assert.equal(resolveComposerShortcut('k', { ctrl: true }), 'palette');
    assert.equal(resolveComposerShortcut('l', { ctrl: true }), 'clear');
    assert.equal(resolveComposerShortcut('p', { ctrl: true }), 'provider');
    assert.equal(resolveComposerShortcut('p', {}), null);
  });

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
    // Visual Language v2 fault surface: narrating voice + preserved session.
    assert.match(stdout.bytes, /This screen failed to render/);
    assert.match(stdout.bytes, /deliberate Phase 0 render fault/);
    assert.match(stdout.bytes, /session is still in the daemon/i);
    assert.match(stdout.bytes, /Restart this screen/i);

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
  it('does not strip tool-call-shaped JSON from untyped assistant history', async () => {
    const { sessionMessagesToTranscriptRows } = await import('../tui-history.ts');
    const content = '```json\n{"tool":"Read","args":{"path":"a.ts"}}\n```';
    assert.deepEqual(sessionMessagesToTranscriptRows([{ role: 'assistant', content }]), [
      { role: 'assistant', text: content },
    ]);
  });

  it('maps real session rows and keeps the measured fallback pinned to the newest row', {
    skip: silverySkip,
  }, async () => {
    const { tailWindow } = await import('../silvery/surface.tsx');
    const { sessionMessagesToTranscriptRows } = await import('../tui-history.ts');
    const history = Array.from({ length: 12 }, (_, index) => [
      { role: 'user', content: `question ${index}`, timestamp: index * 2 + 1 },
      { role: 'assistant', content: `answer ${index}`, timestamp: index * 2 + 2 },
    ]).flat();
    const rows = sessionMessagesToTranscriptRows(history).map((row, index) => ({
      id: String(index),
      ...row,
    }));

    const visible = tailWindow(rows, 48, 8);
    assert.ok(visible.length < rows.length);
    assert.equal(visible.at(-1)?.text, 'answer 11');
    assert.equal(visible.at(-1)?.timestampMs, 24);
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
          received = { receivedState, text };
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
    await controller.dispose();
  });

  it('routes inline approvals and questions through retained interactions', async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'interaction-session',
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
    let result;
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
        runTurn: async (_state, _provider, _key, _text, _rounds, options) => {
          result = {
            approved: await options.approvalFn('exec', 'npm test'),
            answer: await options.askUserFn('Which implementation?'),
          };
          return { outcome: 'success', finalAssistantText: '', rounds: 1, runId: 'run-1' };
        },
      },
    );

    const submission = controller.submit('exercise interactions');
    while (controller.getSnapshot().interaction?.kind !== 'approval') await sleep(0);
    const approval = controller.getSnapshot().interaction;
    assert.equal(approval.detail, 'npm test');
    controller.respondToInteraction(approval.id, true);
    while (controller.getSnapshot().interaction?.kind !== 'question') await sleep(0);
    const question = controller.getSnapshot().interaction;
    controller.respondToInteraction(question.id, 'Use the smaller diff');
    await submission;

    assert.deepEqual(result, { approved: true, answer: 'Use the smaller diff' });
    assert.equal(controller.getSnapshot().interaction, null);
    await controller.dispose();
  });

  it('orders render-only tool prose before the inline TUI tool card', {
    skip: silverySkip,
  }, async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'inline-card-session',
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
    const card = { type: 'ci-status', data: { repo: 'KvFxKaido/Push', checkCount: 3 } };
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
        runTurn: async (_state, _provider, _key, _text, _rounds, options) => {
          options.emit({
            type: 'assistant.tool_prose',
            payload: { round: 0, text: 'I’ll check CI.' },
            runId: 'run-card',
            sessionId: state.sessionId,
          });
          options.emit({
            type: 'tool.execution_complete',
            payload: {
              toolName: 'ci_status',
              isError: false,
              preview: 'RAW_MODEL_PREVIEW',
              card,
            },
            runId: 'run-card',
            sessionId: state.sessionId,
          });
          return { outcome: 'success', finalAssistantText: '', rounds: 1, runId: 'run-card' };
        },
      },
    );

    await controller.submit('show CI');
    const rows = controller.getSnapshot().rows;
    const proseIndex = rows.findIndex((candidate) => candidate.kind === 'tool_prose');
    const toolIndex = rows.findIndex((candidate) => candidate.kind === 'tool');
    const row = rows[toolIndex];
    assert.equal(rows[proseIndex]?.text, 'I’ll check CI.');
    assert.ok(proseIndex >= 0 && proseIndex < toolIndex);
    assert.deepEqual(row?.card, card);
    await controller.dispose();
  });

  it('settles legacy inline tool rows by name and preserves failure state', async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'inline-legacy-tool-session',
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
      { sessionId: state.sessionId },
      {
        loadConfig: async () => ({ safeExecPatterns: [] }),
        useDaemon: false,
        initSession: async () => state,
        gitStatus: async () => ({ branch: 'main', dirty: 0, ahead: 0, behind: 0 }),
        resolveKey: () => '',
        appendEvent: async () => undefined,
        saveState: async () => undefined,
        runTurn: async (_state, _provider, _key, _text, _rounds, options) => {
          options.emit({
            type: 'tool_call',
            payload: { toolName: 'sandbox_exec' },
            runId: 'run-legacy-tool',
            sessionId: state.sessionId,
          });
          options.emit({
            type: 'tool_result',
            payload: { toolName: 'sandbox_exec', isError: true, target: 'false' },
            runId: 'run-legacy-tool',
            sessionId: state.sessionId,
          });
          options.emit({
            type: 'tool.execution_start',
            payload: { toolName: 'read_file', executionId: 'stale-start-id' },
            runId: 'run-legacy-tool',
            sessionId: state.sessionId,
          });
          options.emit({
            type: 'tool.execution_complete',
            payload: {
              toolName: 'read_file',
              executionId: 'current-completion-id',
              isError: false,
              target: 'README.md',
            },
            runId: 'run-legacy-tool',
            sessionId: state.sessionId,
          });
          return {
            outcome: 'success',
            finalAssistantText: '',
            rounds: 1,
            runId: 'run-legacy-tool',
          };
        },
      },
    );

    await controller.submit('run a failing command');
    const toolRows = controller.getSnapshot().rows.filter((row) => row.kind === 'tool');
    assert.equal(toolRows.length, 2);
    assert.equal(toolRows[0]?.pending, false);
    assert.equal(toolRows[0]?.isError, true);
    assert.equal(toolRows[0]?.target, 'false');
    assert.equal(toolRows[1]?.pending, false);
    assert.equal(toolRows[1]?.isError, false);
    assert.equal(toolRows[1]?.target, 'README.md');
    await controller.dispose();
  });

  it('handles retained slash commands without sending them to the model', async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'command-session',
      messages: [{ role: 'system', content: 'system' }],
      eventSeq: 0,
      updatedAt: Date.now(),
      cwd: '/repo',
      provider: 'ollama',
      model: 'test-model',
      rounds: 0,
      sessionName: 'Command test',
      workingMemory: {},
      mode: 'tui',
    };
    let turns = 0;
    let savedConfig;
    const controller = await createSilveryController(
      { sessionId: state.sessionId },
      {
        loadConfig: async () => ({ safeExecPatterns: [], ollama: { model: 'test-model' } }),
        saveConfig: async (next) => {
          savedConfig = next;
          return '/tmp/push-config.json';
        },
        useDaemon: false,
        initSession: async () => state,
        gitStatus: async () => ({ branch: 'main', dirty: 0, ahead: 0, behind: 0 }),
        saveState: async () => undefined,
        appendEvent: async () => undefined,
        resolveKey: () => 'test-key',
        runTurn: async () => {
          turns++;
          return { outcome: 'success', finalAssistantText: '', rounds: 1, runId: 'run-1' };
        },
      },
    );

    await controller.submit('/help');
    await controller.submit('/session');
    await controller.submit('/session rename Renamed');
    await controller.submit('/model test-model-2');
    await controller.submit('/config');

    assert.equal(turns, 0);
    assert.ok(controller.getSnapshot().rows.some((row) => /^Commands:/.test(row.text)));
    assert.ok(controller.getSnapshot().rows.some((row) => /Keys:\n/.test(row.text)));
    assert.ok(controller.getSnapshot().rows.some((row) => /Tab \/ Shift\+Tab/.test(row.text)));
    assert.ok(
      controller.getSnapshot().rows.some((row) => /session: command-session/.test(row.text)),
    );
    assert.ok(
      controller.getSnapshot().rows.some((row) => /Session renamed: "Renamed"/.test(row.text)),
    );
    assert.equal(state.sessionName, 'Renamed');
    assert.equal(state.model, 'test-model-2');
    assert.equal(controller.getSnapshot().model, 'test-model-2');
    assert.ok(
      controller.getSnapshot().rows.some((row) => /Model switched to: test-model-2/.test(row.text)),
    );
    assert.ok(controller.getSnapshot().rows.some((row) => /provider: ollama/.test(row.text)));
    assert.equal(savedConfig?.ollama?.model, 'test-model-2');
    await controller.dispose();
  });

  it('serves /resume rows from list_sessions when the daemon is attached', async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'sess_resume_abc123',
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
    let listSessionsCalls = 0;
    const row = {
      sessionId: 'sess_daemonrow_abc123',
      updatedAt: Date.now(),
      provider: 'zen',
      model: 'from-daemon',
      cwd: '/repo',
      sessionName: 'from-daemon',
      lastUserMessage: 'served over the socket',
      mode: 'tui',
    };
    const client = {
      request: async (type, payload) => {
        if (type === 'list_sessions') {
          assert.equal(payload.limit, 1000);
          return { ok: true, payload: { sessions: [row] } };
        }
        if (type === 'get_session_snapshot') {
          return {
            payload: {
              transcript: { mirror: { rows: [], liveText: '', lastSeq: 0 } },
            },
          };
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
        saveState: async () => undefined,
        listSessions: async () => {
          listSessionsCalls += 1;
          return [];
        },
        createDaemon: (receivedHooks) => {
          hooks = receivedHooks;
          return {
            connected: true,
            sessionId: state.sessionId,
            attachToken: 'token',
            client,
            ensureConnected: async () => true,
            ensureReady: async () => true,
            ensureSession: async () => undefined,
            noteSeenSeq: () => undefined,
            scheduleReconnect: () => undefined,
            teardown: () => undefined,
          };
        },
      },
    );

    await controller.submit('/resume');
    assert.equal(listSessionsCalls, 0, 'must not fall back to disk when RPC succeeds');
    assert.ok(
      controller.getSnapshot().rows.some((r) => /sess_daemonrow_abc123/.test(r.text)),
      'resume listing should show the daemon-served session id',
    );
    assert.ok(controller.getSnapshot().rows.some((r) => /from-daemon/.test(r.text)));
    await controller.dispose();
  });

  it('uses the daemon exec mode for attached turns and refreshes it before send', async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const previousExecMode = process.env.PUSH_EXEC_MODE;
    process.env.PUSH_EXEC_MODE = 'strict';
    const state = {
      sessionId: 'sess_mode_abc123',
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
    let daemonMode = 'yolo';
    const runtimeReads = [];
    try {
      const controller = await createSilveryController(
        { sessionId: state.sessionId },
        {
          loadConfig: async () => ({ execMode: 'strict', safeExecPatterns: [] }),
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
                request: async (type) => {
                  if (type === 'get_daemon_runtime_config') {
                    runtimeReads.push(daemonMode);
                    return { payload: { execMode: daemonMode } };
                  }
                  if (type === 'get_session_snapshot') {
                    return {
                      payload: {
                        transcript: { mirror: { rows: [], liveText: '', lastSeq: 0 } },
                      },
                    };
                  }
                  if (type === 'send_user_message') {
                    queueMicrotask(() =>
                      hooks.onEngineEvent({ type: 'run_complete', payload: {} }),
                    );
                    return { payload: { runId: 'run-mode' } };
                  }
                  return { payload: {} };
                },
              },
              ensureConnected: async () => true,
              ensureReady: async () => true,
              ensureSession: async () => undefined,
              noteSeenSeq: () => undefined,
              scheduleReconnect: () => undefined,
              teardown: () => undefined,
            };
          },
        },
      );

      assert.equal(controller.getSnapshot().execMode, 'yolo');
      daemonMode = 'auto';
      await controller.submit('refresh the authority');
      assert.equal(controller.getSnapshot().execMode, 'auto');
      assert.deepEqual(runtimeReads, ['yolo', 'auto']);
      await controller.dispose();
    } finally {
      if (previousExecMode === undefined) delete process.env.PUSH_EXEC_MODE;
      else process.env.PUSH_EXEC_MODE = previousExecMode;
    }
  });

  it('routes daemon session verbs through the controller', async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'sess_verbs_abc123',
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
    const verbCalls = [];
    const controller = await createSilveryController(
      { sessionId: state.sessionId },
      {
        loadConfig: async () => ({ safeExecPatterns: [] }),
        useDaemon: false,
        initSession: async () => state,
        gitStatus: async () => ({ branch: 'main', dirty: 0, ahead: 0, behind: 0 }),
        saveState: async () => undefined,
        createDaemon: () => ({
          connected: true,
          sessionId: state.sessionId,
          attachToken: 'token',
          client: {
            request: async (type, payload) => {
              if (type === 'get_session_snapshot') {
                return {
                  payload: {
                    transcript: {
                      mirror: {
                        rows: [{ id: 'kept', kind: 'message', role: 'user', text: 'still here' }],
                        liveText: '',
                        lastSeq: 1,
                      },
                    },
                  },
                };
              }
              return { payload: {} };
            },
          },
          ensureConnected: async () => true,
          ensureReady: async () => true,
          ensureSession: async () => undefined,
          noteSeenSeq: () => undefined,
          scheduleReconnect: () => undefined,
          teardown: () => undefined,
          revert: async (turns) => {
            verbCalls.push(['session_revert', turns]);
            return { ok: true, payload: { reverted: true } };
          },
          unrevert: async () => {
            verbCalls.push(['session_unrevert']);
            return { ok: true, payload: {} };
          },
          summarize: async (preserveTurns) => {
            verbCalls.push(['session_summarize', preserveTurns]);
            return { ok: true, payload: { compacted: true } };
          },
          listChildren: async () => {
            verbCalls.push(['list_children']);
            return {
              ok: true,
              payload: {
                children: [{ subagentId: 'child-1', agent: 'explorer', status: 'completed' }],
              },
            };
          },
          getChild: async (id) => {
            verbCalls.push(['get_child_session', id]);
            return { ok: true, payload: { child: { subagentId: id, agent: 'coder' } } };
          },
        }),
      },
    );

    await controller.submit('/revert 3');
    await controller.submit('/unrevert');
    await controller.submit('/compact 8');
    await controller.submit('/children');
    await controller.submit('/children child-1');

    assert.deepEqual(verbCalls, [
      ['session_revert', 3],
      ['session_unrevert'],
      ['session_summarize', 8],
      ['list_children'],
      ['get_child_session', 'child-1'],
    ]);
    assert.ok(controller.getSnapshot().rows.some((r) => /child-1/.test(r.text)));
    await controller.dispose();
  });

  it('runs /editor through terminal handoff and parks the draft', async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'sess_editor_abc123',
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
    let handoffSpec;
    const controller = await createSilveryController(
      { sessionId: state.sessionId },
      {
        loadConfig: async () => ({ safeExecPatterns: [] }),
        useDaemon: false,
        initSession: async () => state,
        gitStatus: async () => ({ branch: 'main', dirty: 0, ahead: 0, behind: 0 }),
        saveState: async () => undefined,
        appendEvent: async () => undefined,
        runHandoffChild: async (spec) => {
          handoffSpec = spec;
          const fs = await import('node:fs/promises');
          await fs.writeFile(spec.args.at(-1), 'composed in $EDITOR\n', 'utf8');
          return { exitCode: 0, signal: null };
        },
      },
    );

    await controller.submit('/editor');
    assert.ok(handoffSpec, 'handoff must run a child');
    assert.ok(handoffSpec.args.at(-1), 'editor receives a temp file path');
    assert.equal(controller.takePendingComposerText(), 'composed in $EDITOR');
    assert.equal(controller.takePendingComposerText(), null, 'pending draft is single-shot');
    await controller.dispose();
  });

  it('keeps daemon turns display-only and mirrors full v2 daemon events', async () => {
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
              type: 'user_message',
              payload: { text: 'daemon question', preview: 'daemon question', chars: 15 },
            });
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
    assert.equal(advertisedCapabilities.includes('event_v2'), true);
    assert.equal(sendPayload.capabilities.includes('event_v2'), true);
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

  it('keeps the submitted human turn visible when the daemon echo is missing', async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'daemon-missing-echo-session',
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
    let acceptSend;
    let snapshotRequests = 0;
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
              request: async (type) => {
                if (type === 'get_session_snapshot') {
                  snapshotRequests++;
                  return snapshotRequests === 1
                    ? {
                        payload: {
                          transcript: { mirror: { rows: [], liveText: '', lastSeq: 0 } },
                        },
                      }
                    : { payload: {} };
                }
                if (type === 'send_user_message') {
                  return new Promise((resolve) => {
                    acceptSend = () => resolve({ payload: { runId: 'daemon-run' } });
                  });
                }
                return { payload: {} };
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

    const submission = controller.submit('do not vanish');
    while (!acceptSend) await sleep(0);
    assert.equal(
      controller
        .getSnapshot()
        .rows.some((row) => row.role === 'user' && row.text === 'do not vanish'),
      true,
    );

    hooks.onEngineEvent({ type: 'assistant_token', payload: { text: 'still here' } });
    hooks.onEngineEvent({ type: 'assistant_done', payload: {} });
    hooks.onEngineEvent({ type: 'run_complete', payload: {} });
    acceptSend();
    await submission;

    assert.deepEqual(
      controller
        .getSnapshot()
        .rows.filter((row) => row.role === 'user' || row.role === 'assistant')
        .map((row) => row.text),
      ['do not vanish', 'still here'],
    );
    await controller.dispose();
  });

  it('drops the optimistic user row when the daemon rejects the send', async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'daemon-send-reject-session',
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
      { sessionId: state.sessionId },
      {
        loadConfig: async () => ({ safeExecPatterns: [] }),
        useDaemon: false,
        initSession: async () => state,
        gitStatus: async () => ({ branch: 'main', dirty: 0, ahead: 0, behind: 0 }),
        saveState: async () => undefined,
        createDaemon: () => ({
          connected: true,
          sessionId: state.sessionId,
          attachToken: 'token',
          client: {
            request: async (type) => {
              if (type === 'get_session_snapshot') {
                return {
                  payload: { transcript: { mirror: { rows: [], liveText: '', lastSeq: 0 } } },
                };
              }
              if (type === 'send_user_message') {
                throw new Error('daemon rejected the send');
              }
              return { payload: {} };
            },
          },
          ensureConnected: async () => true,
          ensureReady: async () => true,
          noteSeenSeq: () => undefined,
          scheduleReconnect: () => undefined,
          teardown: () => undefined,
        }),
      },
    );

    await controller.submit('ghost message');

    assert.equal(controller.getSnapshot().running, false);
    assert.match(controller.getSnapshot().error, /daemon rejected the send/i);
    // The submission was never accepted — its optimistic row must not linger.
    assert.equal(
      controller.getSnapshot().rows.some((row) => row.text === 'ghost message'),
      false,
      'a rejected submission must not leave an optimistic ghost row',
    );
    await controller.dispose();
  });

  it('ignores an older attach snapshot after a daemon turn has started', async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'daemon-stale-attach-session',
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
    let resolveAttachSnapshot;
    let acceptSend;
    let snapshotRequests = 0;
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
              request: async (type) => {
                if (type === 'get_session_snapshot') {
                  snapshotRequests++;
                  if (snapshotRequests === 1) {
                    return new Promise((resolve) => {
                      resolveAttachSnapshot = resolve;
                    });
                  }
                  if (snapshotRequests === 2) {
                    return {
                      payload: {
                        transcript: { mirror: { rows: [], liveText: '', lastSeq: 0 } },
                      },
                    };
                  }
                  return { payload: {} };
                }
                if (type === 'send_user_message') {
                  acceptSend = true;
                  return { payload: { runId: 'daemon-run' } };
                }
                return { payload: {} };
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

    hooks.onAttached({ provider: 'ollama', model: 'test-model' });
    while (!resolveAttachSnapshot) await sleep(0);

    const submission = controller.submit('stay on screen');
    while (!acceptSend) await sleep(0);
    hooks.onEngineEvent({
      kind: 'event',
      seq: 1,
      type: 'user_message',
      payload: { text: 'stay on screen', preview: 'stay on screen', chars: 14 },
    });
    hooks.onEngineEvent({
      kind: 'event',
      seq: 2,
      type: 'assistant_token',
      payload: { text: 'thinking' },
    });

    resolveAttachSnapshot({
      payload: {
        transcript: { mirror: { rows: [], liveText: '', lastSeq: 0 } },
      },
    });
    await sleep(0);

    assert.deepEqual(
      controller
        .getSnapshot()
        .rows.filter((row) => row.role === 'user' || row.role === 'assistant')
        .map((row) => row.text),
      ['stay on screen', 'thinking'],
    );

    hooks.onEngineEvent({ kind: 'event', seq: 3, type: 'assistant_done', payload: {} });
    hooks.onEngineEvent({ kind: 'event', seq: 4, type: 'run_complete', payload: {} });
    await submission;
    await controller.dispose();
  });

  it('submits retained approval decisions back to the daemon', async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'daemon-approval-session',
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
    let decision;
    const client = {
      request: async (type, payload) => {
        if (type === 'send_user_message') {
          queueMicrotask(() => {
            hooks.onEngineEvent({
              kind: 'event',
              type: 'approval_required',
              payload: {
                approvalId: 'approval-1',
                title: 'Approve command',
                summary: 'npm test',
              },
            });
          });
          return { payload: { runId: 'daemon-run' } };
        }
        if (type === 'submit_approval') {
          decision = payload.decision;
          queueMicrotask(() => {
            hooks.onEngineEvent({ kind: 'event', type: 'approval_received', payload: {} });
            hooks.onEngineEvent({ kind: 'event', type: 'run_complete', payload: {} });
          });
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
        saveState: async () => undefined,
        createDaemon: (receivedHooks) => {
          hooks = receivedHooks;
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

    const submission = controller.submit('run a command');
    while (controller.getSnapshot().interaction?.id !== 'approval-1') await sleep(0);
    controller.respondToInteraction('approval-1', true);
    await submission;

    assert.equal(decision, 'approve');
    assert.equal(controller.getSnapshot().interaction, null);
    await controller.dispose();
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
              request: async (type) => {
                if (type === 'send_user_message') requestAccepted();
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

  it('resyncs the daemon mirror on transcript-mutation events', async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'mutation-session',
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
    let resyncReasons = [];
    const client = {
      request: async (type, payload) => {
        if (type === 'get_session_snapshot') {
          resyncReasons.push(payload);
          return {
            payload: {
              transcript: {
                mirror: {
                  rows: [
                    {
                      id: 'post-revert-user',
                      kind: 'message',
                      role: 'user',
                      text: 'still here',
                    },
                  ],
                  liveText: '',
                  lastSeq: 9,
                },
              },
            },
          };
        }
        if (type === 'send_user_message') {
          queueMicrotask(() => {
            hooks.onEngineEvent({
              kind: 'event',
              type: 'user_message',
              payload: { text: 'will revert', preview: 'will revert', chars: 11 },
            });
            hooks.onEngineEvent({
              kind: 'event',
              type: 'assistant_token',
              payload: { text: 'soon gone' },
            });
            hooks.onEngineEvent({ kind: 'event', type: 'assistant_done', payload: {} });
            hooks.onEngineEvent({
              kind: 'event',
              type: 'session_reverted',
              payload: { turns: 1, removedCount: 2, remainingTurns: 0 },
            });
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
        saveState: async () => undefined,
        createDaemon: (receivedHooks) => {
          hooks = receivedHooks;
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

    await controller.submit('will revert');

    assert.ok(resyncReasons.length >= 2, 'before_send + mutation (+ maybe run_complete)');
    assert.deepEqual(
      controller.getSnapshot().rows.map((row) => row.text),
      ['still here'],
    );
    assert.equal(
      controller
        .getSnapshot()
        .rows.some((row) => row.text === 'will revert' || row.text === 'soon gone'),
      false,
    );
    await controller.dispose();
  });

  it('clears a prior resync error once a later snapshot is adopted', async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'resync-error-session',
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
    let snapshotCalls = 0;
    const client = {
      request: async (type) => {
        if (type === 'get_session_snapshot') {
          snapshotCalls += 1;
          if (snapshotCalls === 1) throw new Error('snapshot timeout');
          return {
            payload: {
              transcript: {
                mirror: {
                  rows: [{ id: 'ok', kind: 'message', role: 'user', text: 'recovered' }],
                  liveText: '',
                  lastSeq: 1,
                },
              },
            },
          };
        }
        if (type === 'send_user_message') {
          queueMicrotask(() => {
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
        saveState: async () => undefined,
        createDaemon: (receivedHooks) => {
          hooks = receivedHooks;
          queueMicrotask(() => hooks.onAttached({ provider: 'ollama', model: 'test-model' }));
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

    while (!controller.getSnapshot().error) await sleep(0);
    assert.match(controller.getSnapshot().error, /transcript resync failed/i);

    await controller.submit('recover');
    assert.equal(controller.getSnapshot().error, null);
    assert.deepEqual(
      controller.getSnapshot().rows.map((row) => row.text),
      ['recovered'],
    );
    await controller.dispose();
  });

  it('stringifies approval detail safely when detail is undefined', async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'approval-detail-session',
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
    let result;
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
        runTurn: async (_state, _provider, _key, _text, _rounds, options) => {
          result = await options.approvalFn('exec', undefined);
          return { outcome: 'success', finalAssistantText: '', rounds: 1, runId: 'run-1' };
        },
      },
    );

    const submission = controller.submit('approve without detail');
    while (controller.getSnapshot().interaction?.kind !== 'approval') await sleep(0);
    const approval = controller.getSnapshot().interaction;
    assert.equal(typeof approval.detail, 'string');
    assert.equal(approval.detail, '');
    controller.respondToInteraction(approval.id, false);
    await submission;
    assert.equal(result, false);
    await controller.dispose();
  });

  it('hides daemon liveText when the display is cleared mid-stream', async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'clear-live-session',
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
    const client = {
      request: async (type) => {
        if (type === 'get_session_snapshot') {
          return {
            payload: {
              transcript: {
                mirror: { rows: [], liveText: '', lastSeq: 0 },
              },
            },
          };
        }
        if (type === 'send_user_message') {
          requestAccepted();
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
        saveState: async () => undefined,
        createDaemon: (receivedHooks) => {
          hooks = receivedHooks;
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

    const submission = controller.submit('streaming');
    await accepted;
    hooks.onEngineEvent({
      kind: 'event',
      type: 'user_message',
      payload: { text: 'streaming', preview: 'streaming', chars: 9 },
    });
    hooks.onEngineEvent({
      kind: 'event',
      type: 'assistant_token',
      payload: { text: 'partial answer' },
    });
    assert.ok(
      controller.getSnapshot().rows.some((row) => row.live && row.text === 'partial answer'),
    );

    controller.clearDisplay();
    assert.equal(
      controller.getSnapshot().rows.some((row) => row.live || row.text === 'partial answer'),
      false,
    );
    assert.deepEqual(controller.getSnapshot().rows, []);

    hooks.onEngineEvent({ kind: 'event', type: 'run_complete', payload: {} });
    await submission;
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
    // The inline append never landed, so the optimistic row must not linger.
    assert.equal(
      controller.getSnapshot().rows.some((row) => row.text === 'cannot persist'),
      false,
      'a failed inline submission must not leave an optimistic ghost row',
    );
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
    const submissions = [];
    const snapshot = {
      rows: Array.from({ length: 16 }, (_, index) => ({
        id: String(index),
        role: index % 2 ? 'assistant' : 'user',
        text: `real row ${index}`,
        timestampMs: new Date(2026, 6, 12, 15, index).getTime(),
      })),
      running: false,
      startedAt: null,
      provider: 'ollama',
      model: 'deepseek-v4-pro',
      cwd: '/repo',
      gitStatus: { branch: 'main', dirty: 0, ahead: 0, behind: 0 },
      daemonConnected: false,
      error: null,
      interaction: null,
      picker: null,
      theme: 'mono',
      execMode: 'auto',
    };
    const controller = {
      getSnapshot: () => snapshot,
      subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
      submit: async (text) => submissions.push(text),
      cancel: () => undefined,
      clearDisplay: () => undefined,
      openPicker: () => undefined,
      takePendingComposerText: () => null,
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

    // Tail-follow regression guard (the "message jumps to the top and disappears
    // on activity" bug). Assert a WINDOW of the newest rows renders, not just the
    // last one: the overshoot mode showed only row 15 alone at the top, and the
    // overflowIndicator mode hid row 15 one line below the fold — both drop rows
    // 13-15 from the settled frame. (Only positive matches: stdout.bytes is
    // cumulative, so a doesNotMatch on an old row would catch pre-scroll frames.)
    assert.match(stdout.bytes, /real row 15/); // newest row visible (not below the fold)
    assert.match(stdout.bytes, /real row 14/); // and the ones before it (not alone at top)
    assert.match(stdout.bytes, /real row 13/);
    assert.match(stdout.bytes, /\/ 1m/);
    assert.match(stdout.bytes, /turn 8/);
    assert.equal(hook.getState().inputActive, true);
    hook.openPalette();
    await sleep(120);
    assert.match(stdout.bytes, /Command Palette/);
    assert.deepEqual(hook.getState(), {
      paletteOpen: true,
      pickerOpen: false,
      inputActive: false,
      rowCount: 16,
    });
    assert.equal(hook.getMotionState().palettePhase, 'entering');
    // Same reason the exit transition below polls: the enter transition is tick-driven,
    // not wall-clock driven. It settles on the first tick where `tick - startedAtTick >=
    // MOTION_TICKS.modalFade` (3 ticks x 150ms), and openPalette() lands *between* ticks,
    // so a punctual clock still needs up to 3*150 + 150 = 600ms. A hardcoded sleep left
    // only ~40ms for setInterval drift while ink re-rendered the transcript, which is how
    // this assertion flaked under full-suite load.
    for (let i = 0; i < 80 && hook.getMotionState().palettePhase === 'entering'; i++)
      await sleep(10);
    assert.equal(hook.getMotionState().palettePhase, 'open');
    assert.equal(hook.getMotionState().paletteFade, 0.35);

    hook.closePalette();
    // The exit transition fires on the post-close effect; when it lands depends on
    // render cost under the shared clock, so poll for it rather than snapshotting a
    // hardcoded delay. What matters: closing leaves 'open' and holds the composer
    // inert until the modal is fully gone.
    for (let i = 0; i < 80 && hook.getMotionState().palettePhase === 'open'; i++) await sleep(10);
    assert.notEqual(hook.getMotionState().palettePhase, 'open');
    assert.equal(hook.getState().inputActive, false);
    for (let i = 0; i < 80 && hook.getMotionState().palettePhase !== 'closed'; i++) await sleep(10);
    assert.equal(hook.getMotionState().palettePhase, 'closed');
    assert.deepEqual(hook.getState(), {
      paletteOpen: false,
      pickerOpen: false,
      inputActive: true,
      rowCount: 16,
    });

    // `hook.getComposerState()` mixes two freshnesses: `completion` reads the live
    // completer, but `input` is captured in the render closure that last assigned the
    // hook. So a composer mutation lands in `completion` immediately and in `input` only
    // once the re-render commits. Poll for the input rather than sleeping a fixed 30ms —
    // under full-suite load the render slips past it and the read catches the old input
    // beside the new completion.
    const waitForInput = async (text) => {
      for (let i = 0; i < 80 && hook.getComposerState().input !== text; i++) await sleep(10);
    };

    hook.setComposerInput('/mo');
    await waitForInput('/mo');
    assert.deepEqual(hook.getComposerState(), {
      input: '/mo',
      completion: { items: ['/model'], index: -1 },
    });

    hook.complete();
    await waitForInput('/model ');
    assert.deepEqual(hook.getComposerState(), {
      input: '/model ',
      completion: { items: ['/model'], index: 0 },
    });

    hook.setComposerInput('/c');
    const candidates = hook.getComposerState().completion.items;
    assert.ok(candidates.length > 1);
    hook.complete(true);
    assert.equal(hook.getComposerState().completion.index, candidates.length - 1);

    hook.setComposerInput('');
    await sleep(30);
    hook.changeComposerInput('?');
    await sleep(30);
    assert.deepEqual(submissions, ['/help']);

    instance.unmount();
    await lifecycle;
  });

  it('renders a typed card alongside a diff instead of the model-facing preview', {
    skip: silverySkip,
  }, async () => {
    const React = (await import('react')).default;
    const Silvery = await import('silvery');
    const { PushSurface } = await import('../silvery/surface.tsx');
    const stdout = new FakeStdout(72, 18);
    const stdin = new FakeStdin();
    const snapshot = {
      rows: [
        {
          id: 'card-1',
          kind: 'tool',
          role: 'coder',
          text: 'ci_status complete',
          toolName: 'ci_status',
          pending: false,
          resultPreview: 'RAW_MODEL_PREVIEW',
          card: {
            type: 'ci-status',
            data: { repo: 'KvFxKaido/Push', checkCount: 3 },
          },
          diff: {
            path: 'cli/pushd.ts',
            adds: 1,
            dels: 0,
            truncated: false,
            lines: [
              {
                kind: 'add',
                newLine: 1,
                text: 'const card = true;',
                textTruncated: false,
              },
            ],
          },
        },
      ],
      running: false,
      startedAt: null,
      provider: 'ollama',
      model: 'test-model',
      cwd: '/repo',
      gitStatus: { branch: 'main', dirty: 0, ahead: 0, behind: 0 },
      daemonConnected: false,
      error: null,
      interaction: null,
      picker: null,
      theme: 'mono',
      execMode: 'auto',
    };
    const controller = {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
      submit: async () => undefined,
      cancel: () => undefined,
      clearDisplay: () => undefined,
      openPicker: () => undefined,
      takePendingComposerText: () => null,
      dispose: async () => undefined,
    };
    const handle = Silvery.render(
      React.createElement(PushSurface, { controller, hook: {} }),
      { stdout, stdin },
      { exitOnCtrlC: false, alternateScreen: false, mode: 'fullscreen', mouse: true },
    );
    const lifecycle = handle.run();
    const instance = await handle;
    await sleep(120);

    assert.match(stdout.bytes, /CI Status/);
    assert.match(stdout.bytes, /Repo: KvFxKaido\/Push/);
    assert.match(stdout.bytes, /Check Count: 3/);
    assert.match(stdout.bytes, /cli\/pushd\.ts · \+1 -0/);
    assert.doesNotMatch(stdout.bytes, /RAW_MODEL_PREVIEW/);

    instance.unmount();
    await lifecycle;
  });

  // Regression for the #1431 review (fugu WARNING, triaged false-positive but
  // hardened): while an interaction modal is open, the background composer must
  // NOT be active — otherwise a keystroke could edit/submit the composer under
  // the modal (hidden-but-interactive, CLAUDE.md self-review class).
  it('gates the composer off while an interaction modal is open', {
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
      rows: [{ id: '0', role: 'user', text: 'awaiting approval' }],
      running: true,
      startedAt: null,
      provider: 'ollama',
      model: 'test-model',
      cwd: '/repo',
      gitStatus: { branch: 'main', dirty: 0, ahead: 0, behind: 0 },
      daemonConnected: false,
      error: null,
      interaction: { id: 'ap-1', kind: 'approval', title: 'Run `rm -rf`?' },
      picker: null,
      theme: 'mono',
      execMode: 'auto',
    };
    const controller = {
      getSnapshot: () => snapshot,
      subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
      submit: async () => undefined,
      cancel: () => undefined,
      clearDisplay: () => undefined,
      dispose: async () => undefined,
      respondToInteraction: async () => undefined,
    };
    const handle = Silvery.render(
      React.createElement(PushSurface, { controller, hook }),
      { stdout, stdin },
      { exitOnCtrlC: false, alternateScreen: false, mode: 'fullscreen', mouse: true },
    );
    const lifecycle = handle.run();
    const instance = await handle;
    await sleep(50);

    // Modal is painted, and the composer is reported inactive by the hook —
    // the single source of truth the TextArea's isActive prop reads.
    assert.equal(hook.getState().inputActive, false);
    hook.setComposerInput('/mo');
    await sleep(30);
    hook.complete();
    assert.deepEqual(hook.getComposerState(), {
      input: '/mo',
      completion: { items: ['/model'], index: -1 },
    });
    assert.equal(hook.getMotionState().attention, true);
    await sleep(180);
    assert.equal(hook.getMotionState().attention, false);

    instance.unmount();
    await lifecycle;
  });

  it('opens the model picker on bare /model and switches on select', async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'model-picker-session',
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
    let savedConfig;
    const controller = await createSilveryController(
      { sessionId: state.sessionId },
      {
        loadConfig: async () => ({ safeExecPatterns: [], ollama: { model: 'test-model' } }),
        saveConfig: async (next) => {
          savedConfig = next;
          return '/tmp/push-config.json';
        },
        useDaemon: false,
        initSession: async () => state,
        gitStatus: async () => ({ branch: 'main', dirty: 0, ahead: 0, behind: 0 }),
        saveState: async () => undefined,
        appendEvent: async () => undefined,
        resolveKey: () => 'test-key',
      },
    );

    // Bare /model must open a navigable picker, not print a numbered list.
    await controller.submit('/model');
    const picker = controller.getSnapshot().picker;
    assert.ok(picker, 'bare /model opens a picker');
    assert.equal(picker.kind, 'model');
    assert.ok(picker.options.length > 0, 'model picker has curated options');
    assert.equal(
      controller.getSnapshot().rows.some((row) => /^\d+\.\s/.test(row.text)),
      false,
      'no numbered-list status output when the picker opens',
    );

    const target = picker.options[0].id;
    controller.selectPickerOption(target);
    // selectPickerOption is fire-and-forget; the picker is held open until the
    // switch fully lands, so picker === null is the definitive settle signal.
    for (let i = 0; i < 200 && controller.getSnapshot().picker !== null; i++) await sleep(0);

    assert.equal(controller.getSnapshot().picker, null, 'selecting closes the picker');
    assert.equal(state.model, target);
    assert.equal(controller.getSnapshot().model, target);
    assert.equal(savedConfig?.ollama?.model, target);
    assert.ok(
      controller
        .getSnapshot()
        .rows.some((row) => row.text.includes(`Model switched to: ${target}`)),
    );
    await controller.dispose();
  });

  it('opens the provider picker, marks current, and holds on a keyless option', async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const savedEnv = { ...process.env };
    // Clear provider keys so key-requiring providers are deterministically
    // disabled regardless of the developer's shell / CI secrets.
    for (const key of Object.keys(process.env)) {
      if (/API_KEY$/.test(key)) delete process.env[key];
    }
    try {
      const state = {
        sessionId: 'provider-picker-session',
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
        { sessionId: state.sessionId },
        {
          loadConfig: async () => ({ safeExecPatterns: [] }),
          saveConfig: async () => '/tmp/push-config.json',
          useDaemon: false,
          initSession: async () => state,
          gitStatus: async () => ({ branch: 'main', dirty: 0, ahead: 0, behind: 0 }),
          saveState: async () => undefined,
          appendEvent: async () => undefined,
        },
      );

      await controller.submit('/provider');
      const picker = controller.getSnapshot().picker;
      assert.ok(picker, 'bare /provider opens a picker');
      assert.equal(picker.kind, 'provider');
      const current = picker.options.find((option) => option.id === 'ollama');
      assert.ok(current, 'the active provider is listed');
      assert.equal(current.current, true, 'the active provider is marked current');
      assert.equal(picker.initialIndex, picker.options.indexOf(current), 'cursor opens on current');

      const disabled = picker.options.find((option) => option.disabled);
      assert.ok(disabled, 'a key-requiring provider without a key is disabled');
      assert.equal(disabled.hint, 'no key');

      // Selecting a disabled (keyless) option keeps the picker open and explains why.
      controller.selectPickerOption(disabled.id);
      await sleep(10);
      assert.ok(controller.getSnapshot().picker, 'a disabled option keeps the picker open');
      assert.ok(controller.getSnapshot().rows.some((row) => /needs an API key/.test(row.text)));

      // Escape-equivalent: closePicker dismisses without switching.
      controller.closePicker();
      assert.equal(controller.getSnapshot().picker, null, 'closePicker dismisses the picker');
      assert.equal(state.provider, 'ollama', 'no switch happened');
      await controller.dispose();
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in savedEnv)) delete process.env[key];
      }
      Object.assign(process.env, savedEnv);
    }
  });

  it('re-selecting the current provider preserves a free-text model (no reset)', async () => {
    // The picker opens its cursor on the current provider, so a bare Enter runs
    // the switch path against the active provider. Exercised here via the direct
    // /provider command (which shares applyProviderSwitch and, unlike the picker,
    // bypasses the keyless-guard so the no-op branch is reached deterministically).
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'provider-noop-session',
      messages: [{ role: 'system', content: 'system' }],
      eventSeq: 0,
      updatedAt: Date.now(),
      cwd: '/repo',
      provider: 'ollama',
      // A CLI/free-text model that is NOT the saved-config or provider-default model.
      model: 'my-custom-free-text-model',
      rounds: 0,
      sessionName: '',
      workingMemory: {},
      mode: 'tui',
    };
    let savedConfig;
    const controller = await createSilveryController(
      { sessionId: state.sessionId },
      {
        loadConfig: async () => ({
          safeExecPatterns: [],
          ollama: { model: 'saved-default-model' },
        }),
        saveConfig: async (next) => {
          savedConfig = next;
          return '/tmp/push-config.json';
        },
        useDaemon: false,
        initSession: async () => state,
        gitStatus: async () => ({ branch: 'main', dirty: 0, ahead: 0, behind: 0 }),
        saveState: async () => undefined,
        appendEvent: async () => undefined,
        resolveKey: () => 'test-key',
      },
    );

    await controller.submit('/provider ollama');

    assert.equal(state.model, 'my-custom-free-text-model', 'model must not be reset');
    assert.equal(controller.getSnapshot().model, 'my-custom-free-text-model');
    assert.equal(savedConfig, undefined, 'a no-op provider select must not rewrite config');
    assert.ok(
      controller.getSnapshot().rows.some((row) => /Already on provider ollama/.test(row.text)),
    );
    await controller.dispose();
  });

  it('renders the picker modal and gates the composer while it is open', {
    skip: silverySkip,
  }, async () => {
    const React = (await import('react')).default;
    const Silvery = await import('silvery');
    const { PushSurface } = await import('../silvery/surface.tsx');
    const stdout = new FakeStdout(72, 18);
    const stdin = new FakeStdin();
    const hook = {};
    const listeners = new Set();
    const selected = [];
    const snapshot = {
      rows: [{ id: '0', role: 'user', text: 'pick a model' }],
      running: false,
      startedAt: null,
      provider: 'ollama',
      model: 'test-model',
      cwd: '/repo',
      gitStatus: { branch: 'main', dirty: 0, ahead: 0, behind: 0 },
      daemonConnected: false,
      error: null,
      interaction: null,
      picker: {
        kind: 'model',
        title: 'Switch model · ollama',
        options: [
          { id: 'model-alpha', label: 'model-alpha', current: true },
          { id: 'model-beta', label: 'model-beta', current: false },
        ],
        initialIndex: 0,
        token: 1,
      },
      theme: 'mono',
      execMode: 'auto',
    };
    const controller = {
      getSnapshot: () => snapshot,
      subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
      submit: async () => undefined,
      cancel: () => undefined,
      clearDisplay: () => undefined,
      dispose: async () => undefined,
      openPicker: () => undefined,
      closePicker: () => undefined,
      selectPickerOption: (id) => selected.push(id),
    };
    const handle = Silvery.render(
      React.createElement(PushSurface, { controller, hook }),
      { stdout, stdin },
      { exitOnCtrlC: false, alternateScreen: false, mode: 'fullscreen', mouse: true },
    );
    const lifecycle = handle.run();
    const instance = await handle;
    await sleep(180);

    assert.match(stdout.bytes, /Switch model/);
    assert.match(stdout.bytes, /model-alpha/);
    assert.match(stdout.bytes, /model-beta/);
    // The current model wears the ·current badge.
    assert.match(stdout.bytes, /current/);
    // Composer is inert while the picker holds focus (hidden-but-interactive class).
    assert.equal(hook.getState().pickerOpen, true);
    assert.equal(hook.getState().inputActive, false);

    instance.unmount();
    await lifecycle;
  });

  it('keeps silvery as the only full-screen product renderer', async () => {
    const result = await launchTui(
      { sessionId: 'silvery-default' },
      {
        nodeMajor: 24,
        log: () => undefined,
        loadSilvery: async () => ({ runTuiSilvery: async () => 0 }),
      },
    );
    assert.equal(result, 0);
  });

  // The regression this exists for: `osc52Copy` was written, unit-tested, and
  // had ZERO production callers — the clipboard primitive looked done from the
  // inside because its own tests passed. Asserting the escape actually reaches
  // stdout is the only check that can tell "copy works" from "copy is a
  // function nobody calls."
  it('copyLastResponse writes the OSC 52 escape to the real stdout', {
    skip: silverySkip,
  }, async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const writes = [];
    const state = {
      sessionId: 'copy-session',
      messages: [
        { role: 'system', content: 'system' },
        { role: 'user', content: 'what is the answer' },
        { role: 'assistant', content: 'the answer is 42' },
      ],
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
      { sessionId: state.sessionId },
      {
        loadConfig: async () => ({ safeExecPatterns: [] }),
        useDaemon: false,
        initSession: async () => state,
        gitStatus: async () => ({ branch: 'main', dirty: 0, ahead: 0, behind: 0 }),
        resolveKey: () => '',
        appendEvent: async () => undefined,
        saveState: async () => undefined,
        io: {
          stdin: process.stdin,
          stdout: { write: (chunk) => writes.push(String(chunk)) },
          stderr: { write: () => true },
          exit: () => undefined,
          addSignalHandler: () => undefined,
          removeSignalHandler: () => undefined,
        },
      },
    );

    controller.copyLastResponse();

    const osc = writes.find((w) => w.startsWith('\x1b]52;c;'));
    assert.ok(osc, `expected an OSC 52 write, got ${JSON.stringify(writes)}`);
    const b64 = osc.slice('\x1b]52;c;'.length, -1);
    assert.equal(Buffer.from(b64, 'base64').toString('utf8'), 'the answer is 42');

    // And the outcome is reported — OSC 52 has no delivery receipt, so a silent
    // copy is indistinguishable from a broken one.
    const status = controller.getSnapshot().rows.filter((r) => r.kind === 'status');
    assert.ok(
      status.some((r) => /Copied response to clipboard/.test(r.text)),
      `expected a copy status row, got ${JSON.stringify(status.map((r) => r.text))}`,
    );

    await controller.dispose();
  });

  it('copyLastResponse says so when there is nothing to copy', {
    skip: silverySkip,
  }, async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const writes = [];
    const controller = await createSilveryController(
      { sessionId: 'copy-empty' },
      {
        loadConfig: async () => ({ safeExecPatterns: [] }),
        useDaemon: false,
        initSession: async () => ({
          sessionId: 'copy-empty',
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
        }),
        gitStatus: async () => ({ branch: 'main', dirty: 0, ahead: 0, behind: 0 }),
        resolveKey: () => '',
        appendEvent: async () => undefined,
        saveState: async () => undefined,
        io: {
          stdin: process.stdin,
          stdout: { write: (chunk) => writes.push(String(chunk)) },
          stderr: { write: () => true },
          exit: () => undefined,
          addSignalHandler: () => undefined,
          removeSignalHandler: () => undefined,
        },
      },
    );

    controller.copyLastResponse();

    assert.equal(
      writes.some((w) => w.startsWith('\x1b]52;c;')),
      false,
      'must not send an empty clipboard payload',
    );
    assert.ok(
      controller.getSnapshot().rows.some((r) => /Nothing to copy/.test(r.text)),
      'the user must be told, not left wondering whether it worked',
    );

    await controller.dispose();
  });
});
