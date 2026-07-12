// Adopt-gate stress scenes 5, 8, 9-react, 15 — the cases the first driven run
// skipped that actually decide framework-adopt. Driven through the real pipeline
// on fake TTY streams; emitted ANSI verified with @xterm/headless.
//   5  modal restore WITHOUT full-screen clear (byte-level ESC[2J check)
//   8  occluded update (mutate under a modal; invisible until close)
//   9  React-wired hit path (inject SGR click → correct onClick fires, z-correct)
//   15 perf floor (single-line change is O(damage), not O(screen))
// Run: COLORTERM=truecolor TERM=xterm-256color node stress-adopt.mjs [debug]
import React from 'react';
import { EventEmitter } from 'node:events';
import * as S from 'silvery';
import xterm from '@xterm/headless';
process.env.COLORTERM = 'truecolor';
process.env.TERM = 'xterm-256color';

const h = React.createElement;
const DEBUG = process.argv.includes('debug');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  unref() {
    return this;
  }
  ref() {
    return this;
  }
  read() {
    return null;
  }
  send(seq) {
    this.emit('data', Buffer.from(seq, 'utf8'));
  }
}

function xtermScreen(bytes, cols, rows) {
  const t = new xterm.Terminal({ cols, rows, allowProposedApi: true });
  return new Promise((res) => {
    t.write(bytes, () => {
      const lines = [];
      for (let y = 0; y < rows; y++)
        lines.push(t.buffer.active.getLine(y)?.translateToString(true) ?? '');
      const cellAt = (x, y) => {
        const c = t.buffer.active.getLine(y)?.getCell(x);
        return c ? { chars: c.getChars(), width: c.getWidth(), bg: c.getBgColor() } : null;
      };
      t.dispose();
      res({ lines, cellAt });
    });
  });
}

let pass = 0,
  fail = 0;
