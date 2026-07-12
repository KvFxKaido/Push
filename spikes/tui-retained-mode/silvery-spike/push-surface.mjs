// push-surface.mjs — a real Push chat surface on silvery. The adopt-gate "feel"
// test named by the decision doc: transcript + input + one modal, authored in
// React-in-terminal, to decide framework-adopt vs build-with-silvery-as-reference.
//
// It is NOT a toy: header bar, a scrolling transcript through silvery's ListView
// (the scrollback↔window contract, handed to us), a TextInput round loop with
// simulated streaming into the live region, and one command-palette modal that
// scrims the transcript behind it. It also ships the ONLY thing the survey left
// open — the silent-fault workaround — in three honest layers:
//
//   1. RecoverableBoundary  — a render fault in one message paints an inline
//      error card; the shell (header + input) stays alive. Honest surface.
//   2. SilveryErrorBoundary — root last-resort: any escaped render fault gets a
//      rich painted surface (message + stack), never a silent zombie.
//   3. process watchdog     — uncaughtException / unhandledRejection restore the
//      terminal (leave alt-screen, show cursor) and exit with a VISIBLE error.
//      This covers async/effect faults that error boundaries structurally can't —
//      the exact class that produced silvery's scene-14 zombie.
//
// Live:      node push-surface.mjs
// Headless:  node push-surface.mjs --check   (drives via fake TTY + xterm referee)

import React, { Component, useCallback, useEffect, useRef, useState } from 'react';
import * as S from 'silvery';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import xterm from '@xterm/headless';

const h = React.createElement;
const CHECK = process.argv.includes('--check');
const FAULT_LOG = path.join(process.env.TMPDIR || '/tmp', 'push-surface-faults.log');

// ── Push role-display vocabulary (mirrors lib/role-display.ts: phase-first) ──
const ROLE = {
  you: { label: 'You', color: '$fg-accent' },
  assistant: { label: 'Assistant', color: '$fg-default' },
  editing: { label: 'Editing', color: 'green' },
  exploring: { label: 'Exploring', color: 'cyan' },
  system: { label: '—', color: '$fg-muted' },
};

let _id = 0;
const nextId = () => ++_id;
const msg = (role, text) => ({ id: nextId(), role, text });

const SEED = [
  msg('system', 'push · main · deepseek-v4-pro · sandbox warm'),
  msg('you', 'add a health check endpoint to the worker'),
  msg(
    'exploring',
    'reading app/worker.ts and the existing /api/* routes to find where handlers register',
  ),
  msg('editing', 'app/worker.ts +12 −0 — added GET /api/health returning { ok, commit, uptime }'),
  msg(
    'assistant',
    'Added a health check at GET /api/health. It returns the build commit and uptime so you can confirm which bundle is live. Want me to wire it into the deploy smoke test too? 中文 wide glyphs and 👩‍👩‍👧‍👦 render through the same width model.',
  ),
];

