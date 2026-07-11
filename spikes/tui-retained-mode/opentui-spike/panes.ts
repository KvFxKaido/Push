// panes.ts — feel the retained-mode UX: panes + modal overlay + mouse + focus.
//
// Run on BUN (Node's native FFI is unavailable in 0.4.3 — see smoke.ts):
//   bun panes.ts
//   SPIKE_SELFTEST=1 bun panes.ts   # build scene, print summary, exit (no loop)
//
// What to evaluate while driving it:
//   - Panes: two side-by-side regions via flexbox (flexDirection: "row"). Resize the
//     terminal — do they reflow cleanly? (Yoga layout, the part that DOES run on Node.)
//   - Mouse: click a pane to focus it. Hit-testing is automatic — the compositor knows
//     each renderable's geometry, so onMouseEvent fires on the right box with zero manual
//     coordinate math. This is the thing the current hand-rolled ANSI renderer can't do.
//   - Modal: press `p` for the command palette. It's an absolute, high-zIndex overlay
//     composited OVER the panes with a dim backdrop — true z-order, restores cleanly on
//     close. This is the exact capability that forced retained mode.
//   - Scroll: focused pane scrolls with ↑/↓ (or j/k).
//   - Quit: q or Ctrl+C.
//
// API pinned to @opentui/core@0.4.3. Spike quality: if a prop/method drifted, adjust —
// the point is the architecture feel, not production polish.

import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  type CliRenderer,
  type MouseEvent,
  type KeyEvent,
} from '@opentui/core';

const ACCENT = '#38bdf8'; // Push sky accent
const DIM = '#334155';
const BG = '#0b1220';

// ── fake Push-shaped data ───────────────────────────────────────────────────
const transcript = Array.from({ length: 40 }, (_, i) =>
  i % 3 === 0
    ? `▸ you: message ${i}`
    : i % 3 === 1
      ? `● assistant: reply ${i}`
      : `  ⎿ tool: exec #${i}`,
);
const diff = Array.from({ length: 40 }, (_, i) =>
  i % 5 === 0 ? `@@ hunk ${i} @@` : i % 2 === 0 ? `+ added line ${i}` : `- removed line ${i}`,
);

// ── a focusable pane that owns its scroll offset and reacts to clicks ────────
class Pane extends BoxRenderable {
  private lines: string[];
  private offset = 0;
  private body: TextRenderable;
  constructor(
    renderer: CliRenderer,
    id: string,
    title: string,
    lines: string[],
    onFocus: (p: Pane) => void,
  ) {
    super(renderer, {
      id,
      title,
      titleAlignment: 'left',
      border: true,
      borderStyle: 'rounded',
      borderColor: DIM,
      focusedBorderColor: ACCENT,
      backgroundColor: BG,
      flexGrow: 1,
      flexShrink: 1,
      width: 'auto',
      height: 'auto',
    });
    this.lines = lines;
    this.body = new TextRenderable(renderer, {
      id: `${id}-body`,
      content: '',
      fg: '#cbd5e1',
      zIndex: 1,
    });
    this.add(this.body);
    this.onFocusRequested = onFocus;
    this.render();
  }
  private onFocusRequested: (p: Pane) => void;
  setActive(active: boolean) {
    this.borderColor = active ? ACCENT : DIM;
  }
  scroll(delta: number) {
    this.offset = Math.max(0, Math.min(this.lines.length - 1, this.offset + delta));
    this.render();
  }
  private render() {
    this.body.content = this.lines.slice(this.offset, this.offset + 20).join('\n');
  }
  // Automatic hit-testing: the compositor routes the click to this box by geometry.
  protected onMouseEvent(event: MouseEvent): void {
    if (event.type === 'down') {
      this.onFocusRequested(this);
      event.stopPropagation();
    }
  }
}

