import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

const nodeMajor = Number(process.versions.node.split('.')[0]);
const silverySkip =
  nodeMajor < 24 ? `silvery 0.21 requires Node >=24 (current: ${process.version})` : false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('composer undo kernel', () => {
  it('coalesces an insert run into one undo step', async () => {
    const { createComposerUndo } = await import('../tui-composer-undo.ts');
    const undo = createComposerUndo();
    undo.record('h');
    undo.record('he');
    undo.record('hel');
    assert.equal(undo.undo(), '');
    assert.equal(undo.undo(), null);
  });

  it('caps a run at 20 edits (bash-style groups)', async () => {
    const { createComposerUndo } = await import('../tui-composer-undo.ts');
    const undo = createComposerUndo();
    let value = '';
    for (let i = 0; i < 25; i++) {
      value += 'x';
      undo.record(value);
    }
    assert.equal(undo.undo(), 'x'.repeat(20));
    assert.equal(undo.undo(), '');
  });

  it('a direction change breaks the run', async () => {
    const { createComposerUndo } = await import('../tui-composer-undo.ts');
    const undo = createComposerUndo();
    undo.record('a');
    undo.record('ab');
    undo.record('a'); // backspace — delete run starts
    assert.equal(undo.undo(), 'ab');
    assert.equal(undo.undo(), '');
  });

  it('a multi-char delta (kill/yank/paste) is its own step', async () => {
    const { createComposerUndo } = await import('../tui-composer-undo.ts');
    const undo = createComposerUndo();
    undo.record('hello world'); // paste-like jump from ''
    undo.record('hello world!');
    assert.equal(undo.undo(), 'hello world');
    assert.equal(undo.undo(), '');
  });

  it('redo round-trips and dies on a new edit', async () => {
    const { createComposerUndo } = await import('../tui-composer-undo.ts');
    const undo = createComposerUndo();
    undo.record('a');
    assert.equal(undo.undo(), '');
    assert.equal(undo.redo(), 'a');
    assert.equal(undo.undo(), '');
    undo.record('b');
    assert.equal(undo.redo(), null);
  });

  it('recordDiscrete is a no-op for an unchanged value', async () => {
    const { createComposerUndo } = await import('../tui-composer-undo.ts');
    const undo = createComposerUndo();
    undo.record('draft');
    undo.recordDiscrete('draft');
    undo.recordDiscrete('recalled');
    assert.equal(undo.undo(), 'draft');
    assert.equal(undo.undo(), '');
  });

  it('reset drops both stacks and re-baselines', async () => {
    const { createComposerUndo } = await import('../tui-composer-undo.ts');
    const undo = createComposerUndo();
    undo.record('a');
    assert.equal(undo.undo(), '');
    undo.reset('base');
    assert.equal(undo.undo(), null);
    assert.equal(undo.redo(), null);
    undo.record('bases'); // +1 from the new baseline → insert run
    assert.equal(undo.undo(), 'base');
  });
});

// ── Integration: chords through the real surface ────────────────────

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

const UP = '\x1b[A';
const CTRL_U = '\x15';
const CTRL_Y = '\x19';
const CTRL_Z = '\x1a';
const CTRL_UNDERSCORE = '\x1f';
const KITTY_CTRL_Z = '\x1b[122;5u';
const KITTY_CTRL_SHIFT_Z = '\x1b[122;6u';