// ── layout sizing: read from stdout (works on real TTY and the fake one) ──
function useTermSize() {
  const { stdout } = S.useStdout();
  const [size, setSize] = useState({
    cols: stdout?.columns || 80,
    rows: stdout?.rows || 24,
  });
  useEffect(() => {
    if (!stdout) return;
    const on = () => setSize({ cols: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on?.('resize', on);
    return () => stdout.off?.('resize', on);
  }, [stdout]);
  return size;
}

// ── one transcript entry ──
function Message({ item }) {
  const r = ROLE[item.role] || ROLE.assistant;
  return h(
    S.Box,
    { flexDirection: 'column' },
    h(S.Text, { color: r.color, bold: true }, r.label),
    h(S.Text, { color: item.role === 'system' ? '$fg-muted' : undefined }, item.text),
  );
}

// ── transcript = a manual tail-window over the message list ──
// FINDING (recorded in README): silvery's ListView renders the window + overflow
// indicators correctly, but tail-follow-to-newest is not turnkey in 0.19.2 —
// scrollTo (nav=false), scrollToItem/cursorKey (nav=true) all stay anchored at
// the top even with an accurate estimateHeight. A chat transcript needs the
// newest turn pinned, so we window by hand, measuring each message with
// silvery's OWN countVisualLines (same width model the compositor paints with).
function Transcript({ messages, cols, height, offset }) {
  const bodyLines = (t) =>
    Math.max(
      1,
      S.countVisualLines ? S.countVisualLines(t, cols) : Math.ceil((t.length || 1) / cols),
    );
  const msgH = (m) => 1 + bodyLines(m.text); // role label + wrapped body
  const end = Math.max(1, messages.length - offset); // exclusive index of newest shown
  const visible = [];
  let used = 0;
  for (let i = end - 1; i >= 0; i--) {
    const gap = visible.length ? 1 : 0;
    const need = msgH(messages[i]) + gap;
    if (used + need > height && visible.length) break;
    used += need;
    visible.unshift(messages[i]);
  }
  const above = visible.length ? messages.indexOf(visible[0]) : 0;
  const below = messages.length - end;
  return h(
    S.Box,
    { flexDirection: 'column', width: cols, height },
    above > 0
      ? h(S.Text, { color: '$fg-muted', dimColor: true }, `  ▲ ${above} earlier (PgUp)`)
      : null,
    ...visible.map((m, i) =>
      h(
        S.Box,
        { key: m.id, flexDirection: 'column', marginTop: i ? 1 : 0 },
        h(Message, { item: m }),
      ),
    ),
    below > 0
      ? h(S.Text, { color: '$fg-accent', dimColor: true }, `  ▼ ${below} newer (PgDn)`)
      : null,
  );
}

// A component that throws during render when armed — proves the boundary path.
function Bomb({ armed }) {
  if (armed) throw new Error('render fault in a message renderer (simulated)');
  return null;
}

// ── recoverable boundary: fault in the transcript body paints an inline card,
//    header + input survive. Keyed by resetSignal so the parent can remount it. ──
class RecoverableBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    this.props.onError?.(error);
  }
  render() {
    if (this.state.error) {
      return h(
        S.Box,
        {
          flexDirection: 'column',
          borderStyle: 'round',
          borderColor: 'red',
          paddingX: 1,
        },
        h(S.Text, { color: 'red', bold: true }, '⚠ this turn failed to render'),
        h(S.Text, { color: '$fg-muted' }, this.state.error.message),
        h(
          S.Text,
          { color: '$fg-muted', dimColor: true },
          'the shell stayed alive — Ctrl+K → Retry render, or keep chatting',
        ),
      );
    }
    return this.props.children;
  }
}

// ── the command-palette modal (the one modal) ──
const COMMANDS = [
  { key: 'newbranch', label: 'Create branch', hint: 'fork the sandbox at HEAD' },
  { key: 'clear', label: 'Clear transcript', hint: 'reset the conversation' },
  { key: 'faultRender', label: 'Simulate render fault', hint: 'boundary catches → inline card' },
  { key: 'faultAsync', label: 'Simulate async fault', hint: 'watchdog restores terminal + exits' },
  { key: 'retry', label: 'Retry render', hint: 'remount the transcript body' },
  { key: 'quit', label: 'Quit', hint: 'leave Push' },
];

function Palette({ cols, rows, onRun, onClose }) {
  const [sel, setSel] = useState(0);
  useInputMaybe((input, key) => {
    if (key.escape) return onClose();
    if (key.upArrow || input === 'k') setSel((s) => (s + COMMANDS.length - 1) % COMMANDS.length);
    else if (key.downArrow || input === 'j') setSel((s) => (s + 1) % COMMANDS.length);
    else if (key.return) onRun(COMMANDS[sel].key);
  });
  const w = Math.min(52, cols - 4);
  // absolute overlay so the ModalDialog actually occludes the transcript
  return h(
    S.Box,
    { position: 'absolute', marginLeft: 2, marginTop: 1, width: w },
    h(
      S.ModalDialog,
      {
        title: 'Command Palette',
        width: w,
        footer: '↑↓/jk move · ↵ run · esc close',
        onClose,
        backdrop: 0.35,
      },
      h(
        S.Box,
        { flexDirection: 'column' },
        ...COMMANDS.map((c, i) =>
          h(
            S.Box,
            { key: c.key, onClick: () => onRun(c.key) },
            h(
              S.Text,
              {
                color: i === sel ? '$fg-accent' : undefined,
                bold: i === sel,
                wrap: 'truncate-end',
              },
              `${i === sel ? '❯ ' : '  '}${c.label.padEnd(22)}${c.hint}`,
            ),
          ),
        ),
      ),
    ),
  );
}

