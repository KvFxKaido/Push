// stress.ts — drives Rezi through STRESS.md cases 1–9 (+ partial 11/14) in a
// real terminal. One app, one scene per case; number keys switch scenes, each
// scene renders its own "what to look for" instructions. Score results in
// ../STRESS.md's scoreboard from what you SEE — this file only stages the
// conditions.
//
// Run (real terminal only — the native engine needs DA/caps answers):
//   npm run stress          # tsx stress.ts
// Keys: 1–9 scenes · t toggle overwrite · m modal · z rotate z-order · q quit
// Self-check without a TTY: SPIKE_SELFTEST=1 npx tsx stress.ts
//   (builds every scene's VNode tree headless; proves the view code, not the
//   engine — the engine half is what your eyes are for.)

import { ui } from '@rezi-ui/core';
import type { VNode } from '@rezi-ui/core';
import { createNodeApp } from '@rezi-ui/node';

type State = {
  scene: number;
  tick: number;
  overwrite: boolean; // scene 1: wide↔narrow toggle
  modalOpen: boolean; // scenes 5/8
  zRotation: number; // scene 7: rotate zIndex props (paint ignores — engine finding)
  xRotation: number; // scene 7: rotate child ORDER (the control — paint follows this)
  lastClick: string; // scene 9
};

const WIDE_LINE = '中'.repeat(30);
const NARROW_LINE = 'ab'.repeat(30);
const MIXED = 'a中b文c字d中e文f字g中h文i字j中k文l字m中n文o字p中q文r字s中t文u字';

function instructions(lines: string[]): VNode {
  return ui.box(
    { border: 'single', title: 'look for' },
    lines.map((l) => ui.text(l)),
  );
}

// ── Scenes ────────────────────────────────────────────────────────

/** Case 1: CJK overwrite — narrow content replacing wide cells in place. */
function scene1(s: State): VNode {
  // Auto-alternate on tick parity; 't' flips the phase so you can also hold
  // a state and step it manually.
  const wide = (s.tick % 2 === 0) !== s.overwrite;
  const body = wide ? WIDE_LINE : NARROW_LINE;
  return ui.column({ gap: 1 }, [
    ui.text(
      `auto-toggles each second (tick ${s.tick}, now ${wide ? 'WIDE' : 'narrow'}); 't' flips phase`,
    ),
    ui.box({ border: 'single' }, [ui.text(body)]),
    instructions([
      'PASS: clean swap between 中中中… and abab… — no orphaned half-glyphs,',
      '      no leftover 中 fragments, box borders stay aligned.',
      'FAIL: stray wide halves, shifted borders, ghost cells.',
    ]),
  ]);
}

/** Case 2: wide glyph clipped at the last column. */
function scene2(): VNode {
  // Odd fixed widths force a 中 to land astride the box's right edge on
  // alternating rows; the clipped lead must paint a space, not bleed.
  return ui.column({ gap: 1 }, [
    ui.box({ border: 'single', width: 21 }, [
      ui.text('中'.repeat(12)),
      ui.text(`a${'中'.repeat(12)}`),
      ui.text('中文字中文字中文字中文'),
    ]),
    instructions([
      'PASS: right border is a straight line; clipped wide glyphs become a',
      '      space at the edge cell.',
      'FAIL: border column jagged / glyph halves outside the box.',
    ]),
  ]);
}

/** Case 3: ZWJ + combining collapse. */
function scene3(): VNode {
  return ui.column({ gap: 1 }, [
    ui.box({ border: 'single', title: 'graphemes' }, [
      ui.text('|👩‍👩‍👧‍👦| ZWJ family — one grapheme, two cells'),
      ui.text('|é| e + U+0301 — one cell'),
      ui.text('|🇯🇵| flag pair — two cells'),
      ui.text('|👍🏽| modifier — two cells'),
    ]),
    instructions([
      'PASS: the trailing | of every row lines up vertically with the box.',
      'FAIL: any row pushes its | out of column — that grapheme was',
      '      mis-measured at raster time (string-level probes already pass).',
    ]),
  ]);
}

/** Case 4: mixed-width reflow under live resize. */
function scene4(): VNode {
  return ui.column({ gap: 1 }, [
    ui.box({ border: 'single' }, [ui.text(MIXED), ui.text(MIXED), ui.text(MIXED)]),
    instructions([
      'Resize the terminal window continuously (case 11 doubles up here:',
      'wiggle fast for the resize storm).',
      'PASS: no split graphemes at wrap points, no torn frames; final layout',
      '      matches final size.',
    ]),
  ]);
}

