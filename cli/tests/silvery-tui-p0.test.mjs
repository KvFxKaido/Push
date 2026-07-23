import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';

import { launchTui } from '../cli.ts';
import {
  createVirtualTerminalFrameReader,
  createVirtualTerminalReplay,
  waitForVirtualTerminalFrame,
} from './silvery-test-helpers.mjs';

// The P0 harness is the enforcement lane for the optional production checker.
// Outside tests the same env flag reports structured diagnostics without
// turning a development terminal into an exception boundary.
process.env.PUSH_TUI_ASSERT = '1';

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
    this.chunks = [];
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

  destroy() {
    return this;
  }

  read() {
    return this.chunks.shift() ?? null;
  }

  send(chunk) {
    this.chunks.push(String(chunk));
    this.emit('readable');
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

    // Host compile + three cross-compiles, twice: the pinned cli-binary job
    // and the next-Bun smoke job (cli-binary-next-bun) mirror each other.
    assert.equal(
      compileLines.length,
      8,
      'expected host compile plus three cross-compiles in both cli-binary and cli-binary-next-bun',
    );
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
    assert.equal(resolveComposerShortcut('r', { ctrl: true }), 'session');
    assert.equal(resolveComposerShortcut('g', { ctrl: true }), 'reasoning');
    assert.equal(resolveComposerShortcut('p', {}), null);
  });

  it('keeps the reasoning modal on a terminal-safe live tail', {
    skip: silverySkip,
  }, async () => {
    const { reasoningTailWindow } = await import('../silvery/surface.tsx');
    const tail = reasoningTailWindow(
      `old line\n${'wide '.repeat(5)}\n\u001b[2Jnew line\u0007\u0085`,
      12,
      3,
    );
    assert.ok(tail.hidden > 0, 'long reasoning should report hidden rows above');
    assert.match(tail.lines.join('\n'), /new line/);
    assert.ok(!tail.lines.join('').includes('\u001b'), 'ANSI controls must not reach the modal');
    assert.ok(
      !tail.lines.join('').includes('\u0007'),
      'terminal controls must not reach the modal',
    );
    assert.ok(!tail.lines.join('').includes('\u0085'), 'C1 controls must not reach the modal');
  });

  it('advertises only launch shortcuts backed by a real binding (honest surface)', {
    skip: silverySkip,
  }, async () => {
    const { LAUNCH_SHORTCUTS, resolveComposerShortcut, handleTuiInterrupt } = await import(
      '../silvery/surface.tsx'
    );

    // No two rows claim the same key; every label/key is non-empty.
    const keys = LAUNCH_SHORTCUTS.map((s) => s.keys);
    assert.equal(new Set(keys).size, keys.length, 'duplicate launch-shortcut key advertised');
    for (const s of LAUNCH_SHORTCUTS) {
      assert.ok(s.label.length > 0 && s.keys.length > 0, 'empty launch-shortcut label/key');
    }

    // The composer-chord rows must resolve to the action they advertise — the
    // launch panel cannot promise a chord the composer does not honor.
    const ctrlLetter = (spec) => /^ctrl\+([a-z])$/.exec(spec)?.[1] ?? null;
    for (const s of LAUNCH_SHORTCUTS.filter(
      (s) => s.action === 'session' || s.action === 'palette',
    )) {
      const letter = ctrlLetter(s.keys);
      assert.ok(letter, `${s.label} should advertise a ctrl+<letter> chord, got ${s.keys}`);
      assert.equal(
        resolveComposerShortcut(letter, { ctrl: true }),
        s.action,
        `${s.keys} does not resolve to ${s.action}`,
      );
    }

    // Quit is the idle-Ctrl+C exit path (handleTuiInterrupt), not a composer chord.
    const quit = LAUNCH_SHORTCUTS.find((s) => s.action === 'quit');
    assert.equal(quit?.keys, 'ctrl+c');
    let exits = 0;
    handleTuiInterrupt(
      false,
      () => {},
      () => exits++,
    );
    assert.equal(exits, 1, 'quit row must map to the idle Ctrl+C exit');

    // Help is the empty-composer `?` trigger (changeComposerInput submits /help).
    assert.equal(LAUNCH_SHORTCUTS.find((s) => s.action === 'help')?.keys, '?');
  });

  it('renders launch shortcuts only when the composer can honor them', {
    skip: silverySkip,
  }, async () => {
    const React = (await import('react')).default;
    const Silvery = await import('silvery');
    const { LaunchScreen } = await import('../silvery/surface.tsx');
    const renderLaunch = (height, showShortcuts) =>
      Silvery.renderString(
        // Static frame (tick 0, animate off) — plain render strips color anyway,
        // so the shimmer is irrelevant to these text/layout assertions.
        React.createElement(LaunchScreen, {
          width: 72,
          height,
          showShortcuts,
          tick: 0,
          animate: false,
        }),
        { width: 72, height, plain: true },
      );

    const interactive = await renderLaunch(18, true);
    assert.match(interactive, /Resume session/);
    assert.match(interactive, /ctrl\+r/);
    assert.match(interactive, /Command palette/);
    assert.match(interactive, /ctrl\+k/);

    const composerUnavailable = await renderLaunch(18, false);
    assert.doesNotMatch(composerUnavailable, /Resume session|Command palette|Help|Quit/);

    const exactFit = await renderLaunch(14, true);
    assert.match(exactFit, /Resume session/);
    assert.match(exactFit, /Quit/);

    const shortViewport = await renderLaunch(13, true);
    assert.ok(shortViewport.trim().length > 0, 'the mark should still fit without the panel');
    assert.doesNotMatch(shortViewport, /Resume session|Command palette|Help|Quit/);
  });

  it('shimmers only when the launch screen is genuinely foreground', {
    skip: silverySkip,
  }, async () => {
    const { isLaunchShimmerActive } = await import('../silvery/surface.tsx');
    const foreground = {
      emptyTranscript: true,
      reducedMotion: false,
      running: false,
      modalOpen: false,
      draftLength: 0,
    };
    // The one state that breathes: empty transcript, no modal, no draft, running
    // nothing, motion on.
    assert.equal(isLaunchShimmerActive(foreground), true);
    // Every disqualifier freezes it — a modal open over the mark, a draft in the
    // composer, an in-flight turn, reduced motion, or a non-empty transcript.
    assert.equal(isLaunchShimmerActive({ ...foreground, modalOpen: true }), false);
    assert.equal(isLaunchShimmerActive({ ...foreground, draftLength: 3 }), false);
    assert.equal(isLaunchShimmerActive({ ...foreground, running: true }), false);
    assert.equal(isLaunchShimmerActive({ ...foreground, reducedMotion: true }), false);
    assert.equal(isLaunchShimmerActive({ ...foreground, emptyTranscript: false }), false);
  });

  it('shimmers the idle launch mark, and quiesces only under reduced motion (law 8/10)', {
    skip: silverySkip,
  }, async () => {
    const React = (await import('react')).default;
    const Silvery = await import('silvery');
    const { PushSurface } = await import('../silvery/surface.tsx');
    const snapshot = {
      rows: [],
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
      configEditor: null,
      theme: 'mono',
      execMode: 'auto',
    };
    const controller = {
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      submit: async () => undefined,
      cancel: () => undefined,
      clearDisplay: () => undefined,
      openPicker: () => undefined,
      takePendingComposerText: () => null,
      dispose: async () => undefined,
    };

    // Mount the idle launch screen under a given reduced-motion setting and
    // return how many bytes it painted AFTER the initial frame settled — the
    // repaint volume over a 400ms window (≈2–3 shimmer ticks).
    const repaintAfterSettle = async (reduced) => {
      const stdout = new FakeStdout(72, 24);
      const stdin = new FakeStdin();
      const previousPush = process.env.PUSH_REDUCED_MOTION;
      const previousAlias = process.env.REDUCED_MOTION;
      const previousForce = process.env.FORCE_COLOR;
      process.env.PUSH_REDUCED_MOTION = reduced ? '1' : '0';
      process.env.REDUCED_MOTION = reduced ? '1' : '0';
      // Force truecolor so the shimmer's per-tick color change actually reaches
      // the byte stream — otherwise a color-stripped frame is identical each tick
      // and the "it repaints" signal would vanish for reasons unrelated to motion.
      process.env.FORCE_COLOR = '3';
      let instance;
      let lifecycle;
      try {
        const handle = Silvery.render(
          React.createElement(PushSurface, { controller }),
          { stdout, stdin },
          { exitOnCtrlC: false, alternateScreen: false, mode: 'fullscreen', mouse: true },
        );
        lifecycle = handle.run();
        instance = await handle;
        await sleep(250);
        assert.match(stdout.bytes, /Resume session/);
        const settledBytes = stdout.bytes.length;
        await sleep(400);
        return stdout.bytes.length - settledBytes;
      } finally {
        instance?.unmount();
        if (lifecycle) await lifecycle;
        if (previousPush === undefined) delete process.env.PUSH_REDUCED_MOTION;
        else process.env.PUSH_REDUCED_MOTION = previousPush;
        if (previousAlias === undefined) delete process.env.REDUCED_MOTION;
        else process.env.REDUCED_MOTION = previousAlias;
        if (previousForce === undefined) delete process.env.FORCE_COLOR;
        else process.env.FORCE_COLOR = previousForce;
      }
    };

    // Reduced motion: the launch clock never starts — the screen is fully
    // quiescent, no repaint without a state change (the invariant worth keeping).
    assert.equal(
      await repaintAfterSettle(true),
      0,
      'reduced-motion launch screen repainted without a state change',
    );
    // Motion on: the mark is the idle state's single live animation, so the
    // screen DOES keep repainting the shimmer. This is the wiring guard — a pure
    // shimmer that is never ticked would pass its unit tests and animate nothing.
    assert.ok(
      (await repaintAfterSettle(false)) > 0,
      'launch shimmer never repainted the idle screen',
    );
  });

  it('diverts secret-setting config commands before the composer accepts a key', {
    skip: silverySkip,
  }, async () => {
    const { resolveSensitiveConfigComposerTarget } = await import('../silvery/surface.tsx');
    const providers = ['ollama', 'zen', 'openai'];
    assert.equal(
      resolveSensitiveConfigComposerTarget('/config key', 'ollama', providers),
      'ollama',
    );
    assert.equal(
      resolveSensitiveConfigComposerTarget('/config key zen sk-plaintext', 'ollama', providers),
      'zen',
    );
    assert.equal(
      resolveSensitiveConfigComposerTarget('/config key sk-plaintext', 'ollama', providers),
      'ollama',
    );
    assert.equal(
      resolveSensitiveConfigComposerTarget('/config tavily tvly-plaintext', 'ollama', providers),
      'tavily',
    );
    assert.equal(
      resolveSensitiveConfigComposerTarget('/config url https://example.test', 'ollama', providers),
      null,
    );
  });

  it('keeps session previews to six recent human/assistant messages', async () => {
    const { sessionPreviewMessages } = await import('../silvery/controller.ts');
    const messages = [
      { role: 'system', content: 'system' },
      { role: 'user', content: '  [TOOL_RESULT]\n{}\n[/TOOL_RESULT]' },
      ...Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message-${index}`,
      })),
    ];

    assert.deepEqual(
      sessionPreviewMessages(messages),
      Array.from({ length: 6 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `message-${index + 2}`,
      })),
    );
  });

  it('rebinds the daemon controller to a new durable session from seq zero', async () => {
    const { createDaemonSession } = await import('../tui-daemon-session.ts');
    const { PROTOCOL_VERSION } = await import('../../lib/protocol-schema.ts');
    let durable = {
      persisted: true,
      sessionId: 'sess_old_abc123',
      attachToken: 'old-token',
    };
    const attachRequests = [];
    const client = {
      connected: true,
      request: async (type, payload) => {
        if (type === 'hello') {
          return {
            payload: {
              runtimeName: 'pushd',
              runtimeVersion: 'test',
              protocolVersion: PROTOCOL_VERSION,
              capabilities: [],
            },
          };
        }
        if (type === 'attach_session') {
          attachRequests.push(payload);
          return { payload: { attachToken: `adopted-${payload.sessionId}` } };
        }
        return { payload: {} };
      },
      onEvent: () => () => undefined,
      close: () => undefined,
      _socket: { on: () => undefined },
    };
    const daemon = createDaemonSession(
      {
        tryConnectTransport: async () => client,
        note: () => undefined,
        markFooterDirty: () => undefined,
        markAllDirty: () => undefined,
        onEngineEvent: () => undefined,
        onSocketClose: () => undefined,
        isAutoStartEnabled: () => false,
        spawnDaemon: async () => ({
          status: 'already-running',
          ready: false,
          socketPath: '',
          logPath: '',
        }),
        onReusedDaemon: async () => undefined,
        appendDaemonLogTail: async () => undefined,
        getDurableSession: () => durable,
        setDurableAttachToken: (token) => {
          durable.attachToken = token;
        },
        getStartSessionPayload: () => ({ provider: 'zen', model: 'model', cwd: '/repo' }),
        onAttached: () => undefined,
        invalidateReconnectAnimators: () => undefined,
      },
      [],
    );

    assert.equal(await daemon.tryConnect(), true);
    assert.equal(await daemon.attachExistingSession(), true);
    daemon.noteSeenSeq(41);
    durable = {
      persisted: true,
      sessionId: 'sess_new_abc123',
      attachToken: 'new-token',
    };

    assert.equal(await daemon.rebindExistingSession(), true);
    assert.equal(daemon.sessionId, 'sess_new_abc123');
    assert.equal(daemon.attachToken, 'adopted-sess_new_abc123');
    assert.deepEqual(attachRequests, [
      {
        sessionId: 'sess_old_abc123',
        lastSeenSeq: 0,
        attachToken: 'old-token',
        capabilities: [],
      },
      {
        sessionId: 'sess_new_abc123',
        lastSeenSeq: 0,
        attachToken: 'new-token',
        capabilities: [],
      },
    ]);
    daemon.teardown();
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
    assert.equal(controller.getSnapshot().configEditor?.items[0]?.id, 'ollama');
    assert.equal(controller.getSnapshot().configEditor?.items[0]?.value, '********');
    assert.deepEqual(
      controller
        .getSnapshot()
        .configEditor?.items.filter((item) => item.kind !== 'secret')
        .map((item) => item.id),
      ['sandbox', 'execMode', 'explain', 'daemon'],
    );
    assert.equal(JSON.stringify(controller.getSnapshot()).includes('test-key'), false);
    assert.equal(savedConfig?.ollama?.model, 'test-model-2');
    await controller.dispose();
  });

  it('keeps existing and pasted API keys out of snapshots and the composer command path', async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const previousZenKey = process.env.PUSH_ZEN_API_KEY;
    const previousExplainMode = process.env.PUSH_EXPLAIN_MODE;
    const previousSandboxBackend = process.env.PUSH_LOCAL_SANDBOX;
    const existingKey = 'sk-existing-plaintext-1234';
    const pastedKey = 'sk-pasted-on-composer-9999';
    const replacementKey = 'sk-new-secret-5678';
    const rejectedKey = 'sk-rejected-secret-1357';
    delete process.env.PUSH_ZEN_API_KEY;
    const state = {
      sessionId: 'config-security-session',
      messages: [{ role: 'system', content: 'system' }],
      eventSeq: 0,
      updatedAt: Date.now(),
      cwd: '/repo',
      provider: 'zen',
      model: 'test-model',
      rounds: 0,
      sessionName: '',
      workingMemory: {},
      mode: 'tui',
    };
    const saves = [];
    const daemonRequests = [];
    let rejectSave = false;
    let rejectDaemonSandbox = false;
    let controller;
    try {
      controller = await createSilveryController(
        { sessionId: state.sessionId },
        {
          loadConfig: async () => ({
            safeExecPatterns: [],
            provider: 'zen',
            zen: { apiKey: existingKey, model: 'test-model' },
          }),
          saveConfig: async (next) => {
            if (rejectSave) throw new Error(`could not persist ${next.zen?.apiKey}`);
            saves.push(structuredClone(next));
            return '/tmp/push-config.json';
          },
          useDaemon: false,
          initSession: async () => state,
          gitStatus: async () => ({ branch: 'main', dirty: 0, ahead: 0, behind: 0 }),
          saveState: async () => undefined,
          createDaemon: () => ({
            connected: true,
            sessionId: state.sessionId,
            attachToken: 'attach-token',
            client: {
              connected: true,
              request: async (type, payload) => {
                daemonRequests.push([type, payload]);
                if (
                  rejectDaemonSandbox &&
                  type === 'set_daemon_runtime_config' &&
                  payload.patch?.sandboxBackend
                ) {
                  throw new Error('pushd unavailable');
                }
                if (type === 'get_daemon_runtime_config') {
                  return { payload: { execMode: 'auto' } };
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
          }),
        },
      );

      await controller.submit('/config');
      let snapshotText = JSON.stringify(controller.getSnapshot());
      const zenItem = controller
        .getSnapshot()
        .configEditor?.items.find((item) => item.id === 'zen');
      assert.equal(zenItem?.value, 'sk-e...1234');
      assert.equal(snapshotText.includes(existingKey), false);

      controller.closeConfigEditor();
      await controller.submit(`/config key ${pastedKey}`);
      snapshotText = JSON.stringify(controller.getSnapshot());
      assert.equal(controller.getSnapshot().configEditor?.initialEditTarget, 'zen');
      assert.equal(saves.length, 0, 'legacy command tails must not persist a plaintext key');
      assert.equal(snapshotText.includes(pastedKey), false);

      assert.equal(await controller.saveConfigSecret('zen', replacementKey), true);
      snapshotText = JSON.stringify(controller.getSnapshot());
      assert.equal(saves.at(-1)?.zen?.apiKey, replacementKey);
      assert.equal(snapshotText.includes(replacementKey), false);
      assert.equal(
        controller.getSnapshot().configEditor?.items.find((item) => item.id === 'zen')?.value,
        'sk-n...5678',
      );
      assert.ok(daemonRequests.some(([type]) => type === 'reload_config'));
      assert.equal(
        controller.getSnapshot().rows.some((row) => row.text.includes(replacementKey)),
        false,
      );

      assert.equal(await controller.saveConfigPreference('explain', 'on'), true);
      assert.equal(saves.at(-1)?.explainMode, true);
      assert.equal(
        controller.getSnapshot().configEditor?.items.find((item) => item.id === 'explain')?.value,
        'on',
      );

      assert.equal(await controller.saveConfigPreference('sandbox', 'docker'), true);
      assert.equal(saves.at(-1)?.localSandbox, 'docker');
      assert.equal(process.env.PUSH_LOCAL_SANDBOX, 'docker');
      assert.ok(
        daemonRequests.some(
          ([type, payload]) =>
            type === 'set_daemon_runtime_config' && payload.patch?.sandboxBackend === 'docker',
        ),
      );

      rejectDaemonSandbox = true;
      assert.equal(await controller.saveConfigPreference('sandbox', 'native'), true);
      assert.ok(
        controller
          .getSnapshot()
          .rows.some((row) =>
            row.text.includes('Restart pushd to apply it to daemon-backed exec.'),
          ),
      );

      rejectSave = true;
      assert.equal(await controller.saveConfigSecret('zen', rejectedKey), false);
      snapshotText = JSON.stringify(controller.getSnapshot());
      assert.equal(snapshotText.includes(rejectedKey), false);
      assert.equal(
        controller.getSnapshot().configEditor?.error?.startsWith('Failed to save'),
        true,
      );
      assert.equal(
        controller.getSnapshot().configEditor?.items.find((item) => item.id === 'zen')?.value,
        'sk-n...5678',
      );

      // The in-memory rollback, made observable. The display above stays correct
      // by not refreshing on failure — but `config[zen].apiKey` was mutated to
      // the rejected key BEFORE persist threw. If the rollback doesn't restore
      // it, the next unrelated successful persist silently writes the rejected
      // key to disk. So: succeed at an unrelated save and assert the persisted
      // config still carries the previous key, not the rejected one.
      rejectSave = false;
      assert.equal(await controller.saveConfigPreference('explain', 'off'), true);
      assert.equal(
        saves.at(-1)?.zen?.apiKey,
        replacementKey,
        'a rejected key must not linger in config and ride out on the next persist',
      );
    } finally {
      await controller?.dispose();
      if (previousZenKey === undefined) delete process.env.PUSH_ZEN_API_KEY;
      else process.env.PUSH_ZEN_API_KEY = previousZenKey;
      if (previousExplainMode === undefined) delete process.env.PUSH_EXPLAIN_MODE;
      else process.env.PUSH_EXPLAIN_MODE = previousExplainMode;
      if (previousSandboxBackend === undefined) delete process.env.PUSH_LOCAL_SANDBOX;
      else process.env.PUSH_LOCAL_SANDBOX = previousSandboxBackend;
    }
  });

  it('opens a workspace-scoped /resume picker with a daemon-served preview', async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'sess_resume_abc123',
      messages: [{ role: 'system', content: 'system' }],
      eventSeq: 0,
      updatedAt: Date.now(),
      cwd: '/repo',
      provider: 'ollama',
      model: 'test-model',
      attachToken: 'token-sess_resume_abc123',
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
    const elsewhere = {
      ...row,
      sessionId: 'sess_elsewhere_abc123',
      cwd: '/other-repo',
      sessionName: 'elsewhere',
    };
    const second = {
      ...row,
      sessionId: 'sess_second_abc123',
      sessionName: 'second-local-session',
    };
    let daemonSessionId = state.sessionId;
    let daemonAttachToken = state.attachToken;
    let sendPayload;
    let sendSessionArg;
    const rebinds = [];
    const client = {
      request: async (type, payload, sessionId) => {
        if (type === 'list_sessions') {
          assert.equal(payload.limit, 1000);
          return { ok: true, payload: { sessions: [row, second, elsewhere] } };
        }
        if (type === 'get_session_snapshot') {
          return {
            payload: {
              transcript: { mirror: { rows: [], liveText: '', lastSeq: 0 } },
            },
          };
        }
        if (type === 'send_user_message') {
          sendPayload = payload;
          sendSessionArg = sessionId;
          queueMicrotask(() => hooks.onEngineEvent({ type: 'run_complete', payload: {} }));
          return { payload: { runId: 'run-resumed-session' } };
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
        loadState: async (sessionId) => ({
          ...state,
          sessionId,
          provider: 'zen',
          model: 'from-daemon',
          attachToken: `token-${sessionId}`,
          sessionName: 'from-daemon',
          messages: [
            { role: 'system', content: 'system' },
            { role: 'user', content: `question from ${sessionId}` },
            { role: 'assistant', content: 'The failure is in the parser.' },
          ],
        }),
        listSessions: async () => {
          listSessionsCalls += 1;
          return [];
        },
        createDaemon: (receivedHooks) => {
          hooks = receivedHooks;
          return {
            connected: true,
            get sessionId() {
              return daemonSessionId;
            },
            get attachToken() {
              return daemonAttachToken;
            },
            client,
            ensureConnected: async () => true,
            ensureReady: async () => true,
            ensureSession: async () => undefined,
            rebindExistingSession: async () => {
              const durable = hooks.getDurableSession();
              rebinds.push({ ...durable });
              daemonSessionId = durable.sessionId;
              daemonAttachToken = durable.attachToken;
              return true;
            },
            noteSeenSeq: () => undefined,
            scheduleReconnect: () => undefined,
            teardown: () => undefined,
          };
        },
      },
    );

    await controller.submit('/resume');
    assert.equal(listSessionsCalls, 0, 'must not fall back to disk when RPC succeeds');
    const picker = controller.getSnapshot().picker;
    assert.ok(picker, 'bare /resume opens the picker');
    assert.equal(picker.kind, 'session');
    assert.equal(picker.scope, 'workspace');
    assert.equal(picker.scopedOutCount, 1);
    assert.deepEqual(
      picker.options.map((option) => option.id),
      ['sess_daemonrow_abc123', 'sess_second_abc123'],
      'the other workspace stays out of the default view',
    );
    assert.deepEqual(picker.preview?.messages, [
      { role: 'user', content: 'question from sess_daemonrow_abc123' },
      { role: 'assistant', content: 'The failure is in the parser.' },
    ]);

    controller.previewPickerOption('sess_second_abc123');
    for (
      let i = 0;
      i < 50 &&
      (controller.getSnapshot().picker.preview?.optionId !== 'sess_second_abc123' ||
        controller.getSnapshot().picker.preview?.loading);
      i++
    )
      await sleep(0);
    assert.deepEqual(controller.getSnapshot().picker.preview?.messages, [
      { role: 'user', content: 'question from sess_second_abc123' },
      { role: 'assistant', content: 'The failure is in the parser.' },
    ]);

    controller.toggleSessionPickerScope();
    assert.equal(controller.getSnapshot().picker.scope, 'all');
    assert.deepEqual(
      controller.getSnapshot().picker.options.map((option) => option.id),
      ['sess_daemonrow_abc123', 'sess_second_abc123', 'sess_elsewhere_abc123'],
    );

    controller.selectPickerOption('sess_second_abc123');
    for (let i = 0; i < 50 && controller.getSnapshot().picker !== null; i++) await sleep(0);
    assert.equal(controller.getSnapshot().picker, null, 'resuming closes the picker');
    assert.equal(controller.getSnapshot().sessionId, 'sess_second_abc123');
    assert.deepEqual(rebinds, [
      {
        persisted: true,
        sessionId: 'sess_second_abc123',
        attachToken: 'token-sess_second_abc123',
      },
    ]);
    assert.ok(controller.getSnapshot().rows.some((item) => /Resumed session/.test(item.text)));

    await controller.submit('continue in the selected session');
    assert.equal(sendPayload.sessionId, 'sess_second_abc123');
    assert.equal(sendPayload.attachToken, 'token-sess_second_abc123');
    assert.equal(sendSessionArg, 'sess_second_abc123');
    await controller.dispose();
  });

  it('rolls back to the previous session when the daemon rejects the resume attach', async () => {
    // Codex's rollback claim, made falsifiable: a failed rebind must leave you
    // on the session you were already in — not stranded half-switched (new
    // session in `state`, daemon detached). Mutation: drop the
    // `replaceSessionState(previousState)` restore and this goes red.
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'sess_origin_current',
      messages: [{ role: 'system', content: 'system' }],
      eventSeq: 0,
      updatedAt: Date.now(),
      cwd: '/repo',
      provider: 'ollama',
      model: 'origin-model',
      attachToken: 'token-origin',
      rounds: 0,
      sessionName: 'origin',
      workingMemory: {},
      mode: 'tui',
    };
    const target = {
      sessionId: 'sess_target_abc123',
      updatedAt: Date.now(),
      provider: 'zen',
      model: 'from-daemon',
      cwd: '/repo',
      sessionName: 'target',
      mode: 'tui',
    };
    let hooks;
    let rebindCalls = 0;
    // First rebind (attach the target) fails; the rollback re-attach succeeds.
    const rebindResults = [false, true];
    const client = {
      request: async (type) => {
        if (type === 'list_sessions') return { ok: true, payload: { sessions: [target] } };
        if (type === 'get_session_snapshot')
          return { payload: { transcript: { mirror: { rows: [], liveText: '', lastSeq: 0 } } } };
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
        loadState: async (sessionId) => ({
          ...state,
          sessionId,
          sessionName: `loaded-${sessionId}`,
          messages: [
            { role: 'system', content: 'system' },
            { role: 'user', content: `q ${sessionId}` },
          ],
        }),
        listSessions: async () => [],
        createDaemon: (receivedHooks) => {
          hooks = receivedHooks;
          return {
            connected: true,
            get sessionId() {
              return null;
            },
            get attachToken() {
              return null;
            },
            client,
            ensureConnected: async () => true,
            ensureReady: async () => true,
            ensureSession: async () => undefined,
            rebindExistingSession: async () => rebindResults[rebindCalls++] ?? false,
            noteSeenSeq: () => undefined,
            scheduleReconnect: () => undefined,
            teardown: () => undefined,
          };
        },
      },
    );
    assert.ok(hooks);

    await controller.submit('/resume');
    controller.selectPickerOption('sess_target_abc123');
    for (let i = 0; i < 50 && controller.getSnapshot().picker !== null; i += 1) await sleep(0);

    const snap = controller.getSnapshot();
    assert.equal(
      snap.sessionId,
      'sess_origin_current',
      'a failed resume must roll back to the previous session, not strand the new one',
    );
    assert.equal(rebindCalls, 2, 'rollback re-attaches the previous session (second rebind)');
    assert.ok(
      snap.rows.some((item) => /Resume failed/.test(item.text)),
      'the failure is surfaced to the user',
    );
    await controller.dispose();
  });

  it('discards a stale preview that resolves after a newer one (out-of-order race)', async () => {
    // The "race-safe" claim, made falsifiable. The picker fires an async
    // preview load per highlighted row; move the cursor fast and two loads are
    // in flight. If the FIRST-requested one resolves LAST, it must not clobber
    // the newer preview — the row under the cursor would otherwise show a
    // different session's messages. Guarded by the `sessionPreviewRequest`
    // counter in loadSessionPickerPreview; this test controls resolution order
    // so it actually exercises that guard (mutation: drop the counter check →
    // this fails).
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'sess_race_current',
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
    const mk = (id) => ({
      sessionId: id,
      updatedAt: Date.now(),
      provider: 'zen',
      model: 'm',
      cwd: '/repo',
      sessionName: id,
      mode: 'tui',
    });
    // Deferred loadState: each call parks until `settle(id)` is called, so the
    // test picks the resolution order.
    const pending = new Map();
    const settle = (id) => {
      const resolve = pending.get(id);
      assert.ok(resolve, `no pending load for ${id}`);
      pending.delete(id);
      resolve({
        ...state,
        sessionId: id,
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: `q from ${id}` },
          { role: 'assistant', content: `a from ${id}` },
        ],
      });
    };
    const controller = await createSilveryController(
      { sessionId: state.sessionId },
      {
        loadConfig: async () => ({ safeExecPatterns: [] }),
        useDaemon: false,
        initSession: async () => state,
        gitStatus: async () => ({ branch: 'main', dirty: 0, ahead: 0, behind: 0 }),
        saveState: async () => undefined,
        loadState: (id) => new Promise((resolve) => pending.set(id, resolve)),
        listSessions: async () => [mk('sess_alpha'), mk('sess_beta')],
      },
    );

    const opened = controller.submit('/resume');
    // The initial preview loads the first option (sess_alpha); let it settle so
    // the picker is fully open before the race.
    for (let i = 0; i < 50 && !pending.has('sess_alpha'); i += 1) await sleep(0);
    settle('sess_alpha');
    await opened;

    // Two previews in flight: alpha requested first, beta second. Beta is the
    // newer request and the one the cursor lands on.
    controller.previewPickerOption('sess_alpha');
    controller.previewPickerOption('sess_beta');
    for (let i = 0; i < 50 && !(pending.has('sess_alpha') && pending.has('sess_beta')); i += 1)
      await sleep(0);

    // Resolve out of order: the newer (beta) first, then the stale (alpha).
    settle('sess_beta');
    for (let i = 0; i < 50 && controller.getSnapshot().picker.preview?.loading; i += 1)
      await sleep(0);
    settle('sess_alpha');
    for (let i = 0; i < 20; i += 1) await sleep(0);

    const preview = controller.getSnapshot().picker.preview;
    assert.equal(preview?.optionId, 'sess_beta', 'the stale alpha load clobbered the newer beta');
    assert.deepEqual(preview?.messages, [
      { role: 'user', content: 'q from sess_beta' },
      { role: 'assistant', content: 'a from sess_beta' },
    ]);
    await controller.dispose();
  });

  it('drops an in-flight preview when the picker closes (no paint after close)', async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'sess_close_current',
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
    const pending = new Map();
    const controller = await createSilveryController(
      { sessionId: state.sessionId },
      {
        loadConfig: async () => ({ safeExecPatterns: [] }),
        useDaemon: false,
        initSession: async () => state,
        gitStatus: async () => ({ branch: 'main', dirty: 0, ahead: 0, behind: 0 }),
        saveState: async () => undefined,
        loadState: (id) => new Promise((resolve) => pending.set(id, resolve)),
        listSessions: async () => [
          {
            sessionId: 'sess_only',
            updatedAt: Date.now(),
            provider: 'zen',
            model: 'm',
            cwd: '/repo',
            sessionName: 'only',
            mode: 'tui',
          },
        ],
      },
    );
    const opened = controller.submit('/resume');
    for (let i = 0; i < 50 && !pending.has('sess_only'); i += 1) await sleep(0);
    // Close before the initial preview resolves, then let it resolve.
    controller.closePicker();
    const resolve = pending.get('sess_only');
    pending.delete('sess_only');
    resolve({ ...state, sessionId: 'sess_only', messages: [{ role: 'user', content: 'late' }] });
    await opened;
    for (let i = 0; i < 20; i += 1) await sleep(0);
    assert.equal(
      controller.getSnapshot().picker,
      null,
      'a late preload must not reopen the picker',
    );
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
    const { LAUNCH_SHORTCUTS, PushSurface } = await import('../silvery/surface.tsx');
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
    const helpKey = LAUNCH_SHORTCUTS.find((shortcut) => shortcut.action === 'help')?.keys;
    assert.equal(helpKey, '?');
    hook.changeComposerInput(helpKey);
    await sleep(30);
    assert.deepEqual(submissions, ['/help']);

    instance.unmount();
    await lifecycle;
  });

  it('collapses consecutive settled tools into a semantic mixed-verb summary', {
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
          id: 'read-a',
          kind: 'tool',
          role: 'explorer',
          text: 'read_file complete',
          toolName: 'read_file',
          target: 'src/a.ts',
          pending: false,
        },
        {
          id: 'read-b',
          kind: 'tool',
          role: 'explorer',
          text: 'read_file complete',
          toolName: 'read_file',
          target: 'src/b.ts',
          pending: false,
        },
        {
          id: 'exec',
          kind: 'tool',
          role: 'coder',
          text: 'sandbox_exec complete',
          toolName: 'sandbox_exec',
          target: 'pnpm test',
          pending: false,
        },
        {
          id: 'failed',
          kind: 'tool',
          role: 'explorer',
          text: 'read_file failed',
          toolName: 'read_file',
          target: 'broken.ts',
          pending: false,
          isError: true,
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

    // Rendered row: counted where the bucket aggregates, concrete where it
    // does not. Was 'Read 2 files, Ran 1 command' — a count of one, hiding the
    // command the fixture already knew.
    assert.match(stdout.bytes, /Read 2 files, Ran pnpm test/);
    assert.match(stdout.bytes, /Read broken\.ts/);
    // Collapsing compresses REPETITION: the two reads aggregate, so their paths
    // stay folded until expanded.
    assert.doesNotMatch(stdout.bytes, /src\/a\.ts/);
    assert.doesNotMatch(stdout.bytes, /src\/b\.ts/);

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

  it('renders a clean silent command as its header row alone — no empty card box', {
    skip: silverySkip,
  }, async () => {
    // The screenshot regression, against the REAL surface: a `rm` that succeeded
    // and printed nothing must render `Ran rm …` and STOP — no "Sandbox" title,
    // no Command:/Exit Code:/Truncated:/Duration Ms: dump, no blank card line.
    const React = (await import('react')).default;
    const Silvery = await import('silvery');
    const { PushSurface } = await import('../silvery/surface.tsx');
    const stdout = new FakeStdout(72, 14);
    const stdin = new FakeStdin();
    const snapshot = {
      rows: [
        {
          id: 'exec',
          kind: 'tool',
          role: 'coder',
          text: 'sandbox_exec complete',
          toolName: 'sandbox_exec',
          target: 'rm shot.png',
          pending: false,
          resultPreview: 'exit_code: 0\nstdout: <empty>',
          card: {
            type: 'sandbox',
            data: { command: 'rm shot.png', stdout: '', stderr: '', exitCode: 0, durationMs: 57 },
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

    // The header row is the whole story.
    assert.match(stdout.bytes, /Ran rm shot\.png/);
    // None of the dumped chrome survives.
    assert.doesNotMatch(stdout.bytes, /Sandbox/);
    assert.doesNotMatch(stdout.bytes, /Command:/);
    assert.doesNotMatch(stdout.bytes, /Exit Code:/);
    assert.doesNotMatch(stdout.bytes, /Truncated:/);
    assert.doesNotMatch(stdout.bytes, /Duration Ms:/);
    // Resumed/daemon rows retain the model-facing preview alongside the card;
    // the intentionally empty typed card must still suppress that raw fallback.
    assert.doesNotMatch(stdout.bytes, /exit_code: 0/);
    assert.doesNotMatch(stdout.bytes, /stdout: <empty>/);

    instance.unmount();
    await lifecycle;
  });

  it('renders a command with output as the header plus bare output lines', {
    skip: silverySkip,
  }, async () => {
    // The has-output path: no "Sandbox" title dump, just the stdout under the
    // header. The load-bearing piece is `formatCommandCard` — swap it out and
    // this reads "Sandbox / Command: ls / …" instead.
    const React = (await import('react')).default;
    const Silvery = await import('silvery');
    const { PushSurface } = await import('../silvery/surface.tsx');
    const stdout = new FakeStdout(72, 14);
    const stdin = new FakeStdin();
    const snapshot = {
      rows: [
        {
          id: 'exec',
          kind: 'tool',
          role: 'coder',
          text: 'sandbox_exec complete',
          toolName: 'sandbox_exec',
          target: 'ls',
          pending: false,
          card: {
            type: 'sandbox',
            data: { command: 'ls', stdout: 'alpha.ts\nbeta.ts', stderr: '', exitCode: 0 },
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

    assert.match(stdout.bytes, /Ran ls/);
    assert.match(stdout.bytes, /alpha\.ts/);
    assert.match(stdout.bytes, /beta\.ts/);
    assert.doesNotMatch(stdout.bytes, /Sandbox/);
    assert.doesNotMatch(stdout.bytes, /Command:/);
    // Output sits directly under the header, on consecutive rows.
    const plain = stdout.bytes
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '\n');
    const rows = plain.split('\n').map((r) => r.trimEnd());
    const header = rows.findIndex((r) => /Ran ls/.test(r));
    assert.ok(header >= 0, 'header row not found');
    assert.match(rows[header + 1] ?? '', /alpha\.ts/);

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

  it('renders API-key drafts as bullets and submits the raw value only on save', {
    skip: silverySkip,
  }, async () => {
    const React = (await import('react')).default;
    const Silvery = await import('silvery');
    const { PushSurface } = await import('../silvery/surface.tsx');
    const stdout = new FakeStdout(90, 22);
    const stdin = new FakeStdin();
    const hook = {};
    const listeners = new Set();
    const openedTargets = [];
    const submitted = [];
    const preferences = [];
    const discardedComposerSecret = 'sk-composer-tail-never-rendered';
    const rawDraft = 'sk-raw-draft-never-rendered';
    let snapshot = {
      rows: [],
      running: false,
      startedAt: null,
      provider: 'zen',
      model: 'test-model',
      cwd: '/repo',
      gitStatus: { branch: 'main', dirty: 0, ahead: 0, behind: 0 },
      daemonConnected: false,
      error: null,
      interaction: null,
      picker: null,
      configEditor: null,
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
      selectPickerOption: () => undefined,
      openConfigEditor: (target) => {
        openedTargets.push(target);
        snapshot = {
          ...snapshot,
          configEditor: {
            items: [
              {
                id: 'zen',
                label: 'zen',
                kind: 'secret',
                value: 'sk-e...1234',
                detail: 'test-model',
                current: true,
              },
              {
                id: 'sandbox',
                label: 'sandbox',
                kind: 'select',
                value: 'host',
                detail: 'exec isolation',
                current: false,
                options: [
                  { value: 'host', label: 'host', detail: 'run directly on this machine' },
                  { value: 'docker', label: 'docker', detail: 'isolated Docker sandbox' },
                ],
              },
              {
                id: 'explain',
                label: 'explain',
                kind: 'toggle',
                value: 'off',
                detail: 'tool narration',
                current: false,
              },
            ],
            initialIndex: 0,
            initialEditTarget: target,
            token: 1,
            saving: false,
          },
        };
        for (const listener of listeners) listener();
      },
      closeConfigEditor: () => undefined,
      saveConfigSecret: async (target, secret) => {
        submitted.push([target, secret]);
        return true;
      },
      saveConfigPreference: async (target, value) => {
        preferences.push([target, value]);
        return true;
      },
    };
    const handle = Silvery.render(
      React.createElement(PushSurface, { controller, hook }),
      { stdout, stdin },
      {
        exitOnCtrlC: false,
        alternateScreen: false,
        mode: 'fullscreen',
        mouse: true,
        stdin,
      },
    );
    const lifecycle = handle.run();
    const instance = await handle;
    await sleep(420);

    assert.ok(stdin.listenerCount('readable') > 0, 'Silvery must subscribe to the fake terminal');
    stdin.send(`\x1b[200~/config key zen ${discardedComposerSecret}\x1b[201~`);
    for (let i = 0; i < 50 && openedTargets.length === 0; i += 1) await sleep(10);
    assert.deepEqual(openedTargets, ['zen']);
    assert.equal(hook.getComposerState().input, '');
    assert.equal(
      stdout.bytes.includes(discardedComposerSecret),
      false,
      'legacy command tails must never reach a frame',
    );
    await sleep(100);
    assert.match(stdout.bytes, /API key/);
    assert.match(stdout.bytes, /Current:/);
    assert.match(stdout.bytes, /sk-e\.\.\.1234/);
    stdin.send(`\x1b[200~${rawDraft}\x1b[201~`);
    await sleep(100);
    assert.equal(stdout.bytes.includes(rawDraft), false, 'raw draft must never reach a frame');
    stdin.send('\r');
    for (let i = 0; i < 50 && submitted.length === 0; i += 1) await sleep(10);
    assert.deepEqual(submitted, [['zen', rawDraft]]);
    assert.match(stdout.bytes, /••••/);
    await sleep(50);
    assert.match(stdout.bytes, /sandbox/);
    stdin.send('\x1b[B');
    stdin.send('\r');
    await sleep(50);
    assert.match(stdout.bytes, /isolated Docker sandbox/);
    stdin.send('\x1b[B');
    stdin.send('\r');
    for (let i = 0; i < 50 && preferences.length === 0; i += 1) await sleep(10);
    assert.deepEqual(preferences, [['sandbox', 'docker']]);

    instance.unmount();
    await lifecycle;
  });

  it('renders the session picker as a list plus recent-message preview pane', {
    skip: silverySkip,
  }, async () => {
    const React = (await import('react')).default;
    const Silvery = await import('silvery');
    const { PushSurface } = await import('../silvery/surface.tsx');
    const stdout = new FakeStdout(120, 28);
    const stdin = new FakeStdin();
    const snapshot = {
      rows: [],
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
        kind: 'session',
        title: 'Resume session',
        options: [
          {
            id: 'sess_preview_abc123',
            label: 'Parser investigation',
            hint: 'ollama/test-model',
            current: true,
            session: {
              sessionId: 'sess_preview_abc123',
              updatedAt: Date.now() - 120_000,
              provider: 'ollama',
              model: 'test-model',
              cwd: '/repo',
              sessionName: 'Parser investigation',
              lastUserMessage: 'Why does this parser fail?',
              mode: 'tui',
            },
          },
        ],
        initialIndex: 0,
        token: 1,
        scope: 'workspace',
        scopedOutCount: 2,
        preview: {
          optionId: 'sess_preview_abc123',
          loading: false,
          messages: [
            { role: 'user', content: 'Why does this parser fail?' },
            { role: 'assistant', content: 'The closing fence is consumed too early.' },
          ],
        },
      },
      theme: 'mono',
      execMode: 'auto',
    };
    const controller = {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
      submit: async () => undefined,
      cancel: () => undefined,
      clearDisplay: () => undefined,
      dispose: async () => undefined,
      openPicker: () => undefined,
      closePicker: () => undefined,
      selectPickerOption: () => undefined,
      previewPickerOption: () => undefined,
      toggleSessionPickerScope: () => undefined,
    };
    const handle = Silvery.render(
      React.createElement(PushSurface, { controller, hook: {} }),
      { stdout, stdin },
      { exitOnCtrlC: false, alternateScreen: false, mode: 'fullscreen', mouse: true },
    );
    const lifecycle = handle.run();
    const instance = await handle;
    await sleep(180);

    assert.match(stdout.bytes, /Resume session/);
    assert.match(stdout.bytes, /this workspace/);
    assert.match(stdout.bytes, /2 elsewhere/);
    assert.match(stdout.bytes, /Parser investigation/);
    assert.match(stdout.bytes, /Preview/);
    assert.match(stdout.bytes, /Why does this parser fail\?/);
    assert.match(stdout.bytes, /closing fence is consumed too early/);
    assert.match(stdout.bytes, /sess_preview_abc123/);
    assert.match(stdout.bytes, /Path: \/repo/);
    assert.match(stdout.bytes, /Model: ollama\/test-model/);

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

describe('silvery status verb — snapshot.activity', () => {
  // Against the REAL caller. `verbForActivity` had a full unit suite and zero
  // production callers for the whole of the Silvery era; testing the helper
  // again would reproduce exactly the blind spot that let that happen. These
  // drive `createSilveryController` through real turns and read the snapshot
  // the header renders from.
  const baseState = () => ({
    sessionId: 'verb-session',
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
  });

  const harness = async (runTurn) => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = baseState();
    const seen = [];
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
        runTurn: (receivedState, _p, _k, _text, _rounds, options) =>
          runTurn(receivedState, options, state),
      },
    );
    controller.subscribe(() => seen.push(controller.getSnapshot().activity));
    return { controller, seen, state };
  };

  const emit = (options, type, payload, sessionId) =>
    options.emit({ type, payload, runId: 'run-1', sessionId });

  it('is null when idle, before and after a turn', async () => {
    const { controller, state } = await harness(async () => ({
      outcome: 'success',
      finalAssistantText: 'ok',
      rounds: 1,
      runId: 'run-1',
    }));
    assert.equal(controller.getSnapshot().activity, null, 'idle before the turn');
    await controller.submit('hi');
    assert.equal(controller.getSnapshot().activity, null, 'idle after the turn');
    assert.ok(state);
    await controller.dispose();
  });

  it('reports the running tool while a call is in flight, and drops it once settled', async () => {
    let midCall = null;
    let afterSettle = null;
    const { controller } = await harness(async (_s, options, state) => {
      emit(
        options,
        'tool.execution_start',
        { toolName: 'edit_file', executionId: 'x1' },
        state.sessionId,
      );
      midCall = controller.getSnapshot().activity;
      emit(
        options,
        'tool.execution_complete',
        { toolName: 'edit_file', executionId: 'x1', target: 'a.ts' },
        state.sessionId,
      );
      afterSettle = controller.getSnapshot().activity;
      return { outcome: 'success', finalAssistantText: 'done', rounds: 1, runId: 'run-1' };
    });
    await controller.submit('edit something');
    assert.deepEqual(midCall, { kind: 'tool', toolName: 'edit_file' });
    // Settled → back to the quiet state, NOT a stale 'edit_file'. The old TUI
    // needed an explicit re-assignment here to avoid a stale tool verb; the
    // derivation makes it fall out.
    assert.deepEqual(afterSettle, { kind: 'thinking' });
    await controller.dispose();
  });

  it('reports the LAST of several parallel calls (reads fan out, cap 6)', async () => {
    let observed = null;
    const { controller } = await harness(async (_s, options, state) => {
      emit(
        options,
        'tool.execution_start',
        { toolName: 'read_file', executionId: 'r1' },
        state.sessionId,
      );
      emit(
        options,
        'tool.execution_start',
        { toolName: 'grep', executionId: 'r2' },
        state.sessionId,
      );
      observed = controller.getSnapshot().activity;
      return { outcome: 'success', finalAssistantText: 'done', rounds: 1, runId: 'run-1' };
    });
    await controller.submit('look around');
    assert.deepEqual(observed, { kind: 'tool', toolName: 'grep' });
    await controller.dispose();
  });

  it('reports streaming once tokens arrive', async () => {
    let observed = null;
    const { controller } = await harness(async (_s, options, state) => {
      emit(options, 'assistant_token', { text: 'hello' }, state.sessionId);
      observed = controller.getSnapshot().activity;
      return { outcome: 'success', finalAssistantText: 'hello', rounds: 1, runId: 'run-1' };
    });
    await controller.submit('say hi');
    assert.deepEqual(observed, { kind: 'streaming' });
    await controller.dispose();
  });

  it('a tool call outranks streamed prose still on screen', async () => {
    // Ordering matters: `liveText` survives until `assistant_done`, so a naive
    // check would keep saying "replying" while a tool is actually running.
    let observed = null;
    const { controller } = await harness(async (_s, options, state) => {
      emit(options, 'assistant_token', { text: 'let me look' }, state.sessionId);
      emit(
        options,
        'tool.execution_start',
        { toolName: 'read_file', executionId: 'r1' },
        state.sessionId,
      );
      observed = controller.getSnapshot().activity;
      return { outcome: 'success', finalAssistantText: '', rounds: 1, runId: 'run-1' };
    });
    await controller.submit('look');
    assert.deepEqual(observed, { kind: 'tool', toolName: 'read_file' });
    await controller.dispose();
  });

  // Daemon-backed turns render from the daemon mirror, not `activityRows`, so
  // the verb must derive from the mirror too (Codex P2). Drives the REAL
  // daemon path: `ensureReady` true → send_user_message → engine events.
  const daemonHarness = async ({ priorRows = [] } = {}) => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = baseState();
    let hooks;
    const controller = await createSilveryController(
      { sessionId: state.sessionId },
      {
        loadConfig: async () => ({ safeExecPatterns: [] }),
        initSession: async () => state,
        gitStatus: async () => ({ branch: 'main', dirty: 0, ahead: 0, behind: 0 }),
        resolveKey: () => '',
        appendEvent: async () => undefined,
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
                  return {
                    payload: {
                      transcript: { mirror: { rows: priorRows, liveText: '', lastSeq: 0 } },
                    },
                  };
                }
                if (type === 'send_user_message') return { payload: { runId: 'daemon-run' } };
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
    return { controller, emitEngine: (event) => hooks.onEngineEvent(event) };
  };

  it('derives the tool verb from the daemon mirror on a daemon-backed turn', async () => {
    const { controller, emitEngine } = await daemonHarness();
    const turn = controller.submit('edit something');
    while (!controller.getSnapshot().running) await sleep(0);
    emitEngine({ type: 'user_message', payload: { text: 'edit something' }, seq: 1 });
    emitEngine({
      type: 'tool.execution_start',
      payload: { toolName: 'edit_file', executionId: 'd1' },
      seq: 2,
    });
    assert.deepEqual(
      controller.getSnapshot().activity,
      { kind: 'tool', toolName: 'edit_file' },
      'daemon pending tool must drive the verb, not the mood fallback',
    );
    emitEngine({ type: 'run_complete', payload: {}, seq: 3 });
    await turn;
    assert.equal(controller.getSnapshot().activity, null, 'idle after the daemon turn');
    await controller.dispose();
  });

  it('a pending call stranded by an earlier daemon turn cannot pin the verb', async () => {
    // Mirror rows persist across turns (they are the transcript), and before
    // the daemon echoes this turn's user_message there is no user row to stop
    // the scan at — only the row floor taken at send time excludes the debris.
    const { controller, emitEngine } = await daemonHarness({
      priorRows: [
        { id: 'u0', kind: 'message', role: 'user', text: 'old ask' },
        { id: 't0', kind: 'tool', toolName: 'sandbox_exec', pending: true, text: 'sandbox_exec' },
      ],
    });
    const turn = controller.submit('new ask');
    while (!controller.getSnapshot().running) await sleep(0);
    assert.deepEqual(
      controller.getSnapshot().activity,
      { kind: 'thinking' },
      'a stranded pending row from a prior turn pinned the verb',
    );
    emitEngine({ type: 'run_complete', payload: {}, seq: 1 });
    await turn;
    await controller.dispose();
  });

  it('an unsettled call from a failed turn cannot pin the verb', async () => {
    // The reason `running` gates the derivation. A turn that throws mid-call
    // leaves a pending row behind forever; the header must still go idle.
    const { controller } = await harness(async (_s, options, state) => {
      emit(
        options,
        'tool.execution_start',
        { toolName: 'sandbox_exec', executionId: 'e1' },
        state.sessionId,
      );
      throw new Error('provider exploded');
    });
    await controller.submit('run it');
    const snapshot = controller.getSnapshot();
    assert.equal(snapshot.running, false);
    assert.equal(snapshot.activity, null, 'a leaked pending row pinned the verb');
    assert.ok(
      snapshot.rows.some((row) => row.pending),
      'precondition: the row did leak',
    );
    await controller.dispose();
  });
});

describe('silvery header — one row at any width', () => {
  // Renders the REAL surface. The wrap this pins is not hypothetical: silvery's
  // default `wrap` is word-wrap, so the fact strip quietly became two or three
  // rows on a narrow terminal, spilling into the space `transcriptHeight`
  // (rows - 6) had already promised the transcript. Nothing caught it because
  // every unit test around the header asserted on strings, and a string has no
  // width. Found by rendering; kept honest by rendering.
  const widths = [100, 76, 60, 44, 32];

  const parkedController = async (toolName) => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = {
      sessionId: 'header-width-session',
      messages: [{ role: 'system', content: 'system' }],
      eventSeq: 0,
      updatedAt: Date.now(),
      cwd: '/home/ishaw/projects/Push',
      provider: 'ollama',
      model: 'test-model',
      rounds: 0,
      sessionName: '',
      workingMemory: {},
      mode: 'tui',
    };
    let release;
    const parked = new Promise((resolve) => {
      release = resolve;
    });
    const controller = await createSilveryController(
      { sessionId: state.sessionId },
      {
        loadConfig: async () => ({ safeExecPatterns: [] }),
        useDaemon: false,
        initSession: async () => state,
        // A long branch name is the realistic pressure, not a synthetic one.
        gitStatus: async () => ({
          branch: 'feat/a-realistically-long-branch-name',
          dirty: 3,
          ahead: 0,
          behind: 0,
        }),
        resolveKey: () => '',
        appendEvent: async () => undefined,
        saveState: async () => undefined,
        runTurn: async (_s, _p, _k, _t, _r, options) => {
          options.emit({
            type: 'tool.execution_start',
            payload: { toolName, executionId: 'x1' },
            runId: 'run-1',
            sessionId: state.sessionId,
          });
          await parked;
          return { outcome: 'success', finalAssistantText: '', rounds: 1, runId: 'run-1' };
        },
      },
    );
    return { controller, release, turn: controller.submit('go') };
  };

  // Returns the plain-text frame rows plus the index of the header row.
  const renderFrame = async (controller, columns) => {
    const React = (await import('react')).default;
    const Silvery = await import('silvery');
    const { PushSurface } = await import('../silvery/surface.tsx');
    const stdout = new FakeStdout(columns, 14);
    // Pin the glyph tier: `detectUnicode()` reads LANG / TERM_PROGRAM /
    // WT_SESSION at render time, so Ubuntu CI (LANG=C.UTF-8) paints ⬢ while
    // Windows CI (no signal) correctly falls back to the ASCII glyphs and the
    // anchors below never match. The fallback is product behavior with its own
    // coverage; these row-layout assertions want one deterministic rendering.
    const previousLang = process.env.LANG;
    process.env.LANG = 'C.UTF-8';
    let rows;
    try {
      const instance = Silvery.render(
        React.createElement(PushSurface, { controller }),
        { stdout, stdin: new FakeStdin() },
        { exitOnCtrlC: false, alternateScreen: false, mode: 'fullscreen', mouse: false },
      );
      instance.run?.();
      await instance;
      await sleep(200);
      rows = stdout.bytes
        .replace(/\x1b\[[0-9;]*m/g, '')
        .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '\n')
        .split('\n');
      instance.unmount?.();
    } finally {
      if (previousLang === undefined) delete process.env.LANG;
      else process.env.LANG = previousLang;
    }
    // Anchor on the verb, never on the facts: the facts truncate BY DESIGN (at
    // 44 columns the branch name and meter are both gone), so matching them
    // would report a correctly-truncated header as a missing one.
    const headerIndex = rows.findIndex((line) => /⬢ testing…/.test(line));
    return { rows, headerIndex };
  };

  /** Fact-strip debris — what a wrapped header spills onto the next row. */
  const FACT_DEBRIS = /░|turn \d|realistically|\+3/;

  for (const columns of widths) {
    it(`keeps the fact strip on a single row at ${columns} columns`, {
      skip: silverySkip,
    }, async () => {
      const { controller, release, turn } = await parkedController('sandbox_run_tests');
      try {
        const { rows, headerIndex } = await renderFrame(controller, columns);
        assert.ok(headerIndex >= 0, `header row not found at ${columns} cols`);

        // The invariant, stated where it can actually fail: the row BELOW the
        // header must carry no fact-strip debris. Counting verb-matching rows
        // cannot detect this — the verb only ever renders on the first row, so
        // that count stays 1 whether the facts wrapped or not.
        const below = rows[headerIndex + 1] ?? '';
        assert.ok(
          !FACT_DEBRIS.test(below),
          `header wrapped onto the next row at ${columns} cols:\n  ${rows[headerIndex]}\n  ${below}`,
        );
        assert.ok(
          rows[headerIndex].trimEnd().length <= columns,
          `header overflowed ${columns} cols: ${rows[headerIndex].trimEnd().length}`,
        );
      } finally {
        release();
        await turn;
        await controller.dispose();
      }
    });
  }

  it('keeps the mark separated from the verb when the row is tight', {
    skip: silverySkip,
  }, async () => {
    // The separator space used to be its own one-cell flex item and was the
    // first thing shrink-to-fit dropped, painting `⬢testing…`.
    const { controller, release, turn } = await parkedController('sandbox_run_tests');
    try {
      const { rows, headerIndex } = await renderFrame(controller, 60);
      assert.ok(headerIndex >= 0, 'the mark and verb were painted jammed together');
      assert.match(rows[headerIndex], /⬢ testing…/);
    } finally {
      release();
      await turn;
      await controller.dispose();
    }
  });
});

describe('silvery transcript render contracts', () => {
  it('pins a real transcript row through Silvery renderString', {
    skip: silverySkip,
  }, async () => {
    const React = (await import('react')).default;
    const Silvery = await import('silvery');
    const { TranscriptRow } = await import('../silvery/surface.tsx');
    const previousLang = process.env.LANG;
    process.env.LANG = 'C.UTF-8';
    try {
      const item = {
        id: 'golden-assistant',
        kind: 'message',
        role: 'assistant',
        text: 'Golden **row**',
      };
      const output = await Silvery.renderString(
        React.createElement(
          Silvery.Box,
          { flexDirection: 'column', width: 32 },
          React.createElement(TranscriptRow, { item, width: 32 }),
        ),
        {
          width: 32,
          height: 8,
          plain: true,
          trimTrailingWhitespace: true,
          trimEmptyLines: true,
        },
      );
      assert.equal(output, ' ⬡ Golden row');
    } finally {
      if (previousLang === undefined) delete process.env.LANG;
      else process.env.LANG = previousLang;
    }
  });

  it('replays an incremental row update to Silvery’s target cells and styles', {
    skip: silverySkip,
  }, async () => {
    const React = (await import('react')).default;
    const Silvery = await import('silvery');
    const Runtime = await import('silvery/runtime');
    const { TranscriptRow } = await import('../silvery/surface.tsx');
    const { PushThemeProvider } = await import('../silvery/theme.tsx');
    const columns = 36;
    const rows = 6;
    const writes = [];
    const initial = {
      id: 'replay-row',
      kind: 'message',
      role: 'assistant',
      text: 'Initial row',
    };
    const updated = {
      ...initial,
      text: '**Updated** 界 row',
    };
    const app = Runtime.createApp(() => () => ({ item: initial }));
    function ReplayRow() {
      const item = Runtime.useApp((state) => state.item);
      return React.createElement(
        PushThemeProvider,
        { themeName: 'mono' },
        React.createElement(TranscriptRow, { item, width: columns }),
      );
    }

    let handle;
    try {
      handle = await app.run(React.createElement(ReplayRow), {
        cols: columns,
        rows,
        writable: { write: (data) => writes.push(data) },
        alternateScreen: false,
        mouse: false,
      });
      const replay = createVirtualTerminalReplay({ Silvery, columns, rows });
      await handle.waitForLayoutStable();
      replay.apply(writes.join(''));
      assert.ok(handle.buffer, 'headless runtime did not expose its target buffer');
      replay.assertMatches(handle.buffer, 'initial transcript render diverged');

      writes.length = 0;
      handle.store.setState({ item: updated });
      await handle.waitForLayoutStable();
      await sleep(20);
      assert.ok(writes.length > 0, 'row update did not emit an incremental ANSI write');
      replay.apply(writes.join(''));
      assert.ok(handle.buffer, 'updated runtime did not expose its target buffer');
      replay.assertMatches(handle.buffer, 'updated transcript render diverged');
    } finally {
      handle?.unmount();
    }
  });

  it('keeps wide, ANSI-fenced, table-boundary, and trailing-newline rows honest', {
    skip: silverySkip,
  }, async () => {
    const React = (await import('react')).default;
    const Silvery = await import('silvery');
    const { assertTranscriptRenderContract } = await import('../silvery/render-contract.ts');
    const { renderTranscriptRowForAssertion } = await import('../silvery/surface.tsx');

    // Initialise Silvery once; the production assertion path intentionally uses
    // renderStringSync after the live surface has already initialised layout.
    await Silvery.renderString(React.createElement(Silvery.Text, null, 'init'));
    const table = '| A | 字 |\n| --- | --- |\n| bb | c |';
    const fixtures = [
      { id: 'wide-cjk', width: 18, text: '界面 width 調整' },
      {
        id: 'ansi-fence',
        width: 24,
        text: '```ansi\n\u001b[31mred\u001b[0m + \u001b[1mbold\u001b[0m\n```',
      },
      // Message body width is row width minus the four-cell glyph/padding gutter:
      // 11 => the seven-cell table fits exactly; 10 => raw one-cell-narrow fallback.
      { id: 'table-exact-fit', width: 11, text: table },
      { id: 'table-one-too-narrow', width: 10, text: table },
      { id: 'trailing-newline', width: 20, text: 'first line\n' },
    ];

    for (const fixture of fixtures) {
      const item = {
        id: fixture.id,
        kind: 'message',
        role: 'assistant',
        text: fixture.text,
      };
      const rendered = renderTranscriptRowForAssertion({
        item,
        layoutWidth: fixture.width,
      });
      assert.deepEqual(
        assertTranscriptRenderContract(
          {
            rowId: item.id,
            rowKind: item.kind,
            width: fixture.width,
            measuredHeight: rendered.contentHeight,
            rendered,
          },
          { enabled: true, throwOnFailure: true, writeDiagnostic: () => undefined },
        ),
        [],
        fixture.id,
      );
    }
  });

  it('reproduces expanded review and tool state in the assertion render', {
    skip: silverySkip,
  }, async () => {
    const React = (await import('react')).default;
    const Silvery = await import('silvery');
    const { renderTranscriptRowForAssertion } = await import('../silvery/surface.tsx');
    const { assertTranscriptRenderContract, inspectTranscriptRenderContract } = await import(
      '../silvery/render-contract.ts'
    );
    await Silvery.renderString(React.createElement(Silvery.Text, null, 'init'));

    const preview = Array.from({ length: 6 }, (_, i) => `detail line ${i}`).join('\n');
    const fixtures = [
      {
        item: {
          id: 'exp-tool',
          kind: 'tool',
          toolName: 'run_command',
          text: 'run_command',
          resultPreview: preview,
        },
        key: 'tool:exp-tool',
        expandedEvidence: 'detail line 5',
      },
      {
        item: {
          id: 'exp-review',
          kind: 'review',
          role: 'reviewer',
          text: 'verdict line\nsecond finding\nthird finding',
        },
        key: 'review:exp-review',
        expandedEvidence: 'third finding',
      },
    ];

    for (const fixture of fixtures) {
      const collapsed = renderTranscriptRowForAssertion({ item: fixture.item, layoutWidth: 40 });
      const expanded = renderTranscriptRowForAssertion({
        item: fixture.item,
        layoutWidth: 40,
        expansion: new Map([[fixture.key, true]]),
      });
      assert.ok(
        expanded.contentHeight > collapsed.contentHeight,
        `${fixture.key}: expanding should grow the row`,
      );
      assert.ok(
        expanded.ansi.includes(fixture.expandedEvidence),
        `${fixture.key}: expanded render must show the tail`,
      );
      assert.ok(
        !collapsed.ansi.includes(fixture.expandedEvidence),
        `${fixture.key}: collapsed render must fold the tail`,
      );
      // An expanded live row verifies clean against an equally-expanded
      // duplicate tree...
      assert.deepEqual(
        assertTranscriptRenderContract(
          {
            rowId: fixture.item.id,
            rowKind: fixture.item.kind,
            width: 40,
            measuredHeight: expanded.contentHeight,
            rendered: expanded,
          },
          { enabled: true, throwOnFailure: true, writeDiagnostic: () => undefined },
        ),
        [],
        fixture.key,
      );
      // ...where a collapsed duplicate would have reported exactly the
      // spurious measured_height violation the snapshot plumbing prevents.
      assert.deepEqual(
        inspectTranscriptRenderContract({
          rowId: fixture.item.id,
          rowKind: fixture.item.kind,
          width: 40,
          measuredHeight: expanded.contentHeight,
          rendered: collapsed,
        }).map((violation) => violation.invariant),
        ['measured_height'],
        `${fixture.key}: state desync must be visible to the contract`,
      );
    }
  });

  it('shares one live expansion store between committed rows and the observer', {
    skip: silverySkip,
  }, async () => {
    const React = (await import('react')).default;
    const Silvery = await import('silvery');
    const { TranscriptRow } = await import('../silvery/surface.tsx');
    const { transcriptExpansion } = await import('../silvery/transcript-expansion.ts');
    assert.ok(transcriptExpansion, 'PUSH_TUI_ASSERT=1 must provision the shared expansion store');

    const item = {
      id: 'live-exp',
      kind: 'tool',
      toolName: 'run_command',
      text: 'run_command',
      resultPreview: 'first detail\nsecond detail',
    };
    const render = () =>
      Silvery.renderString(
        React.createElement(
          Silvery.Box,
          { flexDirection: 'column', width: 40 },
          React.createElement(TranscriptRow, { item, width: 40 }),
        ),
        { width: 40, height: 12, plain: true },
      );
    const before = await render();
    transcriptExpansion.toggle('tool:live-exp');
    try {
      const after = await render();
      assert.ok(!before.includes('second detail'), 'collapsed row must fold the preview tail');
      assert.ok(after.includes('second detail'), 'committed rows must read the shared store');
    } finally {
      transcriptExpansion.toggle('tool:live-exp');
    }
  });

  it('keeps unclipped evidence when the render outgrows the raw-text estimate', {
    skip: silverySkip,
  }, async () => {
    const React = (await import('react')).default;
    const Silvery = await import('silvery');
    const { renderTranscriptRowForAssertion } = await import('../silvery/surface.tsx');
    const { inspectTranscriptRenderContract, transcriptRenderLines } = await import(
      '../silvery/render-contract.ts'
    );
    await Silvery.renderString(React.createElement(Silvery.Text, null, 'init'));

    // Message renders Markdown at width - 4, so raw text counted at the full
    // layout width (~100 lines here) undershoots the real render (~150) — the
    // drift that would defeat any fixed buffer margin. The contract instead
    // relies on renderStringSync growing its cell buffer to the laid-out
    // content; this pins that invariant so a silvery that starts clamping to
    // the layout viewport fails loudly here instead of silently hiding the
    // very overflow evidence the checker exists to surface.
    const words = Array.from({ length: 300 }, () => 'abc').join(' ');
    const item = { id: 'long-narrow', kind: 'message', role: 'assistant', text: words };
    const layoutWidth = 12;
    const rawEstimate = Silvery.countVisualLines(words, layoutWidth);

    const rendered = renderTranscriptRowForAssertion({ item, layoutWidth });
    const lines = transcriptRenderLines(rendered);
    assert.ok(
      rendered.contentHeight > rawEstimate,
      `render (${rendered.contentHeight}) must outgrow the raw estimate (${rawEstimate})`,
    );
    assert.equal(lines.length, rendered.contentHeight);
    assert.ok(lines.at(-1).includes('abc'), 'tail of the row is missing from the buffer');
    assert.deepEqual(
      inspectTranscriptRenderContract({
        rowId: item.id,
        rowKind: item.kind,
        width: layoutWidth,
        measuredHeight: rendered.contentHeight,
        rendered,
      }),
      [],
      'an honest tall row must verify clean',
    );
    // An under-measured row reports the full unclipped height as evidence.
    assert.deepEqual(
      inspectTranscriptRenderContract({
        rowId: item.id,
        rowKind: item.kind,
        width: layoutWidth,
        measuredHeight: rawEstimate,
        rendered,
      }),
      [
        {
          invariant: 'measured_height',
          rowId: 'long-narrow',
          rowKind: 'message',
          lineIndex: null,
          expected: rendered.contentHeight,
          actual: rawEstimate,
        },
      ],
    );
  });

  it('fails a lying row with structured row identity and stays inert when disabled', async () => {
    const { assertTranscriptRenderContract } = await import('../silvery/render-contract.ts');
    const diagnostics = [];
    const lying = {
      rowId: 'lying-row',
      rowKind: 'message',
      width: 3,
      measuredHeight: 1,
      rendered: { ansi: '界界\nsecond', contentHeight: 2 },
    };

    assert.throws(
      () =>
        assertTranscriptRenderContract(lying, {
          enabled: true,
          throwOnFailure: true,
          writeDiagnostic: (line) => diagnostics.push(JSON.parse(line)),
        }),
      /message row lying-row/,
    );
    assert.deepEqual(
      diagnostics.map(({ rowId, rowKind, invariant, lineIndex, expected, actual }) => ({
        rowId,
        rowKind,
        invariant,
        lineIndex,
        expected,
        actual,
      })),
      [
        {
          rowId: 'lying-row',
          rowKind: 'message',
          invariant: 'line_width',
          lineIndex: 0,
          expected: 3,
          actual: 4,
        },
        {
          rowId: 'lying-row',
          rowKind: 'message',
          invariant: 'line_width',
          lineIndex: 1,
          expected: 3,
          actual: 6,
        },
        {
          rowId: 'lying-row',
          rowKind: 'message',
          invariant: 'measured_height',
          lineIndex: null,
          expected: 2,
          actual: 1,
        },
      ],
    );

    const disabledDiagnostics = [];
    assert.deepEqual(
      assertTranscriptRenderContract(lying, {
        enabled: false,
        throwOnFailure: true,
        writeDiagnostic: (line) => disabledDiagnostics.push(line),
      }),
      [],
    );
    assert.deepEqual(disabledDiagnostics, []);
  });
});

describe('silvery surface — constrained-height chrome budget', () => {
  it('keeps inline transcript, error, rule, three-row composer, and footer visible', {
    skip: silverySkip,
  }, async () => {
    const React = (await import('react')).default;
    const Silvery = await import('silvery');
    const { PushSurface, resolveSurfaceTranscriptHeight } = await import('../silvery/surface.tsx');
    const columns = 72;
    const terminalRows = 14;
    const stdout = new FakeStdout(columns, terminalRows);
    const hook = {};
    const snapshot = {
      rows: [
        { id: 'human', role: 'user', text: 'human transcript line' },
        {
          id: 'lead',
          role: 'assistant',
          text: 'assistant first line\nassistant continuation',
        },
      ],
      running: false,
      startedAt: null,
      provider: 'ollama',
      model: 'test-model',
      cwd: '/repo',
      gitStatus: { branch: 'main', dirty: 0, ahead: 0, behind: 0 },
      daemonConnected: false,
      error: 'surface frame error',
      interaction: null,
      picker: null,
      configEditor: null,
      theme: 'mono',
      execMode: 'auto',
    };
    const controller = {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
      submit: async () => undefined,
      cancel: () => undefined,
      clearDisplay: () => undefined,
      copyLastResponse: () => undefined,
      openPicker: () => undefined,
      openConfigEditor: () => undefined,
      takePendingComposerText: () => null,
      dispose: async () => undefined,
    };
    const previousLang = process.env.LANG;
    process.env.LANG = 'C.UTF-8';
    let instance;
    let lifecycle;
    try {
      const handle = Silvery.render(
        React.createElement(PushSurface, { controller, hook }),
        { stdout, stdin: new FakeStdin() },
        {
          exitOnCtrlC: false,
          alternateScreen: false,
          mode: 'fullscreen',
          mouse: false,
          // The fixture replays cursor-addressed output in a VirtualTerminal.
          // GitHub Actions otherwise makes Silvery auto-select line-by-line mode.
          nonTTYMode: 'tty',
        },
      );
      lifecycle = handle.run();
      instance = await handle;
      await sleep(80);

      const composer = 'composer row one\ncomposer row two\ncomposer row three';
      const { readRows: readFrameRows } = createVirtualTerminalFrameReader({
        Silvery,
        stdout,
        columns,
        rows: terminalRows,
      });

      // Let Silvery finish the initial full-screen write before scheduling the
      // composer state update, then read the observable terminal frame.
      await waitForVirtualTerminalFrame(readFrameRows, (rows) =>
        rows.some((line) => line.includes('auto ·')),
      );
      hook.setComposerInput(composer);
      const frameRows = await waitForVirtualTerminalFrame(readFrameRows, (rows) =>
        rows.some((line) => line.includes('composer row three')),
      );

      // Chrome at 72x14 with a 3-row composer + error = header + rule + composer(3)
      // + status footer(1) + error(1) = 7, so the transcript takes the remaining 7
      // and the composer/footer sit flush at the bottom (no dead space).
      assert.equal(
        resolveSurfaceTranscriptHeight(terminalRows, {
          composerRows: 3,
          footerRows: 1,
          errorRows: 1,
        }),
        7,
      );
      assert.equal(
        resolveSurfaceTranscriptHeight(terminalRows, {
          composerRows: 3,
          footerRows: 1,
          errorRows: 1,
          completionRows: 1,
        }),
        6,
      );
      // An idle single-row composer hands the transcript its full remainder
      // (header + rule + composer + footer = 4 rows of chrome at 72x14).
      assert.equal(
        resolveSurfaceTranscriptHeight(terminalRows, { composerRows: 1, footerRows: 1 }),
        10,
      );

      const frame = frameRows.join('\n');

      const humanRow = frameRows.find((line) => line.includes('human transcript line')) ?? '';
      const assistantRow = frameRows.find((line) => line.includes('assistant first line')) ?? '';
      const continuationRow =
        frameRows.find((line) => line.includes('assistant continuation')) ?? '';
      // The virtual terminal reserves the glyph's presentation-width cell;
      // require the body on the same row without pinning that width detail.
      assert.match(humanRow, /❯\s+human transcript line/);
      assert.match(assistantRow, /⬡\s+assistant first line/);
      assert.equal(
        continuationRow.indexOf('assistant continuation'),
        assistantRow.indexOf('assistant first line'),
        `assistant continuation lost its hanging indent:\n${frame}`,
      );

      const errorIndex = frameRows.findIndex((line) => line.includes('surface frame error'));
      const ruleIndex = frameRows.findIndex((line) => /^─{20}/.test(line));
      // The composer caret reserves the glyph's presentation width in the
      // virtual terminal (same as the transcript user glyph), so match flexibly.
      const composerStart = frameRows.findIndex((line) => /❯\s+composer row one/.test(line));
      const composerEnd = frameRows.findIndex((line) => line.includes('composer row three'));
      const footerStatus = frameRows.findIndex((line) => line.includes('auto ·'));

      assert.ok(errorIndex >= 0, `error row was clipped:\n${frame}`);
      assert.ok(ruleIndex > errorIndex, `composer rule was clipped or misplaced:\n${frame}`);
      assert.ok(composerStart > ruleIndex, `composer start was clipped:\n${frame}`);
      assert.ok(composerEnd >= composerStart, `three-row composer was clipped:\n${frame}`);
      assert.ok(footerStatus > composerEnd, `footer status row was clipped:\n${frame}`);
      // The composer scope drops the keybind strip — status only.
      assert.ok(
        !frameRows.some((line) => line.includes('tab complete')),
        `composer footer should not render the keybind strip:\n${frame}`,
      );
      // The status footer is the LAST visible row: composer + footer are pinned
      // flush to the bottom edge with no dead space beneath.
      assert.equal(
        footerStatus,
        terminalRows - 1,
        `footer is not pinned to the bottom row:\n${frame}`,
      );
    } finally {
      instance?.unmount();
      if (lifecycle) await lifecycle;
      if (previousLang === undefined) delete process.env.LANG;
      else process.env.LANG = previousLang;
    }
  });

  // Mount PushSurface into a fake terminal and read the settled frame back
  // through a VirtualTerminal (cursor-addressed, like production on a real TTY).
  const mountFrame = async ({ columns, terminalRows, snapshot, composerInput, settleOn }) => {
    const React = (await import('react')).default;
    const Silvery = await import('silvery');
    const { PushSurface } = await import('../silvery/surface.tsx');
    const stdout = new FakeStdout(columns, terminalRows);
    const hook = {};
    const controller = {
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
      submit: async () => undefined,
      cancel: () => undefined,
      clearDisplay: () => undefined,
      copyLastResponse: () => undefined,
      openPicker: () => undefined,
      openConfigEditor: () => undefined,
      takePendingComposerText: () => null,
      dispose: async () => undefined,
    };
    const previousLang = process.env.LANG;
    process.env.LANG = 'C.UTF-8';
    const handle = Silvery.render(
      React.createElement(PushSurface, { controller, hook }),
      { stdout, stdin: new FakeStdin() },
      {
        exitOnCtrlC: false,
        alternateScreen: false,
        mode: 'fullscreen',
        mouse: false,
        nonTTYMode: 'tty',
      },
    );
    const lifecycle = handle.run();
    const instance = await handle;
    await sleep(80);
    const { readRows: readFrameRows } = createVirtualTerminalFrameReader({
      Silvery,
      stdout,
      columns,
      rows: terminalRows,
    });
    await waitForVirtualTerminalFrame(readFrameRows, (rows) =>
      rows.some((line) => line.trim().length > 0),
    );
    if (composerInput != null) hook.setComposerInput(composerInput);
    const frameRows = settleOn
      ? await waitForVirtualTerminalFrame(readFrameRows, settleOn)
      : readFrameRows();
    const cleanup = async () => {
      instance?.unmount();
      if (lifecycle) await lifecycle;
      if (previousLang === undefined) delete process.env.LANG;
      else process.env.LANG = previousLang;
    };
    return { frameRows, cleanup };
  };

  const baseSnapshot = (over) => ({
    rows: [{ id: 'h', role: 'user', text: 'hi' }],
    running: false,
    startedAt: null,
    provider: 'ollama',
    model: 'gpt',
    cwd: '/repo',
    gitStatus: { branch: 'main', dirty: 0, ahead: 0, behind: 0 },
    daemonConnected: false,
    error: null,
    interaction: null,
    picker: null,
    configEditor: null,
    theme: 'mono',
    execMode: 'auto',
    ...over,
  });

  it('budgets a long error at its full wrapped height so the footer stays pinned', {
    skip: silverySkip,
  }, async () => {
    const columns = 40;
    const terminalRows = 14;
    // > 3 wrapped rows at width 38 (columns − glyph gutter): the old min(3) cap
    // would under-budget it and push the footer off the bottom.
    const longError =
      'upstream provider returned an unexpected error while streaming the response, and here is a very long detail line to force several wrapped rows in the frame';
    const { frameRows, cleanup } = await mountFrame({
      columns,
      terminalRows,
      snapshot: baseSnapshot({ error: longError }),
      settleOn: (rows) => rows.some((l) => l.includes('auto ·')),
    });
    try {
      const frame = frameRows.join('\n');
      const ruleIndex = frameRows.findIndex((l) => /^─{10}/.test(l));
      const footer = frameRows.findIndex((l) => l.includes('auto ·'));
      assert.ok(ruleIndex >= 0, `composer rule clipped by the wrapping error:\n${frame}`);
      assert.ok(footer > ruleIndex, `footer clipped below a wrapping error:\n${frame}`);
      assert.equal(
        footer,
        terminalRows - 1,
        `footer not pinned to the bottom with a long error:\n${frame}`,
      );
    } finally {
      await cleanup();
    }
  });

  it('reserves the wrapped footer height in a narrow running frame', {
    skip: silverySkip,
  }, async () => {
    const columns = 12; // 'ctrl+c cancel' (13) wraps past this width
    const terminalRows = 12;
    const { frameRows, cleanup } = await mountFrame({
      columns,
      terminalRows,
      snapshot: baseSnapshot({ running: true }),
      settleOn: (rows) => rows.some((l) => l.includes('ctrl')),
    });
    try {
      const frame = frameRows.join('\n');
      // The running footer's keybind strip wraps at width 12. Concatenated across
      // its rows, the full 'ctrl+c cancel' must survive — with the old
      // footerRows:1 budget its second wrapped row is pushed off the bottom, so
      // 'cancel' would be missing.
      assert.ok(
        frame.replace(/\s/g, '').includes('cancel'),
        `narrow running footer was clipped mid-wrap:\n${frame}`,
      );
    } finally {
      await cleanup();
    }
  });

  it('measures the completion rail wrapped height (drives the transcript budget)', async () => {
    const { completionRailRows, resolveSurfaceTranscriptHeight } = await import(
      '../silvery/surface.tsx'
    );
    // A long candidate label at a narrow width wraps the rail past one row.
    assert.ok(
      completionRailRows({ items: ['a-fairly-long-model-name'], index: -1 }, 24) >= 2,
      'completion rail should wrap to 2+ rows on a narrow terminal',
    );
    // Comfortable width keeps it to a single row.
    assert.equal(completionRailRows({ items: ['gpt'], index: -1 }, 80), 1);
    // The budget shrinks the transcript by the wrapped rows it is told about, so
    // a 2-row rail (or a >3-row error) never overflows the composer off-screen.
    assert.equal(
      resolveSurfaceTranscriptHeight(14, { composerRows: 1, footerRows: 1, completionRows: 2 }),
      8,
    );
    assert.equal(resolveSurfaceTranscriptHeight(14, { composerRows: 1, footerRows: 2 }), 9);
    // header+rule+composer(3)+footer+error(5) = 11 → floored to the 3-row minimum.
    assert.equal(
      resolveSurfaceTranscriptHeight(14, { composerRows: 3, footerRows: 1, errorRows: 5 }),
      3,
    );
  });
});

describe('silvery event diagnostics — reasoning + citations + warnings', () => {
  // Against the real inline lane: a runTurn mock emits engine events through
  // `options.emit`, and we read the rendered transcript rows.
  const baseState = () => ({
    sessionId: 'diag-session',
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
  });

  const harness = async (runTurn) => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const state = baseState();
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
        runTurn: (_s, _p, _k, _t, _r, options) => runTurn(options, state),
      },
    );
    return { controller, state };
  };
  const emit = (options, type, payload, sessionId) =>
    options.emit({ type, payload, runId: 'run-1', sessionId });
  const rowsText = (controller) => controller.getSnapshot().rows.map((r) => r.text);

  it('renders web-search citations as a Sources block', async () => {
    const { controller } = await harness(async (options, state) => {
      emit(options, 'assistant_token', { text: 'here you go' }, state.sessionId);
      emit(
        options,
        'assistant_citations',
        { citations: [{ url: 'https://silvery.dev', title: 'Silvery' }] },
        state.sessionId,
      );
      emit(options, 'run_complete', {}, state.sessionId);
      return { outcome: 'success', finalAssistantText: 'here you go', rounds: 1, runId: 'run-1' };
    });
    await controller.submit('search the web');
    assert.ok(
      rowsText(controller).some((t) => /Sources \(1\)/.test(t) && /silvery\.dev/.test(t)),
      `no sources row: ${JSON.stringify(rowsText(controller))}`,
    );
    await controller.dispose();
  });

  it('captures reasoning live, keeps the completed tail, and does not mislabel the run empty', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { controller } = await harness(async (options, state) => {
      emit(options, 'assistant_thinking_token', { text: 'first thought\n' }, state.sessionId);
      emit(options, 'assistant_thinking_token', { text: 'second thought' }, state.sessionId);
      await gate;
      emit(options, 'assistant_thinking_done', {}, state.sessionId);
      emit(options, 'run_complete', {}, state.sessionId);
      return { outcome: 'success', finalAssistantText: '', rounds: 1, runId: 'run-1' };
    });

    const turn = controller.submit('think about it');
    while (!controller.getSnapshot().reasoning.live) await sleep(0);
    controller.toggleReasoning();
    assert.deepEqual(controller.getSnapshot().reasoning, {
      open: true,
      text: 'first thought\nsecond thought',
      live: true,
    });
    release();
    await turn;
    assert.equal(controller.getSnapshot().reasoning.live, false);
    assert.equal(controller.getSnapshot().reasoning.text, 'first thought\nsecond thought');
    assert.ok(
      !rowsText(controller).some((text) => /response was empty/i.test(text)),
      'reasoning-only run should count as visible output',
    );
    controller.closeReasoning();
    assert.equal(controller.getSnapshot().reasoning.open, false);
    await controller.dispose();
  });

  it('clears the previous tail when a new turn begins (no stale private context)', async () => {
    let call = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const { controller } = await harness(async (options, state) => {
      call += 1;
      if (call === 1) {
        emit(options, 'assistant_thinking_token', { text: 'private thought' }, state.sessionId);
        emit(options, 'assistant_thinking_done', {}, state.sessionId);
        emit(options, 'run_complete', {}, state.sessionId);
        return { outcome: 'success', finalAssistantText: '', rounds: 1, runId: 'run-1' };
      }
      emit(options, 'assistant_token', { text: 'no thinking this time' }, state.sessionId);
      await gate;
      emit(options, 'run_complete', {}, state.sessionId);
      return {
        outcome: 'success',
        finalAssistantText: 'no thinking this time',
        rounds: 1,
        runId: 'run-2',
      };
    });

    await controller.submit('turn one');
    assert.equal(controller.getSnapshot().reasoning.text, 'private thought');

    // Mid-turn on a run that has not emitted thinking: Ctrl+G must not present
    // the previous turn's reasoning as if it were current.
    const second = controller.submit('turn two');
    while (!controller.getSnapshot().rows.some((row) => row.text === 'turn two')) await sleep(0);
    assert.deepEqual(controller.getSnapshot().reasoning, { open: false, text: '', live: false });
    release();
    await second;
    assert.equal(controller.getSnapshot().reasoning.text, '');
    await controller.dispose();
  });

  it('wipes the reasoning tail on /clear', async () => {
    const { controller } = await harness(async (options, state) => {
      emit(options, 'assistant_thinking_token', { text: 'secret planning' }, state.sessionId);
      emit(options, 'assistant_thinking_done', {}, state.sessionId);
      emit(options, 'run_complete', {}, state.sessionId);
      return { outcome: 'success', finalAssistantText: '', rounds: 1, runId: 'run-1' };
    });
    await controller.submit('think');
    assert.equal(controller.getSnapshot().reasoning.text, 'secret planning');
    await controller.submit('/clear');
    assert.equal(controller.getSnapshot().reasoning.text, '');
    await controller.dispose();
  });

  it('renders the reasoning tail as a real modal', { skip: silverySkip }, async () => {
    const React = (await import('react')).default;
    const Silvery = await import('silvery');
    const { PushSurface } = await import('../silvery/surface.tsx');
    const { controller } = await harness(async (options, state) => {
      emit(
        options,
        'assistant_thinking_token',
        { text: Array.from({ length: 12 }, (_, index) => `thought ${index + 1}`).join('\n') },
        state.sessionId,
      );
      emit(options, 'assistant_thinking_done', {}, state.sessionId);
      emit(options, 'run_complete', {}, state.sessionId);
      return { outcome: 'success', finalAssistantText: '', rounds: 1, runId: 'run-1' };
    });
    await controller.submit('show the modal');
    controller.toggleReasoning();

    const stdout = new FakeStdout(72, 16);
    const stdin = new FakeStdin();
    const handle = Silvery.render(React.createElement(PushSurface, { controller, hook: {} }), {
      stdout,
      stdin,
    });
    const lifecycle = handle.run();
    const instance = await handle;
    await sleep(180);
    assert.match(stdout.bytes, /Reasoning/);
    assert.match(stdout.bytes, /more lines above/);
    assert.match(stdout.bytes, /thought 12/);

    instance.unmount();
    await lifecycle;
    await controller.dispose();
  });

  it('surfaces an inline unknown event once instead of silently dropping it', async () => {
    const { controller } = await harness(async (options, state) => {
      emit(options, 'future.event', {}, state.sessionId);
      emit(options, 'future.event', {}, state.sessionId);
      emit(options, 'run_complete', {}, state.sessionId);
      return { outcome: 'success', finalAssistantText: '', rounds: 1, runId: 'run-1' };
    });
    await controller.submit('exercise drift');
    assert.equal(
      rowsText(controller).filter((text) => /unknown event type "future\.event"/i.test(text))
        .length,
      1,
    );
    assert.ok(!rowsText(controller).some((text) => /response was empty/i.test(text)));
    await controller.dispose();
  });

  it('warns on a run that produced no visible output (empty-run)', async () => {
    const { controller } = await harness(async (options, state) => {
      // Nothing but the completion — the parser-drop / blank-turn symptom.
      emit(options, 'run_complete', {}, state.sessionId);
      return { outcome: 'success', finalAssistantText: '', rounds: 1, runId: 'run-1' };
    });
    await controller.submit('do something');
    assert.ok(
      rowsText(controller).some((t) => /response was empty/i.test(t)),
      `no empty-run warning: ${JSON.stringify(rowsText(controller))}`,
    );
    await controller.dispose();
  });

  it('does NOT warn when the run emitted visible output (no false positive)', async () => {
    const { controller } = await harness(async (options, state) => {
      emit(options, 'assistant_token', { text: 'a real reply' }, state.sessionId);
      emit(options, 'run_complete', {}, state.sessionId);
      return { outcome: 'success', finalAssistantText: 'a real reply', rounds: 1, runId: 'run-1' };
    });
    await controller.submit('say something');
    assert.ok(
      !rowsText(controller).some((t) => /response was empty/i.test(t)),
      'false-positive empty-run warning on a non-empty turn',
    );
    await controller.dispose();
  });

  it('resets between runs — a full turn does not suppress a later empty one', async () => {
    let phase = 0;
    const { controller } = await harness(async (options, state) => {
      if (phase === 0) emit(options, 'assistant_token', { text: 'first' }, state.sessionId);
      // phase 1 emits nothing visible.
      emit(options, 'run_complete', {}, state.sessionId);
      return { outcome: 'success', finalAssistantText: '', rounds: 1, runId: 'run-1' };
    });
    await controller.submit('turn one');
    phase = 1;
    await controller.submit('turn two');
    const emptyWarnings = rowsText(controller).filter((t) => /response was empty/i.test(t));
    assert.equal(emptyWarnings.length, 1, 'the empty second turn must warn exactly once');
    await controller.dispose();
  });
});

describe('silvery event diagnostics — daemon-owned rows', () => {
  // The daemon lane observes runs via onEngineEvent, with no local submit()
  // between them (a remote-triggered turn). The per-run reset therefore has to
  // happen at run_complete, not only at submit — otherwise a non-empty run
  // leaves the counter high and a following EMPTY run is silently not warned.
  it('preserves citations and the per-run empty warning through completion resync', async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const { applyDaemonTranscriptEvent, createDaemonTranscriptMirror, snapshotDaemonTranscript } =
      await import('../daemon-transcript-mirror.ts');
    const state = {
      sessionId: 'diag-daemon',
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
    const serverMirror = createDaemonTranscriptMirror();
    const client = {
      request: async (type) => {
        if (type === 'get_session_snapshot')
          return {
            payload: { transcript: { mirror: snapshotDaemonTranscript(serverMirror) } },
          };
        return { payload: {} };
      },
    };
    const controller = await createSilveryController(
      { sessionId: state.sessionId },
      {
        loadConfig: async () => ({ safeExecPatterns: [] }),
        useDaemon: true,
        initSession: async () => state,
        gitStatus: async () => ({ branch: 'main', dirty: 0, ahead: 0, behind: 0 }),
        resolveKey: () => '',
        appendEvent: async () => undefined,
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
            ensureSession: async () => undefined,
            noteSeenSeq: () => undefined,
            scheduleReconnect: () => undefined,
            teardown: () => undefined,
          };
        },
      },
    );
    assert.ok(hooks, 'daemon hooks captured');

    const deliver = (event) => {
      applyDaemonTranscriptEvent(serverMirror, event);
      hooks.onEngineEvent(event);
    };

    // Run 1: visible output and sources, then complete — no warning, counter resets.
    deliver({ type: 'assistant_token', payload: { text: 'reply' }, seq: 1 });
    deliver({
      type: 'assistant_citations',
      payload: { citations: [{ url: 'https://safe.dev', title: 'Safe' }] },
      seq: 2,
    });
    deliver({ type: 'run_complete', payload: {}, seq: 3 });
    // Run 2: nothing visible, then complete — MUST warn (this is the reset guard).
    deliver({ type: 'user_message', payload: { text: 'empty run' }, seq: 4 });
    deliver({ type: 'run_complete', payload: {}, seq: 5 });
    for (let i = 0; i < 20; i += 1) await sleep(0);

    const rowTexts = controller.getSnapshot().rows.map((row) => row.text);
    const warnings = rowTexts.filter((text) => /response was empty/i.test(text));
    const sources = rowTexts.filter((text) => /Sources \(1\)/.test(text));
    assert.equal(warnings.length, 1, 'the empty second daemon run must warn (per-run reset)');
    assert.equal(sources.length, 1, 'the daemon citation row must survive run-complete resync');
    await controller.dispose();
  });

  // A remote-initiated turn (started from another surface on the shared daemon
  // session) never passes through submit(), so the user_message echo is the only
  // turn boundary the TUI sees. Without a reset there, the modal shows the prior
  // turn's reasoning as current AND appends the new turn's tokens onto it.
  it('resets reasoning at a remote turn boundary instead of concatenating turns', async () => {
    const { createSilveryController } = await import('../silvery/controller.ts');
    const { applyDaemonTranscriptEvent, createDaemonTranscriptMirror, snapshotDaemonTranscript } =
      await import('../daemon-transcript-mirror.ts');
    const state = {
      sessionId: 'reasoning-daemon',
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
    const serverMirror = createDaemonTranscriptMirror();
    const client = {
      request: async (type) => {
        if (type === 'get_session_snapshot')
          return {
            payload: { transcript: { mirror: snapshotDaemonTranscript(serverMirror) } },
          };
        return { payload: {} };
      },
    };
    const controller = await createSilveryController(
      { sessionId: state.sessionId },
      {
        loadConfig: async () => ({ safeExecPatterns: [] }),
        useDaemon: true,
        initSession: async () => state,
        gitStatus: async () => ({ branch: 'main', dirty: 0, ahead: 0, behind: 0 }),
        resolveKey: () => '',
        appendEvent: async () => undefined,
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
            ensureSession: async () => undefined,
            noteSeenSeq: () => undefined,
            scheduleReconnect: () => undefined,
            teardown: () => undefined,
          };
        },
      },
    );
    assert.ok(hooks, 'daemon hooks captured');

    const deliver = (event) => {
      applyDaemonTranscriptEvent(serverMirror, event);
      hooks.onEngineEvent(event);
    };

    // Turn 1 completes with reasoning; the tail stays available afterward.
    deliver({ type: 'assistant_thinking_token', payload: { text: 'turn one thinking' }, seq: 1 });
    deliver({ type: 'assistant_thinking_done', payload: {}, seq: 2 });
    deliver({ type: 'assistant_token', payload: { text: 'reply one' }, seq: 3 });
    deliver({ type: 'run_complete', payload: {}, seq: 4 });
    for (let i = 0; i < 20; i += 1) await sleep(0);
    assert.equal(controller.getSnapshot().reasoning.text, 'turn one thinking');

    // Turn 2 starts remotely: the boundary must wipe the stale tail...
    deliver({ type: 'user_message', payload: { text: 'from the phone' }, seq: 5 });
    assert.equal(controller.getSnapshot().reasoning.text, '');
    // ...and the new turn's tokens must not be concatenated onto turn one's.
    deliver({ type: 'assistant_thinking_token', payload: { text: 'turn two thinking' }, seq: 6 });
    assert.equal(controller.getSnapshot().reasoning.text, 'turn two thinking');
    deliver({ type: 'run_complete', payload: {}, seq: 7 });
    for (let i = 0; i < 20; i += 1) await sleep(0);
    assert.equal(controller.getSnapshot().reasoning.text, 'turn two thinking');
    await controller.dispose();
  });
});