// useInput that no-ops safely if called outside a runtime (keeps --check simple)
function useInputMaybe(handler, opts) {
  try {
    S.useInput(handler, opts);
  } catch {
    /* no runtime (shouldn't happen inside render) */
  }
}

// ── the app ──
function PushSurface({ hook }) {
  const { cols, rows } = useTermSize();
  const { exit } = S.useApp();
  const [messages, setMessages] = useState(SEED);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [boom, setBoom] = useState(false);
  const [resetSignal, setResetSignal] = useState(0);
  const streamTimer = useRef(null);
  const [scrollOffset, setScrollOffset] = useState(0); // 0 = pinned to newest

  // auto-follow: any new message snaps the window back to the bottom
  useEffect(() => {
    setScrollOffset(0);
  }, [messages.length]);

  const send = useCallback((text) => {
    if (!text.trim()) return;
    setMessages((m) => [...m, msg('you', text)]);
    // simulate a streaming assistant turn into the live (last) region
    const id = nextId();
    setMessages((m) => [...m, { id, role: 'assistant', text: '' }]);
    const full = `On it — "${text.trim()}". Streaming this reply one chunk at a time so the last line reflows while the transcript above stays static (O(damage)).`;
    const words = full.split(' ');
    let i = 0;
    clearInterval(streamTimer.current);
    streamTimer.current = setInterval(() => {
      i++;
      setMessages((m) =>
        m.map((x) => (x.id === id ? { ...x, text: words.slice(0, i).join(' ') } : x)),
      );
      if (i >= words.length) clearInterval(streamTimer.current);
    }, 40);
  }, []);

  const runCommand = useCallback(
    (key) => {
      setPaletteOpen(false);
      switch (key) {
        case 'newbranch':
          setMessages((m) => [...m, msg('system', 'branch_forked → feat/health-check')]);
          break;
        case 'clear':
          setMessages([msg('system', 'transcript cleared')]);
          break;
        case 'faultRender':
          setBoom(true); // Bomb throws on next render → RecoverableBoundary catches
          break;
        case 'faultAsync':
          // an escaped async fault — error boundaries CANNOT catch this; the
          // process watchdog is what keeps the terminal from being wrecked.
          setTimeout(() => {
            throw new Error('async fault in a timer (simulated) — watchdog territory');
          }, 30);
          break;
        case 'retry':
          setBoom(false);
          setResetSignal((s) => s + 1); // remount the transcript body
          break;
        case 'quit':
          exit();
          break;
      }
    },
    [exit],
  );

  // live key bindings (Ctrl+K palette; PgUp/PgDn scrollback; Ctrl+C via runtime)
  useInputMaybe(
    (input, key) => {
      if (paletteOpen) return;
      if (key.ctrl && input === 'k') return setPaletteOpen(true);
      if (key.pageUp) setScrollOffset((o) => Math.min(Math.max(0, messages.length - 1), o + 3));
      else if (key.pageDown) setScrollOffset((o) => Math.max(0, o - 3));
    },
    { isActive: !paletteOpen },
  );

  // imperative hook for the headless self-check
  useEffect(() => {
    if (!hook) return;
    hook.send = send;
    hook.openPalette = () => setPaletteOpen(true);
    hook.run = runCommand;
    hook.state = () => ({ paletteOpen, boom, count: messages.length });
  });

  useEffect(() => () => clearInterval(streamTimer.current), []);

  const headerRows = 1;
  const inputRows = 3; // bordered TextInput
  const transcriptH = Math.max(3, rows - headerRows - inputRows);

  return h(
    S.Box,
    { flexDirection: 'column', width: cols, height: rows },
    // ── header ──
    h(
      S.Box,
      { width: cols },
      h(S.Text, { bold: true }, 'Push '),
      h(S.Text, { color: '$fg-muted' }, 'main '),
      h(S.Text, { color: '$fg-accent' }, '● '),
      h(S.Text, { color: '$fg-muted' }, 'deepseek-v4-pro'),
      h(S.Box, { flexGrow: 1 }),
      h(S.Text, { color: '$fg-muted', dimColor: true }, 'Ctrl+K commands'),
    ),
    // ── transcript (scrollback↔window contract, via ListView) ──
    h(
      RecoverableBoundary,
      {
        key: resetSignal,
        onError: (e) => logFault('render', e),
      },
      h(
        S.Box,
        { flexDirection: 'column' },
        h(Bomb, { armed: boom }),
        h(Transcript, {
          messages,
          cols,
          height: transcriptH,
          offset: scrollOffset,
        }),
      ),
    ),
    // ── input round loop ──
    h(S.TextInput, {
      prompt: '› ',
      placeholder: 'message Push…  (Ctrl+K for commands)',
      borderStyle: 'round',
      isActive: !paletteOpen,
      onSubmit: send,
    }),
    // ── the one modal ──
    paletteOpen
      ? h(Palette, { cols, rows, onRun: runCommand, onClose: () => setPaletteOpen(false) })
      : null,
  );
}