describe('composer undo/redo (surface integration)', () => {
  async function mountSurface(promptHistory = []) {
    const React = (await import('react')).default;
    const Silvery = await import('silvery');
    const { PushSurface } = await import('../silvery/surface.tsx');
    const stdout = new FakeStdout(72, 20);
    const stdin = new FakeStdin();
    const hook = {};
    const snapshot = {
      rows: [],
      running: false,
      sessionId: 'sess_test_abc123',
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
      getPromptHistory: () => [...promptHistory],
      dispose: async () => undefined,
    };
    const handle = Silvery.render(
      React.createElement(PushSurface, { controller, hook }),
      { stdout, stdin },
      { exitOnCtrlC: false, alternateScreen: false, mode: 'fullscreen', mouse: true, stdin },
    );
    const lifecycle = handle.run();
    const instance = await handle;
    await sleep(180);
    assert.ok(stdin.listenerCount('readable') > 0, 'Silvery must subscribe to the fake terminal');
    return { stdin, hook, instance, lifecycle };
  }

  async function waitForInput(hook, expected) {
    for (let i = 0; i < 100 && hook.getComposerState().input !== expected; i++) await sleep(10);
    assert.equal(hook.getComposerState().input, expected);
  }

  async function typeChars(stdin, hook, text) {
    let expected = hook.getComposerState().input;
    for (const char of text) {
      expected += char;
      stdin.send(char);
      await waitForInput(hook, expected);
    }
  }

  it('Ctrl+Z undoes a typing burst as one step; kitty Ctrl+Shift+Z redoes it', {
    skip: silverySkip,
  }, async () => {
    const { stdin, hook, instance, lifecycle } = await mountSurface();
    try {
      await typeChars(stdin, hook, 'hello');
      stdin.send(CTRL_Z);
      await waitForInput(hook, '');
      stdin.send(KITTY_CTRL_SHIFT_Z);
      await waitForInput(hook, 'hello');
    } finally {
      instance.unmount();
      await lifecycle;
    }
  });

  it('Ctrl+_ (the 0x1f byte) also undoes', {
    skip: silverySkip,
  }, async () => {
    const { stdin, hook, instance, lifecycle } = await mountSurface();
    try {
      await typeChars(stdin, hook, 'abc');
      stdin.send(CTRL_UNDERSCORE);
      await waitForInput(hook, '');
    } finally {
      instance.unmount();
      await lifecycle;
    }
  });

  it("pins silvery's kill/yank and undoes each as its own step", {
    skip: silverySkip,
  }, async () => {
    const { stdin, hook, instance, lifecycle } = await mountSurface();
    try {
      await typeChars(stdin, hook, 'hello world');
      // Ctrl+U kills to line start into the kill ring; Ctrl+Y yanks it back.
      // Both are silvery TextArea behavior — pinned here because the #1563
      // acceptance names them, and they must keep flowing through onChange
      // for undo to see them.
      stdin.send(CTRL_U);
      await waitForInput(hook, '');
      stdin.send(CTRL_Y);
      await waitForInput(hook, 'hello world');
      // Each multi-char mutation is a discrete undo step: yank, then kill.
      stdin.send(CTRL_Z);
      await waitForInput(hook, '');
      stdin.send(CTRL_Z);
      await waitForInput(hook, 'hello world');
      // One more undoes the typing burst itself.
      stdin.send(CTRL_Z);
      await waitForInput(hook, '');
    } finally {
      instance.unmount();
      await lifecycle;
    }
  });

  it('undoing a history recall restores the draft it replaced', {
    skip: silverySkip,
  }, async () => {
    const { stdin, hook, instance, lifecycle } = await mountSurface(['alpha']);
    try {
      await typeChars(stdin, hook, 'draft');
      stdin.send(UP);
      await waitForInput(hook, 'alpha');
      stdin.send(CTRL_Z);
      await waitForInput(hook, 'draft');
    } finally {
      instance.unmount();
      await lifecycle;
    }
  });

  it('batched key-repeat undos do not corrupt the redo chain', {
    skip: silverySkip,
  }, async () => {
    // Key-repeat can land two undo key events in ONE stdin chunk, and
    // silvery's splitter dispatches every sequence in the chunk in one
    // synchronous pass — so the second undo fires before React re-renders.
    // History transitions must come from the kernel's own snapshot, not the
    // render-captured composer value — a stale value pushed into the redo
    // stack duplicates one state and loses another (push-agent review on
    // #1566). Kitty-encoded Ctrl+Z is used because escape sequences split
    // within a chunk; bare '\x1a\x1a' would parse as no key at all.
    const { stdin, hook, instance, lifecycle } = await mountSurface();
    try {
      // Three distinct steps: '' → 'ab' (run) → '' (kill) → 'xy' (run).
      await typeChars(stdin, hook, 'ab');
      stdin.send(CTRL_U);
      await waitForInput(hook, '');
      await typeChars(stdin, hook, 'xy');

      // Two undo key events in one chunk: 'xy' → '' → 'ab'.
      stdin.send(KITTY_CTRL_Z + KITTY_CTRL_Z);
      await waitForInput(hook, 'ab');

      // One redo must return to '' — under the stale-value bug the redo stack
      // holds ['xy','xy'] and jumps straight back to 'xy'.
      stdin.send(KITTY_CTRL_SHIFT_Z);
      await waitForInput(hook, '');
      stdin.send(KITTY_CTRL_SHIFT_Z);
      await waitForInput(hook, 'xy');
    } finally {
      instance.unmount();
      await lifecycle;
    }
  });

  it('a new edit after undo clears the redo stack', {
    skip: silverySkip,
  }, async () => {
    const { stdin, hook, instance, lifecycle } = await mountSurface();
    try {
      await typeChars(stdin, hook, 'ab');
      stdin.send(CTRL_Z);
      await waitForInput(hook, '');
      await typeChars(stdin, hook, 'c');
      stdin.send(KITTY_CTRL_SHIFT_Z);
      await sleep(120);
      assert.equal(hook.getComposerState().input, 'c');
    } finally {
      instance.unmount();
      await lifecycle;
    }
  });
});
