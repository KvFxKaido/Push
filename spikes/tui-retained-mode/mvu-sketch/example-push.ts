// example-push.ts — a Push-shaped app against engine.ts, to prove the shape holds.
// Illustrative: bodies are sketched (`…`) where detail doesn't inform the architecture.
// The point is that a coding turn maps cleanly onto MVU with zero retained widget state.

import {
  type Program,
  type Node,
  type Sub,
  type Cmd as CmdT,
  type InputEvent,
  Cmd,
  box,
  text,
} from './engine.js';

// ── Model: one immutable snapshot of everything on screen ────────────────────
type Pane = 'transcript' | 'diff';
interface Line {
  text: string;
  kind: 'you' | 'assistant' | 'tool' | 'diff-add' | 'diff-del';
}

interface Model {
  focus: Pane;
  scroll: Record<Pane, number>;
  transcript: readonly Line[];
  diff: readonly Line[];
  palette: { open: boolean; sel: number };
  turn: 'idle' | 'streaming';
}

// ── Msg: every way the model can change. Input, stream, and effects are all Msgs ──
type Msg =
  | { t: 'focus'; pane: Pane }
  | { t: 'scroll'; delta: number }
  | { t: 'palette/open' }
  | { t: 'palette/close' }
  | { t: 'palette/move'; d: number }
  | { t: 'palette/run' }
  | { t: 'agent/delta'; text: string } // from the agent-stream Sub
  | { t: 'agent/done' }
  | { t: 'tool/result'; id: string; ok: boolean }; // from a Cmd

const PALETTE_ITEMS = ['Switch branch…', 'Open file…', 'Run tests', 'Commit (Gate at Push)'];

// ── A Cmd: the async side of a turn. Running tests is a tool call that resolves to a Msg ──
const runTestsCmd = (): CmdT<Msg> =>
  Cmd.of(async (signal) => {
    // await execInSandbox("npm test", { signal })  — cancellable via update moving on
    void signal;
    return { t: 'tool/result', id: 'tests', ok: true };
  });

// ── update: the ONLY place the model changes. Pure (Model, Msg) -> (Model, Cmd) ──
const update = (msg: Msg, m: Model): [Model, CmdT<Msg>] => {
  switch (msg.t) {
    case 'focus':
      return [{ ...m, focus: msg.pane }, Cmd.none];
    case 'scroll': {
      const next = Math.max(0, m.scroll[m.focus] + msg.delta);
      return [{ ...m, scroll: { ...m.scroll, [m.focus]: next } }, Cmd.none];
    }
    case 'palette/open':
      return [{ ...m, palette: { open: true, sel: 0 } }, Cmd.none];
    case 'palette/close':
      return [{ ...m, palette: { ...m.palette, open: false } }, Cmd.none];
    case 'palette/move': {
      const sel = Math.min(PALETTE_ITEMS.length - 1, Math.max(0, m.palette.sel + msg.d));
      return [{ ...m, palette: { ...m.palette, sel } }, Cmd.none];
    }
    case 'palette/run': {
      const closed: Model = { ...m, palette: { ...m.palette, open: false } };
      // Selecting "Run tests" kicks off a Cmd; the result returns as a later Msg.
      return m.palette.sel === 2
        ? [{ ...closed, turn: 'streaming' }, runTestsCmd()]
        : [closed, Cmd.none];
    }
    case 'agent/delta':
      return [
        { ...m, transcript: [...m.transcript, { text: msg.text, kind: 'assistant' }] },
        Cmd.none,
      ];
    case 'agent/done':
      return [{ ...m, turn: 'idle' }, Cmd.none];
    case 'tool/result':
      return [{ ...m, turn: 'idle' /* , append receipt … */ }, Cmd.none];
  }
};