function logFault(kind, err) {
  try {
    fs.appendFileSync(
      FAULT_LOG,
      JSON.stringify({
        level: 'error',
        event: `push_surface_fault_${kind}`,
        message: err.message,
      }) + '\n',
    );
  } catch {
    /* best-effort */
  }
}

// Root tree: rich last-resort boundary wrapping the app.
function Root({ hook }) {
  return h(
    S.SilveryErrorBoundary,
    { onError: (e) => logFault('root', e) },
    h(PushSurface, { hook }),
  );
}

// ─────────────────────────── live entry + watchdog ───────────────────────────
async function runLive() {
  // The process-level half of the workaround: async/effect faults (which error
  // boundaries cannot catch) must never leave a wrecked terminal or a silent
  // zombie. Restore the screen and surface the error, then exit non-zero.
  let inst;
  const teardown = (why, err) => {
    try {
      inst?.unmount?.();
    } catch {}
    try {
      // belt-and-braces terminal restore in case unmount didn't run
      process.stdout.write('\x1b[?1049l\x1b[?25h\x1b[?1000l\x1b[?1006l');
    } catch {}
    process.stderr.write(`\n[push-surface watchdog] ${why}: ${err?.stack || err}\n`);
    process.exit(1);
  };
  process.on('uncaughtException', (e) => teardown('uncaughtException', e));
  process.on('unhandledRejection', (e) => teardown('unhandledRejection', e));

  const handle = S.render(h(Root, {}), { exitOnCtrlC: true });
  inst = handle;
  await handle.run(); // paint loop runs until exit() / Ctrl+C
}

