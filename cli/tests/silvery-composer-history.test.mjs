import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';

const nodeMajor = Number(process.versions.node.split('.')[0]);
const silverySkip =
  nodeMajor < 24 ? `silvery 0.21 requires Node >=24 (current: ${process.version})` : false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('composer history navigation kernel', () => {
  it('captures entries at the first Up and walks newest to oldest', async () => {
    const { createComposerHistoryNav } = await import('../tui-composer-history.ts');
    const nav = createComposerHistoryNav(() => ['alpha', 'beta']);

    assert.equal(nav.isNavigating(), false);
    assert.equal(nav.recall('up', ''), 'beta');
    assert.equal(nav.isNavigating(), true);
    assert.equal(nav.recall('up', 'beta'), 'alpha');
    // At the oldest: the key is not consumed, the run stays live.
    assert.equal(nav.recall('up', 'alpha'), null);
    assert.equal(nav.isNavigating(), true);
  });

  it('walks Down back toward the stashed draft and ends the run there', async () => {
    const { createComposerHistoryNav } = await import('../tui-composer-history.ts');
    const nav = createComposerHistoryNav(() => ['alpha', 'beta']);

    assert.equal(nav.recall('up', 'my draft'), 'beta');
    assert.equal(nav.recall('up', 'beta'), 'alpha');
    assert.equal(nav.recall('down', 'alpha'), 'beta');
    // Past the newest: the draft stashed at the first Up comes back and the
    // run ends — the next Up must re-capture, not replay this run's list.
    assert.equal(nav.recall('down', 'beta'), 'my draft');
    assert.equal(nav.isNavigating(), false);
  });

  it('returns the empty stash as a real recall, not a rejected key', async () => {
    const { createComposerHistoryNav } = await import('../tui-composer-history.ts');
    const nav = createComposerHistoryNav(() => ['alpha']);

    assert.equal(nav.recall('up', ''), 'alpha');
    assert.equal(nav.recall('down', 'alpha'), '');
    assert.equal(nav.isNavigating(), false);
  });

  it('rejects Down while not navigating', async () => {
    const { createComposerHistoryNav } = await import('../tui-composer-history.ts');
    const nav = createComposerHistoryNav(() => ['alpha']);

    assert.equal(nav.recall('down', 'anything'), null);
    assert.equal(nav.isNavigating(), false);
  });

  it('re-captures live entries after a run ends', async () => {
    const { createComposerHistoryNav } = await import('../tui-composer-history.ts');
    const entries = ['alpha'];
    const nav = createComposerHistoryNav(() => entries);

    assert.equal(nav.recall('up', ''), 'alpha');
    assert.equal(nav.recall('down', 'alpha'), '');
    entries.push('beta');
    assert.equal(nav.recall('up', ''), 'beta');
  });

  it('reset ends the run so the next Up stashes the edited draft', async () => {
    const { createComposerHistoryNav } = await import('../tui-composer-history.ts');
    const nav = createComposerHistoryNav(() => ['alpha', 'beta']);

    assert.equal(nav.recall('up', ''), 'beta');
    nav.reset();
    assert.equal(nav.isNavigating(), false);
    // The edited text becomes the new stash of a fresh run.
    assert.equal(nav.recall('up', 'beta edited'), 'beta');
    assert.equal(nav.recall('down', 'beta'), 'beta edited');
  });

  it('does not get stuck when history is empty at the first Up', async () => {
    const { createComposerHistoryNav } = await import('../tui-composer-history.ts');
    const entries = [];
    const nav = createComposerHistoryNav(() => entries);

    assert.equal(nav.recall('up', 'draft'), null);
    assert.equal(nav.isNavigating(), false);
    entries.push('alpha');
    assert.equal(nav.recall('up', 'draft'), 'alpha');
  });

  it('collapses consecutive duplicate prompts', async () => {
    const { createComposerHistoryNav } = await import('../tui-composer-history.ts');
    const nav = createComposerHistoryNav(() => ['same', 'same', 'other']);

    assert.equal(nav.recall('up', ''), 'other');
    assert.equal(nav.recall('up', 'other'), 'same');
    assert.equal(nav.recall('up', 'same'), null);
  });
});

// ── Integration: arrow keys through the real TextArea ───────────────

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
const DOWN = '\x1b[B';

