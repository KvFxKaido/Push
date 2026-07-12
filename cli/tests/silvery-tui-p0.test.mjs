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
});
