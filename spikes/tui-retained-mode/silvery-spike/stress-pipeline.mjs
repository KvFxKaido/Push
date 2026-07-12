// Driven stress scenes through the REAL render pipeline (fake TTY streams).
// Emitted ANSI is verified by two referees:
//   - silvery's own VirtualTerminal (their raster model)
//   - @xterm/headless (independent emulator — the referee that matters)
// Run: node stress-pipeline.mjs [sceneN]
import React from 'react';
import { EventEmitter } from 'node:events';
import * as S from 'silvery';
import xterm from '@xterm/headless';
process.env.COLORTERM = 'truecolor';
process.env.TERM = 'xterm-256color';

const h = React.createElement;
const COLS = 24,
  ROWS = 6;

class FakeStdout extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
    this.columns = COLS;
    this.rows = ROWS;
    this.bytes = '';
  }
  write(chunk) {
    this.bytes += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    return true;
  }
  get writableHighWaterMark() {
    return 16384;
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
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function xtermScreen(bytes) {
  const t = new xterm.Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  await new Promise((res) => t.write(bytes, res));
  const rows = [];
  for (let y = 0; y < ROWS; y++)
    rows.push(t.buffer.active.getLine(y)?.translateToString(false) ?? '');
  const cellAt = (x, y) => {
    const c = t.buffer.active.getLine(y)?.getCell(x);
    return c
      ? { chars: c.getChars(), width: c.getWidth(), bg: c.getBgColor(), fg: c.getFgColor() }
      : null;
  };
  return { rows, cellAt, dispose: () => t.dispose() };
}

let pass = 0,
  fail = 0,
  notes = [];
const check = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + detail : ''}`);
  cond ? pass++ : fail++;
  if (!cond) notes.push(name + (detail !== undefined ? ` (${detail})` : ''));
};

async function drive(element, opts = {}) {
  const stdout = new FakeStdout();
  const stdin = new FakeStdin();
  const inst = S.render(element, {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
    ...opts,
  });
  await sleep(80);
  return {
    stdout,
    stdin,
    inst,
    done: async () => {
      try {
        inst?.unmount?.();
      } catch {}
      await sleep(30);
    },
  };
}

// ── Scene 3: ZWJ family emoji + combining é through the pipeline ──
async function scene3() {
  const fam = '👩‍👩‍👧‍👦';
  const { stdout, done } = await drive(h(S.Text, null, `${fam}x é z`));
  await done();
  const scr = await xtermScreen(stdout.bytes);
  const famCell = scr.cellAt(0, 0);
  check(
    '3 xterm: family emoji lands as one cluster at col 0',
    famCell?.chars === fam,
    JSON.stringify(famCell?.chars),
  );
  check('3 xterm: emoji occupies width 2', famCell?.width === 2, String(famCell?.width));
  check(
    '3 xterm: x lands at col 2 (silvery and xterm agree on width)',
    scr.cellAt(2, 0)?.chars === 'x',
    JSON.stringify(scr.cellAt(2, 0)?.chars),
  );
  check(
    '3 xterm: é kept as one narrow cluster',
    scr.rows[0].includes('é z'),
    JSON.stringify(scr.rows[0]),
  );
  // silvery's own referee
  const vt = new S.VirtualTerminal(COLS, ROWS);
  vt.applyAnsi(stdout.bytes);
  check(
    '3 VT self-consistent: x at col 2',
    vt.getChar(2, 0) === 'x',
    JSON.stringify(vt.getChar(2, 0)),
  );
  // attribution: what did silvery actually EMIT for the cluster?
  const emitted = stdout.bytes
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '');
  const clusterIntact = emitted.includes(fam);
  notes.push(
    `3 INFO: full ZWJ cluster present in emitted bytes = ${clusterIntact} (if true, col drift is the EMULATOR's cluster handling — cross-terminal raster divergence risk, not a silvery bug per se)`,
  );
}

// ── Scene 1: overwrite — absolute box paints narrow glyph onto 中's continuation ──
function OverwriteApp({ hook }) {
  const [on, setOn] = React.useState(false);
  hook.flip = () => setOn(true);
  return h(
    S.Box,
    { width: COLS, height: 2 },
    h(S.Text, null, '中中中'),
    on
      ? h(S.Box, { position: 'absolute', marginLeft: 1, width: 1, height: 1 }, h(S.Text, null, 'a'))
      : null,
  );
}
async function scene1() {
  const hook = {};
  const { stdout, done } = await drive(h(OverwriteApp, { hook }));
  hook.flip();
  await sleep(80);
  await done();
  const scr = await xtermScreen(stdout.bytes);
  const row = scr.rows[0];
  check(
    '1 narrow-over-continuation: no orphan half-glyph (lead cleared)',
    row.startsWith(' a') || row.startsWith('a'),
    JSON.stringify(row),
  );
  check('1 rest of row intact', row.includes('中中'), JSON.stringify(row));
}

// ── Scene 2: wide glyph clipped at last column ──
async function scene2() {
  const { stdout, done } = await drive(
    h(
      S.Box,
      { width: COLS, height: 1 },
      h(S.Text, { wrap: 'truncate' }, 'x'.repeat(COLS - 1) + '中'),
    ),
  );
  await done();
  const scr = await xtermScreen(stdout.bytes);
  const last = scr.cellAt(COLS - 1, 0);
  check(
    '2 clipped wide at last col is not a half-glyph',
    last?.chars !== '中',
    JSON.stringify(last?.chars),
  );
}