describe('composer prompt-history recall (surface integration)', () => {
  // Drives the production path: raw arrow-key bytes → silvery TextArea →
  // onEdge → history nav → composer state. Asserting on getComposerState()
  // pins the composer's actual controlled value, not a helper's output.
  async function mountSurface(promptHistory) {
    const React = (await import('react')).default;
    const Silvery = await import('silvery');
    const { PushSurface } = await import('../silvery/surface.tsx');
    const stdout = new FakeStdout(72, 20);
    const stdin = new FakeStdin();
    const hook = {};
    const submissions = [];
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
      submit: async (text) => {
        // Mirror the real controller: a submitted prompt becomes part of the
        // persisted history the next navigation run captures.
        submissions.push(text);
        promptHistory.push(text);
      },
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
    return { stdin, hook, submissions, instance, lifecycle };
  }

  async function waitForInput(hook, expected) {
    for (let i = 0; i < 100 && hook.getComposerState().input !== expected; i++) await sleep(10);
    assert.equal(hook.getComposerState().input, expected);
  }

  it('recalls prompts on Up, cycles back to the draft on Down', {
    skip: silverySkip,
  }, async () => {
    const { stdin, hook, instance, lifecycle } = await mountSurface(['alpha', 'beta']);
    try {
      assert.equal(hook.getState().inputActive, true);

      stdin.send(UP);
      await waitForInput(hook, 'beta');
      stdin.send(UP);
      await waitForInput(hook, 'alpha');
      // At the oldest, Up is a no-op — the composer keeps the oldest entry.
      stdin.send(UP);
      await sleep(60);
      assert.equal(hook.getComposerState().input, 'alpha');

      stdin.send(DOWN);
      await waitForInput(hook, 'beta');
      // Past the newest: back to the (empty) draft.
      stdin.send(DOWN);
      await waitForInput(hook, '');
    } finally {
      instance.unmount();
      await lifecycle;
    }
  });

  it('preserves a non-empty draft across a recall cycle', {
    skip: silverySkip,
  }, async () => {
    const { stdin, hook, instance, lifecycle } = await mountSurface(['alpha', 'beta']);
    try {
      hook.setComposerInput('work in progress');
      await sleep(60);

      stdin.send(UP);
      await waitForInput(hook, 'beta');
      stdin.send(DOWN);
      await waitForInput(hook, 'work in progress');
    } finally {
      instance.unmount();
      await lifecycle;
    }
  });

  it('a user edit ends the run and the edit becomes the next stash', {
    skip: silverySkip,
  }, async () => {
    const { stdin, hook, instance, lifecycle } = await mountSurface(['alpha', 'beta']);
    try {
      stdin.send(UP);
      await waitForInput(hook, 'beta');

      // The TextArea reports user keystrokes through changeComposerInput;
      // driving it directly models an edit landing on the recalled text.
      hook.changeComposerInput('beta edited');
      await waitForInput(hook, 'beta edited');

      stdin.send(UP);
      await waitForInput(hook, 'beta');
      stdin.send(DOWN);
      await waitForInput(hook, 'beta edited');
    } finally {
      instance.unmount();
      await lifecycle;
    }
  });

  it('recalling an entry identical to the multi-line draft still moves the cursor to the end', {
    skip: silverySkip,
  }, async () => {
    // Flagged by review on #1565: when the recalled text equals the current
    // controlled value, the TextArea's value prop doesn't change, so the
    // cursor-to-end move must not depend on a value-driven re-render. The
    // cursor position is asserted through its behavior: at the END of a
    // two-line entry the next Up moves the cursor up a row (no recall); only
    // the Up after that reaches the top edge and recalls the older entry.
    const { stdin, hook, instance, lifecycle } = await mountSurface(['other', 'same\nlines']);
    try {
      hook.setComposerInput('same\nlines');
      await sleep(80);

      // Cursor starts at offset 0 (row 0) — the first Up is a top edge and
      // recalls the newest entry, which is identical to the draft.
      stdin.send(UP);
      await sleep(120);
      assert.equal(hook.getComposerState().input, 'same\nlines');

      // Cursor must now be at the end (row 1): this Up moves within the
      // buffer and must NOT recall 'other'. A cursor stuck at row 0 would
      // fire the edge again and load 'other' here.
      stdin.send(UP);
      await sleep(120);
      assert.equal(hook.getComposerState().input, 'same\nlines');

      // Now at row 0 — this Up is the edge and recalls the older entry.
      stdin.send(UP);
      await waitForInput(hook, 'other');
    } finally {
      instance.unmount();
      await lifecycle;
    }
  });

  it('Tab completion ends the run — Down keeps the completed text, not the stash', {
    skip: silverySkip,
  }, async () => {
    // Codex P2 on #1565: complete() edits the composer through setInput
    // directly, bypassing changeComposerInput's reset. Without its own reset,
    // Down after completing a recalled entry restores the pre-recall stash
    // and silently discards the completed edit.
    const { stdin, hook, instance, lifecycle } = await mountSurface(['/mod']);
    try {
      hook.setComposerInput('draft x');
      await sleep(80);

      stdin.send(UP);
      await waitForInput(hook, '/mod');

      hook.complete();
      let completed = '';
      for (let i = 0; i < 100; i++) {
        completed = hook.getComposerState().input;
        if (completed.startsWith('/model')) break;
        await sleep(10);
      }
      assert.ok(completed.startsWith('/model'), `Tab should complete /mod, got '${completed}'`);

      // The run is over: Down must not restore 'draft x' over the completion.
      stdin.send(DOWN);
      await sleep(120);
      assert.equal(hook.getComposerState().input, completed);

      // And a fresh Up stashes the completed text, so Down brings it back.
      stdin.send(UP);
      await waitForInput(hook, '/mod');
      stdin.send(DOWN);
      await waitForInput(hook, completed);
    } finally {
      instance.unmount();
      await lifecycle;
    }
  });

  it('a submitted prompt is recallable on the next Up', {
    skip: silverySkip,
  }, async () => {
    const { stdin, hook, submissions, instance, lifecycle } = await mountSurface(['alpha']);
    try {
      await hook.submit('gamma');
      assert.deepEqual(submissions, ['gamma']);
      await waitForInput(hook, '');

      stdin.send(UP);
      await waitForInput(hook, 'gamma');
      stdin.send(UP);
      await waitForInput(hook, 'alpha');
    } finally {
      instance.unmount();
      await lifecycle;
    }
  });
});