// ── view: the whole UI as f(model). Fresh tree each call; nothing retained ───
const pane = (id: Pane, title: string, lines: readonly Line[], m: Model): Node =>
  box(
    {
      id,
      style: {
        border: 'rounded',
        borderColor: m.focus === id ? '#38bdf8' : '#334155', // focus is just derived state
        flexGrow: 1,
      },
    },
    [
      text(
        lines
          .slice(m.scroll[id], m.scroll[id] + 20)
          .map((l) => l.text)
          .join('\n'),
      ),
    ],
  );

const view = (m: Model): Node =>
  box({ id: 'root', style: { flexDirection: 'column', flexGrow: 1 } }, [
    box({ id: 'content', style: { flexDirection: 'row', flexGrow: 1 } }, [
      pane('transcript', 'Transcript', m.transcript, m),
      pane('diff', 'Diff', m.diff, m),
    ]),
    text(`  ${m.focus} · ${m.turn} · p: palette · q: quit`, { id: 'status', style: { height: 1 } }),
    // The modal is just another node: absolute + high z. Present only when open — no
    // show/hide on a retained object, it simply isn't in this frame's tree otherwise.
    ...(m.palette.open ? [palette(m)] : []),
  ]);

const palette = (m: Model): Node =>
  box(
    {
      id: 'palette',
      style: {
        position: 'absolute',
        left: 10,
        top: 4,
        width: 44,
        zIndex: 901,
        border: 'rounded',
        borderColor: '#38bdf8',
      },
    },
    [text(PALETTE_ITEMS.map((it, i) => (i === m.palette.sel ? `❯ ${it}` : `  ${it}`)).join('\n'))],
  );

// ── subscriptions: long-lived Msg sources, recomputed from the model ─────────
// The agent event stream is only subscribed while a turn is streaming; the runtime
// starts it when it appears in the list and tears it down when `turn` returns to idle.
const agentStream: Sub<Msg> = {
  key: 'agent-stream',
  start(dispatch) {
    // const off = agentEvents.on("delta", (d) => dispatch({ t: "agent/delta", text: d.text }))
    // agentEvents.on("done", () => dispatch({ t: "agent/done" }))
    return () => {
      /* off() */
    };
  },
};

const subscriptions = (m: Model): readonly Sub<Msg>[] =>
  m.turn === 'streaming' ? [agentStream] : [];

// ── onInput: adapt terminal input to Msgs. Mouse arrives pre-hit-tested ──────
const onInput = (e: InputEvent, m: Model): Msg | null => {
  if (e.kind === 'mouse') {
    // The compositor already told us which node was clicked — no coordinate math here.
    if (
      e.mouse.phase === 'down' &&
      (e.mouse.target === 'transcript' || e.mouse.target === 'diff')
    ) {
      return { t: 'focus', pane: e.mouse.target };
    }
    if (e.mouse.phase === 'wheel' && e.mouse.wheel) return { t: 'scroll', delta: e.mouse.wheel };
    return null;
  }
  if (e.kind === 'key') {
    if (m.palette.open) {
      switch (e.key.name) {
        case 'escape':
          return { t: 'palette/close' };
        case 'up':
          return { t: 'palette/move', d: -1 };
        case 'down':
          return { t: 'palette/move', d: 1 };
        case 'enter':
          return { t: 'palette/run' };
        default:
          return null;
      }
    }
    switch (e.key.name) {
      case 'p':
        return { t: 'palette/open' };
      case 'up':
        return { t: 'scroll', delta: -1 };
      case 'down':
        return { t: 'scroll', delta: 1 };
      default:
        return null;
    }
  }
  return null;
};

// ── the Program, assembled ───────────────────────────────────────────────────
export const pushTui: Program<Model, Msg> = {
  init: () => [
    {
      focus: 'transcript',
      scroll: { transcript: 0, diff: 0 },
      transcript: [],
      diff: [],
      palette: { open: false, sel: 0 },
      turn: 'idle',
    },
    Cmd.none,
  ],
  update,
  view,
  subscriptions,
  onInput,
};