/** Cases 5+8: modal restore + occluded update. Busy bg keeps ticking. */
function scene58(s: State): VNode {
  const busyRow = (i: number) =>
    ui.text(
      Array.from(
        { length: 8 },
        (_, j) => `[${((s.tick + i + j) % 100).toString().padStart(2, '0')}]`,
      ).join(' 中 '),
    );
  const bg = ui.column({ gap: 0 }, [
    ui.text(`background tick: ${s.tick} — updates once per second`),
    ...Array.from({ length: 10 }, (_, i) => busyRow(i)),
    instructions([
      "'m' opens a modal over this. Case 5 PASS: closing it restores every",
      'cell underneath with no full-screen clear/flash. Case 8 PASS: while',
      'open, the tick keeps advancing but NOTHING leaks through the modal;',
      'on close the counters show current values, not stale ones.',
    ]),
  ]);
  if (!s.modalOpen) return bg;
  return ui.layers([
    bg,
    ui.modal({
      id: 'stress-modal',
      title: 'occluder',
      content: ui.column({ gap: 1 }, [
        ui.text('the background is still ticking behind me'),
        ui.text(`modal saw tick ${s.tick} while open`),
      ]),
      backdrop: 'dim',
      onClose: () => appRef?.update((prev) => ({ ...prev, modalOpen: false })),
    }),
  ]);
}

/** Case 6: transparency — what "dim" actually is (settled from source). */
function scene6(s: State): VNode {
  const bg = ui.column(
    {},
    Array.from({ length: 10 }, (_, i) => ui.text(`row ${i} ${'内容'.repeat(12)} tick=${s.tick}`)),
  );
  return ui.column({ gap: 1 }, [
    instructions([
      'ENGINE FACT (renderToDrawlist/widgets/containers.js): "dim" fills the',
      'backdrop with a ░ pattern — it REPLACES content, no see-through dim',
      'exists. Score case 6 on whether pattern-replace is acceptable for',
      "Push's overlays, not on whether it dims (it provably doesn't).",
    ]),
    ui.layers([
      bg,
      ui.layer({
        id: 'dim-layer',
        backdrop: 'dim',
        modal: false,
        content: ui.center({}, [
          ui.box({ border: 'double', p: 1 }, [ui.text('dim backdrop behind this box')]),
        ]),
      }),
    ]),
  ]);
}

/**
 * Case 7: z-order stack — self-discriminating. 'z' rotates zIndex PROPS
 * (paint provably ignores them: containers.js renders layers children
 * "in order (later = on top)" and never reads zIndex — it only sorts the
 * input-routing registry). 'x' rotates the actual CHILD ORDER — the control:
 * this is the path paint does use, so it must visibly restack.
 */
function scene7(s: State): VNode {
  const mk = (name: string, pad: number, z: number) =>
    ui.layer({
      id: `stack-${name}`,
      zIndex: z,
      modal: false,
      content: ui.column({ p: pad }, [
        ui.box({ border: 'heavy', title: `${name} (z=${z})`, width: 40, height: 8 }, [
          ui.text(`${name} ${name} ${name}`),
          ui.text(`${name} ${name} ${name}`),
        ]),
      ]),
    });
  const zs = [
    [1, 2, 3],
    [3, 1, 2],
    [2, 3, 1],
  ][s.zRotation % 3];
  const stack = [mk('AAAA', 0, zs[0]), mk('BBBB', 2, zs[1]), mk('CCCC', 4, zs[2])];
  // Control: rotate the array itself — paint follows child order.
  const rotated = stack.slice(s.xRotation % 3).concat(stack.slice(0, s.xRotation % 3));
  return ui.column({ gap: 0 }, [
    instructions([
      "'z' rotates zIndex props — EXPECT NO visual restack (engine paints",
      'child order only; zIndex feeds input routing). That mismatch IS the',
      "finding. 'x' rotates child order — EXPECT a visible restack; if 'x'",
      "restacks and 'z' does not, the spike code is fine and the engine is",
      'the thing being measured.',
    ]),
    ui.text(`zIndex rotation ${s.zRotation % 3} · child-order rotation ${s.xRotation % 3}`),
    ui.layers(rotated),
  ]);
}