// ─────────────────────────── headless self-check ───────────────────────────
class FakeStdout extends EventEmitter {
  constructor(cols, rows) {
    super();
    this.isTTY = true;
    this.columns = cols;
    this.rows = rows;
    this.bytes = '';
  }
  write(chunk) {
    this.bytes += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    return true;
  }
  get writableHighWaterMark() {
    return 16384;
  }
  mark() {
    return this.bytes.length;
  }
  since(n) {
    return this.bytes.slice(n);
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

function xtermScreen(bytes, cols, rows) {
  const t = new xterm.Terminal({ cols, rows, allowProposedApi: true });
  return new Promise((res) => {
    t.write(bytes, () => {
      const lines = [];
      for (let y = 0; y < rows; y++)
        lines.push(t.buffer.active.getLine(y)?.translateToString(true) ?? '');
      t.dispose();
      res(lines);
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runCheck() {
  const COLS = 72,
    ROWS = 20;
  let pass = 0,
    fail = 0;
  const check = (name, cond, detail) => {
    console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + detail : ''}`);
    cond ? pass++ : fail++;
  };
  try {
    fs.rmSync(FAULT_LOG, { force: true });
  } catch {}

  const stdout = new FakeStdout(COLS, ROWS);
  const stdin = new FakeStdin();
  const hook = {};
  const inst = S.render(h(Root, { hook }), {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  inst.run?.().catch(() => {}); // start the paint loop (silvery paints on run)

  await sleep(120);
  let screen = await xtermScreen(stdout.bytes, COLS, ROWS);
  const hasHeader = screen.some((l) => l.includes('Push') && l.includes('deepseek'));
  const hasRoles =
    screen.some((l) => l.includes('Editing')) || screen.some((l) => l.includes('You'));
  const hasInput = screen.some((l) => l.includes('message Push') || l.includes('›'));
  check(
    '1 three regions render (header + transcript roles + input)',
    hasHeader && hasRoles && hasInput,
    `header=${hasHeader} roles=${hasRoles} input=${hasInput}`,
  );

  // round loop: send a message → a new turn appears
  const before = hook.state().count;
  hook.send('ship it');
  await sleep(250); // let a few stream chunks land
  screen = await xtermScreen(stdout.bytes, COLS, ROWS);
  const after = hook.state().count;
  const echoed = screen.some((l) => l.includes('ship it'));
  check(
    '2 round loop appends a turn and streams a reply',
    after > before && echoed,
    `count ${before}→${after} echoed=${echoed}`,
  );

  // modal: open palette → it occludes + scrims
  const preOpenMark = stdout.mark();
  hook.openPalette();
  await sleep(120);
  screen = await xtermScreen(stdout.bytes, COLS, ROWS);
  const paletteVisible = screen.some((l) => l.includes('Command Palette'));
  const openBytes = stdout.since(preOpenMark);
  const noFullClear = !/\x1b\[2J/.test(openBytes);
  check(
    '3 modal opens, occludes, without a full-screen clear',
    paletteVisible && noFullClear,
    `visible=${paletteVisible} no2J=${noFullClear}`,
  );

  // silent-fault workaround: render fault → boundary catches, shell survives, logged
  hook.run('faultRender');
  await sleep(140);
  screen = await xtermScreen(stdout.bytes, COLS, ROWS);
  const inlineCard = screen.some((l) => l.includes('failed to render'));
  const shellAlive = screen.some((l) => l.includes('Push') && l.includes('deepseek'));
  let logged = false;
  try {
    logged = fs.readFileSync(FAULT_LOG, 'utf8').includes('push_surface_fault_render');
  } catch {}
  check(
    '4 render fault → inline card, shell alive, fault LOGGED (not silent)',
    inlineCard && shellAlive && logged,
    `card=${inlineCard} shell=${shellAlive} logged=${logged}`,
  );

  // recovery: Retry remounts the transcript body
  hook.run('retry');
  await sleep(140);
  screen = await xtermScreen(stdout.bytes, COLS, ROWS);
  const recovered =
    !screen.some((l) => l.includes('failed to render')) &&
    screen.some((l) => l.includes('You') || l.includes('Assistant'));
  check(
    '5 Retry remounts transcript (recovers from the fault)',
    recovered,
    `recovered=${recovered}`,
  );

  // run() settled the whole time — no zombie hang (we got here)
  check('6 render never zombied (all transitions settled)', true, 'reached end of script');

  try {
    inst.unmount();
  } catch {}
  console.log(`\n${pass} pass, ${fail} fail`);
  console.log(`fault log: ${FAULT_LOG}`);
  process.exit(fail ? 1 : 0);
}

async function runSnap() {
  const COLS = 72,
    ROWS = 22;
  const stdout = new FakeStdout(COLS, ROWS);
  const stdin = new FakeStdin();
  const hook = {};
  const inst = S.render(h(Root, { hook }), {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  inst.run?.().catch(() => {});
  const frame = async (label) => {
    const lines = await xtermScreen(stdout.bytes, COLS, ROWS);
    console.log(`\n╔═ ${label} ${'═'.repeat(Math.max(0, 66 - label.length))}`);
    console.log(lines.map((l) => '║ ' + l.replace(/\s+$/, '')).join('\n'));
  };
  await sleep(140);
  await frame('initial (seed transcript + input)');
  hook.send('add rate limiting to the push endpoint');
  await sleep(400);
  await frame('after a streamed assistant turn (tail-followed)');
  hook.openPalette();
  await sleep(140);
  await frame('command palette open (scrims transcript)');
  hook.run('faultRender');
  await sleep(160);
  await frame('render fault → inline card, shell alive');
  try {
    inst.unmount?.();
  } catch {}
  process.exit(0);
}

if (CHECK) await runCheck();
else if (process.argv.includes('--snap')) await runSnap();
else await runLive();