const notes = [];
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + detail : ''}`);
  cond ? pass++ : fail++;
};

function drive(element, cols, rows, opts = {}) {
  const stdout = new FakeStdout(cols, rows);
  const stdin = new FakeStdin();
  const inst = S.render(element, {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    ...opts,
  });
  inst.run?.().catch(() => {});
  return {
    stdout,
    stdin,
    inst,
    done: () => {
      try {
        inst?.unmount?.();
      } catch {}
    },
  };
}

// Absolute-positioned overlay wrapping a ModalDialog so it actually covers
// content (ModalDialog is just a styled Box — the app owns positioning).
function Overlay({ children, marginLeft, marginTop }) {
  return h(S.Box, { position: 'absolute', marginLeft, marginTop, width: 24, height: 4 }, children);
}

// ── Scene 5: modal restore without full-screen clear ──
function ModalApp({ hook, cols }) {
  const [open, setOpen] = React.useState(false);
  hook.setOpen = setOpen;
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(h(S.Text, { key: i }, `row-${i} ${'·abcdef'.repeat(3)}`));
  return h(
    S.Box,
    { flexDirection: 'column', width: cols, height: 8 },
    ...rows,
    open
      ? h(
          Overlay,
          { marginLeft: 8, marginTop: 2 },
          h(
            S.ModalDialog,
            { title: 'MODAL', width: 22, height: 4, backgroundColor: 'blue' },
            h(S.Text, null, 'dialog body'),
          ),
        )
      : null,
  );
}
async function scene5() {
  const COLS = 44,
    ROWS = 8;
  const hook = {};
  const d = drive(h(ModalApp, { hook, cols: COLS }), COLS, ROWS);
  await sleep(90);
  const baseline = await xtermScreen(d.stdout.bytes, COLS, ROWS);
  hook.setOpen(true);
  await sleep(90);
  const openScreen = await xtermScreen(d.stdout.bytes, COLS, ROWS);
  const closeMark = d.stdout.mark();
  hook.setOpen(false);
  await sleep(90);
  const closeBytes = d.stdout.since(closeMark);
  const afterClose = await xtermScreen(d.stdout.bytes, COLS, ROWS);
  d.done();

  // overlap check: row 2 originally shows row-2 content; with modal open the
  // modal border must occlude the middle of that row.
  const modalDrew = openScreen.lines.some((l) => l.includes('MODAL'));
  const occluded =
    openScreen.lines[3] && !openScreen.lines[3].startsWith('row-3 ·abcdef·abcdef·abcdef');
  check(
    '5 modal drew AND overlaps content (occludes a content row)',
    modalDrew && occluded,
    `modalDrew=${modalDrew} row3=${JSON.stringify(openScreen.lines[3])}`,
  );
  check(
    '5 close emits NO full-screen clear (ESC[2J)',
    !/\x1b\[2J/.test(closeBytes),
    `closeBytes=${closeBytes.length}ch has2J=${/\x1b\[2J/.test(closeBytes)}`,
  );
  check(
    '5 underlying content restored on close (matches baseline)',
    afterClose.lines.join('\n') === baseline.lines.join('\n'),
    afterClose.lines[3] === baseline.lines[3]
      ? 'all rows match'
      : `row3 diff: ${JSON.stringify(afterClose.lines[3])}`,
  );
  check('5 modal fully gone after close', !afterClose.lines.some((l) => l.includes('MODAL')), '');
  if (DEBUG) console.log('  [open]\n' + openScreen.lines.map((l) => '   |' + l).join('\n'));
}

// ── Scene 8: occluded update — mutate under a modal ──
function OccludeApp({ hook, cols }) {
  const [n, setN] = React.useState(0);
  const [open, setOpen] = React.useState(true);
  hook.tick = () => setN((v) => v + 1);
  hook.close = () => setOpen(false);
  return h(
    S.Box,
    { flexDirection: 'column', width: cols, height: 8 },
    h(S.Text, null, `counter=${n} xxxxxxxxxxxxxxxxxxxxxxxx`),
    h(S.Text, null, `counter=${n} yyyyyyyyyyyyyyyyyyyyyyyy`),
    h(S.Text, null, `counter=${n} zzzzzzzzzzzzzzzzzzzzzzzz`),
    open
      ? h(
          Overlay,
          { marginLeft: 4, marginTop: 0 },
          h(
            S.ModalDialog,
            { title: 'OVER', width: 24, height: 4, backgroundColor: 'red' },
            h(S.Text, null, 'occluder'),
          ),
        )
      : null,
  );
}
async function scene8() {
  const COLS = 40,
    ROWS = 8;
  const hook = {};
  const d = drive(h(OccludeApp, { hook, cols: COLS }), COLS, ROWS);
  await sleep(90);
  // tick the underlying counter (0→3) while the modal covers rows 0..3
  hook.tick();
  hook.tick();
  hook.tick();
  await sleep(90);
  const stillModal = await xtermScreen(d.stdout.bytes, COLS, ROWS);
  // occlusion: the covered region must show the modal, and counter=3 must NOT
  // be visible anywhere yet (all three counter lines are under the modal).
  const modalVisible = stillModal.lines.some((l) => l.includes('OVER') || l.includes('occluder'));
  const leaked = stillModal.lines.some((l) => l.includes('counter=3'));
  check(
    '8 modal occludes the mutated content (no counter=3 leak-through)',
    modalVisible && !leaked,
    `modalVisible=${modalVisible} leaked=${leaked}`,
  );
  // close — the NEW value must now appear
  hook.close();
  await sleep(90);
  const afterClose = await xtermScreen(d.stdout.bytes, COLS, ROWS);
  d.done();
  check(
    '8 underlying update revealed on close (counter=3)',
    afterClose.lines.filter((l) => l.includes('counter=3')).length >= 1,
    `count=${afterClose.lines.filter((l) => l.includes('counter=3')).length}`,
  );
  if (DEBUG) console.log('  [stillModal]\n' + stillModal.lines.map((l) => '   |' + l).join('\n'));
}

// ── Scene 9: hit routing via the REAL reconciler hitTest (event-handlers.ts:82) ──
// Grab an AgNode via Box ref, walk to root, call the exported hitTest — the exact
// function the runtime invokes on a mouse click. Verifies the z-order routing
// DECISION end-to-end (short of the onClick invocation, which needs a live TTY).
function nearestTagged(node) {
  let n = node;
  while (n) {
    const id = n.props?.testID;
    if (id) return id;
    n = n.parent;
  }
  return null;
}
function HitApp({ hook, cols, rows }) {
  const ref = React.useRef(null);
  React.useEffect(() => {
    let n = ref.current?.getNode?.();
    while (n?.parent) n = n.parent;
    hook.root = n;
  });
  return h(
    S.Box,
    { ref, width: cols, height: rows },
    // bottom: screen cols 2..13, rows 1..3; leading 中 occupies cols 2-3
    h(
      S.Box,
      {
        testID: 'bottom',
        position: 'absolute',
        marginLeft: 2,
        marginTop: 1,
        width: 12,
        height: 3,
        backgroundColor: 'blue',
      },
      h(S.Text, null, '中中 bottomxx'),
    ),
    // top: screen cols 6..17, rows 1..3 (overlaps bottom at cols 6..13)
    h(
      S.Box,
      {
        testID: 'top',
        position: 'absolute',
        marginLeft: 6,
        marginTop: 1,
        width: 12,
        height: 3,
        backgroundColor: 'red',
      },
      h(S.Text, null, 'top'),
    ),
  );
}
async function scene9() {
  const COLS = 24,
    ROWS = 6;
  const hook = {};
  const d = drive(h(HitApp, { hook, cols: COLS, rows: ROWS }), COLS, ROWS);
  await sleep(120);
  if (!hook.root) {
    check('9 root node captured via ref', false, 'ref.getNode() → root walk failed');
    d.done();
    return;
  }
  const at = (x, y) => nearestTagged(S.hitTest(hook.root, x, y));
  check(
    '9 overlap point routes to TOP layer (z-correct, not smallest-area)',
    at(10, 2) === 'top',
    `hit=${at(10, 2)}`,
  );
  check('9 bottom-only point routes to bottom', at(3, 2) === 'bottom', `hit=${at(3, 2)}`);
  check('9 top-only point routes to top', at(16, 2) === 'top', `hit=${at(16, 2)}`);
  // wide-glyph continuation: 中 lead at screen col 2, continuation at col 3;
  // both must resolve to the bottom box (continuation inherits lead's target).
  check('9 wide-glyph lead cell (col 2) hits its box', at(2, 1) === 'bottom', `hit=${at(2, 1)}`);
  check(
    '9 wide-glyph CONTINUATION cell (col 3) hits same box as lead',
    at(3, 1) === 'bottom',
    `hit=${at(3, 1)}`,
  );
  d.done();
}

// ── Scene 15: perf floor — single-line change is O(damage), not O(screen) ──
function ScrollApp({ hook, cols, rows }) {
  const [tick, setTick] = React.useState(0);
  hook.bump = () => setTick((v) => v + 1);
  const lines = [];
  for (let i = 0; i < rows; i++)
    lines.push(
      h(
        S.Text,
        { key: i },
        i === 0 ? `LIVE ${tick} ${'x'.repeat(cols - 10)}` : `static ${i} ${'.'.repeat(cols - 12)}`,
      ),
    );
  return h(S.Box, { flexDirection: 'column', width: cols, height: rows }, ...lines);
}
async function measureUpdate(cols, rows) {
  const hook = {};
  const d = drive(h(ScrollApp, { hook, cols, rows }), cols, rows);
  await sleep(90);
  const full = d.stdout.bytes.length; // full initial paint
  const mark = d.stdout.mark();
  hook.bump(); // change ONE line (row 0)
  await sleep(90);
  const update = d.stdout.since(mark).length;
  d.done();
  return { full, update };
}
async function scene15() {
  const small = await measureUpdate(80, 10);
  const tall = await measureUpdate(80, 40);
  check(
    '15 single-line update is sublinear vs full paint (80x40)',
    tall.update < tall.full / 4,
    `update=${tall.update} full=${tall.full}`,
  );
  check(
    '15 update cost ~O(damage) not O(screen): 40-row ≈ 10-row for same 1-line change',
    tall.update < small.update * 2.5,
    `10row=${small.update} 40row=${tall.update}`,
  );
  notes.push(
    `15 INFO: 80x10 full=${small.full} upd=${small.update} | 80x40 full=${tall.full} upd=${tall.update}`,
  );
}

const only = process.argv.find((a) => /^scene\d+$/.test(a));
const scenes = { scene5, scene8, scene9, scene15 };
for (const [name, fn] of Object.entries(scenes)) {
  if (only && name !== only) continue;
  console.log(`\n── ${name} ──`);
  try {
    await fn();
  } catch (e) {
    check(
      `${name} completed without harness error`,
      false,
      e.message + '\n' + (e.stack ?? '').split('\n').slice(1, 3).join('\n'),
    );
  }
}
console.log(`\n${pass} pass, ${fail} fail`);
for (const n of notes) console.log('NOTE:', n);
process.exit(fail ? 1 : 0);