// ── Scene 7: paint order for overlapping absolute boxes; is it tree-order? ──
function StackApp({ hook }) {
  const [order, setOrder] = React.useState(['red', 'green']);
  hook.restack = () => setOrder(['green', 'red']);
  return h(
    S.Box,
    { width: COLS, height: 3 },
    order.map((color, i) =>
      h(
        S.Box,
        {
          key: color,
          position: 'absolute',
          marginLeft: 2 + i * 2,
          marginTop: 0,
          width: 6,
          height: 2,
          backgroundColor: color,
        },
        h(S.Text, null, color[0].repeat(4)),
      ),
    ),
  );
}
async function scene7() {
  const hook = {};
  const { stdout, done } = await drive(h(StackApp, { hook }));
  const scr1 = await xtermScreen(stdout.bytes);
  const overlapBefore = scr1.cellAt(4, 0); // cols 4-5 overlap both boxes
  hook.restack();
  await sleep(80);
  await done();
  const scr2 = await xtermScreen(stdout.bytes);
  const overlapAfter = scr2.cellAt(4, 0);
  check(
    '7 later sibling paints on top at overlap (tree-order paint)',
    overlapBefore?.bg !== overlapAfter?.bg,
    `before bg=${overlapBefore?.bg} after bg=${overlapAfter?.bg}`,
  );
  notes.push(
    `7 INFO: paint z source = tree order (no zIndex prop on Box) — hit z is manual → agreement by-convention`,
  );
}

// ── Scene 6: transparency — Backdrop fade dims content without replacing it ──
async function scene6() {
  const plain = await drive(h(S.Text, { color: 'white' }, 'UNDERNEATH'));
  await plain.done();
  const faded = await drive(
    h(S.Backdrop, { fade: 0.5 }, h(S.Text, { color: 'white' }, 'UNDERNEATH')),
  );
  await faded.done();
  const scrP = await xtermScreen(plain.stdout.bytes);
  const scrF = await xtermScreen(faded.stdout.bytes);
  const cP = scrP.cellAt(0, 0),
    cF = scrF.cellAt(0, 0);
  check(
    '6 backdrop: glyphs preserved (dim, not replace)',
    cF?.chars === 'U',
    JSON.stringify(cF?.chars),
  );
  const dimmed =
    /\x1b\[[0-9;]*2m/.test(faded.stdout.bytes) && !/\x1b\[[0-9;]*2m/.test(plain.stdout.bytes);
  check(
    '6 backdrop: fade visible (RGB fade or ANSI-16 dim degradation)',
    cF?.fg !== cP?.fg || dimmed,
    `plain fg=${cP?.fg} faded fg=${cF?.fg} dimSGR=${dimmed}`,
  );
}

// ── Scene 14: fault posture — component throws mid-lifecycle ──
function FaultApp({ hook }) {
  const [boom, setBoom] = React.useState(false);
  hook.boom = () => setBoom(true);
  if (boom) throw new Error('deliberate-fault');
  return h(S.Text, null, 'alive');
}
async function scene14() {
  const hook = {};
  let loud = null;
  const stdout = new FakeStdout(),
    stdin = new FakeStdin();
  const inst = S.render(h(FaultApp, { hook }), {
    stdout,
    stdin,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  const lifecycle = inst.run().then(
    (v) => ({ kind: 'resolved', v }),
    (e) => ({ kind: 'rejected', e }),
  );
  await sleep(80);
  let stderrOut = '';
  const origErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (c, ...a) => {
    stderrOut += c.toString();
    return true;
  };
  const origConsoleErr = console.error;
  console.error = (...a) => {
    stderrOut += a.join(' ') + '\n';
  };
  try {
    hook.boom();
  } catch (e) {
    loud = e;
  }
  await sleep(150);
  process.stderr.write = origErr;
  console.error = origConsoleErr;
  notes.push(
    `14 INFO: stderr during fault: ${stderrOut ? JSON.stringify(stderrOut.slice(0, 120)) : 'SILENT'}`,
  );
  const outcome = await Promise.race([
    lifecycle,
    sleep(500).then(() => ({ kind: 'still-running' })),
  ]);
  check(
    '14 fault is LOUD (run() rejects or sync throw), not silent',
    loud !== null || outcome.kind === 'rejected',
    `sync=${loud?.message ?? null} run()=${outcome.kind}${outcome.kind === 'rejected' ? ':' + outcome.e?.message : ''}`,
  );
  const restored = /\x1b\[\?25h/.test(stdout.bytes);
  notes.push(`14 INFO: cursor-show emitted after fault = ${restored}`);
}

const only = process.argv[2];
const scenes = { scene3, scene1, scene2, scene7, scene6, scene14 };
for (const [name, fn] of Object.entries(scenes)) {
  if (only && name !== only) continue;
  console.log(`\n── ${name} ──`);
  try {
    await fn();
  } catch (e) {
    check(`${name} completed without harness error`, false, e.message);
  }
}
console.log(`\n${pass} pass, ${fail} fail`);
for (const n of notes) console.log('NOTE:', n);
process.exit(fail ? 1 : 0);