async function main() {
  const renderer = await createCliRenderer({ exitOnCtrlC: true });
  renderer.setBackgroundColor(BG);

  // root is a column: content row (grows) + status bar (fixed).
  const root = new BoxRenderable(renderer, {
    id: 'root',
    flexDirection: 'column',
    flexGrow: 1,
    width: 'auto',
    height: 'auto',
  });
  renderer.root.add(root);

  const contentRow = new BoxRenderable(renderer, {
    id: 'content-row',
    flexDirection: 'row',
    flexGrow: 1,
    width: 'auto',
    height: 'auto',
  });
  root.add(contentRow);

  const panes: Pane[] = [];
  let focusIndex = 0;
  const focus = (p: Pane) => {
    focusIndex = panes.indexOf(p);
    panes.forEach((pane, i) => pane.setActive(i === focusIndex));
    status.content = statusLine();
  };
  const left = new Pane(renderer, 'transcript', ' Transcript ', transcript, focus);
  const right = new Pane(renderer, 'diff', ' Diff ', diff, focus);
  panes.push(left, right);
  contentRow.add(left);
  contentRow.add(right);

  const status = new TextRenderable(renderer, {
    id: 'status',
    content: '',
    fg: '#94a3b8',
    height: 1,
    flexShrink: 0,
  });
  root.add(status);
  const statusLine = () =>
    `  ${['Transcript', 'Diff'][focusIndex]} focused · Tab: switch · p: palette · ↑/↓: scroll · q: quit`;
  status.content = statusLine();
  panes.forEach((pane, i) => pane.setActive(i === 0));

  // ── command palette: a z-ordered overlay (backdrop + centered box) ──────────
  const paletteItems = [
    'Switch branch…',
    'Open file…',
    'Run tests',
    'Commit (Gate at Push)',
    'Toggle Protect Main',
  ];
  let paletteSel = 0;
  const backdrop = new BoxRenderable(renderer, {
    id: 'backdrop',
    position: 'absolute',
    left: 0,
    top: 0,
    width: '100%',
    height: '100%',
    backgroundColor: '#000000',
    zIndex: 900,
    visible: false,
  });
  const palette = new BoxRenderable(renderer, {
    id: 'palette',
    position: 'absolute',
    left: 10,
    top: 4,
    width: 44,
    height: paletteItems.length + 2,
    border: true,
    borderStyle: 'rounded',
    borderColor: ACCENT,
    backgroundColor: '#0f1a2e',
    title: ' Command Palette ',
    zIndex: 901,
    visible: false,
  });
  const paletteBody = new TextRenderable(renderer, {
    id: 'palette-body',
    content: '',
    fg: '#e2e8f0',
    zIndex: 902,
  });
  palette.add(paletteBody);
  renderer.root.add(backdrop);
  renderer.root.add(palette);
  let paletteOpen = false;
  const renderPalette = () => {
    paletteBody.content = paletteItems
      .map((it, i) => (i === paletteSel ? `❯ ${it}` : `  ${it}`))
      .join('\n');
  };
  const togglePalette = (open: boolean) => {
    paletteOpen = open;
    backdrop.visible = open;
    palette.visible = open;
    if (open) renderPalette();
  };

  renderer.keyInput.on('keypress', (key: KeyEvent) => {
    if (paletteOpen) {
      if (key.name === 'escape') return togglePalette(false);
      if (key.name === 'up' || key.name === 'k') paletteSel = Math.max(0, paletteSel - 1);
      if (key.name === 'down' || key.name === 'j')
        paletteSel = Math.min(paletteItems.length - 1, paletteSel + 1);
      if (key.name === 'return') {
        status.content = `  selected: ${paletteItems[paletteSel]}`;
        return togglePalette(false);
      }
      return renderPalette();
    }
    switch (key.name) {
      case 'q':
        renderer.stop();
        process.exit(0);
        break;
      case 'p':
        togglePalette(true);
        break;
      case 'tab':
        focus(panes[(focusIndex + 1) % panes.length]);
        break;
      case 'up':
      case 'k':
        panes[focusIndex].scroll(-1);
        break;
      case 'down':
      case 'j':
        panes[focusIndex].scroll(1);
        break;
    }
  });

  if (process.env.SPIKE_SELFTEST) {
    const count = (n: any): number =>
      1 + ((n.getChildren?.() ?? n.children ?? []) as any[]).reduce((s, c) => s + count(c), 0);
    // stderr, because OpenTUI captures console.* into its own overlay.
    process.stderr.write(
      `[selftest] scene built OK — ${count(renderer.root)} renderables, ${panes.length} panes, palette wired.\n`,
    );
    renderer.stop?.();
    process.exit(0);
  }

  renderer.start();
}

main().catch((e) => {
  console.error('panes spike failed:', e?.message ?? e);
  process.exit(1);
});