/** Case 9: mouse hit-testing — clicks route to the right target. */
function scene9(s: State): VNode {
  return ui.column({ gap: 1 }, [
    ui.row({ gap: 2 }, [
      ui.button({ id: 'btn-a', label: 'target A', onPress: () => setClick('A') }),
      ui.button({
        id: 'btn-wide',
        label: '中文按钮',
        onPress: () => setClick('wide-glyph button'),
      }),
      ui.button({ id: 'btn-b', label: 'target B', onPress: () => setClick('B') }),
    ]),
    ui.text(`last click: ${s.lastClick || '(none)'}`),
    instructions([
      'Click each button, including the SECOND cell of a 中 in the wide',
      'button label. PASS: every click lands on the visually-correct target',
      '(continuation cells inherit the lead glyph’s hit target).',
      "Then press 'm': with the modal open, background buttons must NOT",
      'react to clicks (modal blocks lower layers). ESC closes.',
    ]),
    s.modalOpen
      ? ui.modal({
          id: 'hit-modal',
          title: 'input blocker',
          content: ui.text('try clicking target A/B now — they must not fire'),
          backdrop: 'dim',
          onClose: () => appRef?.update((prev) => ({ ...prev, modalOpen: false })),
        })
      : ui.text(''),
  ]);
}

// ── App shell ─────────────────────────────────────────────────────

const SCENES: Record<number, { title: string; render: (s: State) => VNode }> = {
  1: { title: 'case 1 — CJK overwrite', render: scene1 },
  2: { title: 'case 2 — wide clip at edge', render: () => scene2() },
  3: { title: 'case 3 — ZWJ/combining', render: () => scene3() },
  4: { title: 'case 4 — mixed reflow (+11 resize)', render: () => scene4() },
  5: { title: 'cases 5+8 — modal restore / occluded update', render: scene58 },
  6: { title: 'case 6 — transparency', render: scene6 },
  7: { title: 'case 7 — z-order stack', render: scene7 },
  8: { title: 'cases 5+8 — (same as 5)', render: scene58 },
  9: { title: 'case 9 — hit-testing', render: scene9 },
};

function rootView(s: State): VNode {
  const scene = SCENES[s.scene] ?? SCENES[1];
  return ui.page({
    p: 1,
    gap: 1,
    header: ui.header({ title: `Rezi stress — ${scene.title}` }),
    body: scene.render(s),
    footer: ui.statusBar({}, [
      ui.text(
        '1-9 scenes · t toggle · m modal · z zIndex · x child-order · q quit — score in STRESS.md',
      ),
    ]),
  });
}

let appRef: ReturnType<typeof createNodeApp<State>> | null = null;

function setClick(what: string) {
  appRef?.update((s) => ({ ...s, lastClick: what }));
}

const initialState: State = {
  scene: 1,
  tick: 0,
  overwrite: false,
  modalOpen: false,
  zRotation: 0,
  xRotation: 0,
  lastClick: '',
};

if (process.env.SPIKE_SELFTEST === '1') {
  // Headless build-check: every scene's view function produces a VNode for a
  // representative state. Proves the widget-tree code paths; the raster/damage
  // behavior is the interactive half.
  for (const sceneNum of Object.keys(SCENES).map(Number)) {
    for (const modalOpen of [false, true]) {
      const node = rootView({ ...initialState, scene: sceneNum, tick: 7, modalOpen, zRotation: 2 });
      if (!node || typeof node !== 'object') {
        console.error(`selftest: scene ${sceneNum} (modal=${modalOpen}) produced no VNode`);
        process.exit(1);
      }
    }
  }
  console.log('selftest: all scene view-trees build OK');
  process.exit(0);
}

const app = createNodeApp<State>({ initialState });
appRef = app;
app.view(rootView);
app.keys({
  q: () => void app.stop(),
  t: () => app.update((s) => ({ ...s, overwrite: !s.overwrite })),
  m: () => app.update((s) => ({ ...s, modalOpen: !s.modalOpen })),
  z: () => app.update((s) => ({ ...s, zRotation: s.zRotation + 1 })),
  x: () => app.update((s) => ({ ...s, xRotation: s.xRotation + 1 })),
  ...Object.fromEntries(
    Object.keys(SCENES).map((n) => [
      n,
      () => app.update((s) => ({ ...s, scene: Number(n), modalOpen: false })),
    ]),
  ),
});

const done = app.run();
await app.ready();
const timer = setInterval(() => app.update((s) => ({ ...s, tick: s.tick + 1 })), 1000);
await done;
clearInterval(timer);
