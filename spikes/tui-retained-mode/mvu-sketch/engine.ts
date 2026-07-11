// engine.ts — core signatures for a pure-TS, MVU, retained-compositor TUI engine.
// Design sketch (spike/tui-retained-mode). Not wired to a build; typechecks standalone.
// Revised after Codex review: layout cache is node-free, effects have a lifecycle.
//
// The bet: "Bubble Tea v2, in TypeScript." MVU authoring on top; a cell compositor with
// z-order layers underneath. No reconciler, no mutable widget tree.
//
// ── What persists between frames (categories, not a magic number) ────────────
// AUTHORITATIVE STATE — the single source of truth; only `update` writes it:
//     • the model
// DERIVED CACHES — reconstructible from the model, throwable, invalidated by key:
//     • two cell buffers (front/back, for damage diffing)
//     • layout geometry (rects by NodeId, keyed by a cheap layoutKey — cli/tui.ts:2645)
//     • transcript / stream shaping (cli/tui-stream-frame.ts is this exact pattern)
//     • the last frame's hit map (cell → NodeId)
// LIVE RESOURCES — must be explicitly torn down:
//     • subscriptions, in-flight command controllers, the input decoder, the frame scheduler
//
// The invariant that makes this NOT a reconciler: there is no retained VIEW TREE.
// `view(model)` returns a fresh immutable `Node` tree; it is flattened to a node-free paint
// list, rasterized to CELLS, and discarded. Diffing is cell-level (damage), never node-level.
// A reconciler diffs two node trees and mutates a retained one; here nothing that references
// a Node survives a frame.

// ═══════════════════════════════════════════════════════════════════════════
// 1. MVU core
// ═══════════════════════════════════════════════════════════════════════════

// A Cmd is DATA interpreted by the runtime (Elm-style), not a bare promise — so `batch` can
// fan out to many independent results and effects can carry identity. A `task` may name a
// `key`: dispatching a new task with the same key REPLACES the in-flight one (its controller
// is aborted) and any late result from the superseded generation is DROPPED. Rejections map
// through `onError` (never an unhandled rejection). Commands are cancelled ONLY by a same-key
// task, an explicit `cancel`, or `stop()` — never by an unrelated model change.
export type Cmd<Msg> =
  | { readonly kind: 'none' }
  | { readonly kind: 'batch'; readonly cmds: readonly Cmd<Msg>[] }
  | {
      readonly kind: 'task';
      readonly key?: string; // identity for replacement + late-result suppression
      readonly run: (signal: AbortSignal) => Promise<Msg | null>;
      readonly onError?: (err: unknown) => Msg | null;
    }
  | { readonly kind: 'cancel'; readonly key: string };

export const Cmd = {
  none: { kind: 'none' } as Cmd<never>,
  batch: <Msg>(cmds: readonly Cmd<Msg>[]): Cmd<Msg> => ({ kind: 'batch', cmds }),
  task: <Msg>(spec: {
    key?: string;
    run: (signal: AbortSignal) => Promise<Msg | null>;
    onError?: (err: unknown) => Msg | null;
  }): Cmd<Msg> => ({ kind: 'task', ...spec }),
  cancel: (key: string): Cmd<never> => ({ kind: 'cancel', key }),
} as const;

/** A long-lived source of Msgs: terminal resize, the agent event stream, a ticker.
 *  `subscriptions(model)` is recomputed each update; the runtime diffs the list BY KEY and
 *  starts/stops sources. (It diffs effects by key, not a view tree.) */
export interface Sub<Msg> {
  readonly key: string;
  /** Begin producing Msgs; return a teardown called when the sub disappears from the list. */
  start(dispatch: (msg: Msg) => void): () => void;
}

/** The application. Pure functions over an opaque Model/Msg. */
export interface Program<Model, Msg> {
  init(): [Model, Cmd<Msg>];
  update(msg: Msg, model: Model): [Model, Cmd<Msg>];
  /** Pure: the entire UI as a function of state. Fresh tree every call, never retained. */
  view(model: Model): Node;
  /** Optional: long-lived Msg sources, recomputed from the model. */
  subscriptions?(model: Model): readonly Sub<Msg>[];
  /** Optional: adapt raw terminal input into app Msgs. Mouse events arrive already
   *  hit-tested (`mouse.target` from the last frame's HitMap), so the app matches on a
   *  NodeId, not coordinates. This is the seam to reuse Push's existing input parser and
   *  focus stack rather than replace them. Return null to ignore an event. */
  onInput?(event: InputEvent, model: Model): Msg | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. View — immutable node tree (returned by `view`, never retained)
// ═══════════════════════════════════════════════════════════════════════════

export type NodeId = string;
export type Color = string; // "#rrggbb" for now; RGBA packing is an encoder detail.
export type BorderStyle = 'none' | 'single' | 'rounded' | 'double';
export type Dimension = number | `${number}%` | 'auto';

export interface Style {
  // Flexbox (a Yoga subset). Layout is computed by the layout engine, not here.
  flexDirection?: 'row' | 'column';
  flexGrow?: number;
  flexShrink?: number;
  width?: Dimension;
  height?: Dimension;
  minWidth?: number;
  minHeight?: number;
  padding?: number;
  gap?: number;
  // Positioning. `absolute` + `zIndex` is how modals/overlays are expressed; the compositor
  // buckets nodes by resolved z into layers (the Lipgloss v2 canvas/layer model).
  position?: 'relative' | 'absolute';
  left?: number;
  top?: number;
  zIndex?: number;
  // Paint.
  fg?: Color;
  bg?: Color;
  border?: BorderStyle;
  borderColor?: Color;
}

/** View nodes are plain immutable DATA — no methods, no identity, no lifecycle. */
export type Node =
  | {
      readonly kind: 'box';
      readonly id?: NodeId;
      readonly style?: Style;
      readonly children: readonly Node[];
    }
  | {
      readonly kind: 'text';
      readonly id?: NodeId;
      readonly style?: Style;
      readonly content: string;
    };

/** Thin constructors (pure). The app builds trees with these; there is nothing to dispose. */
export const box = (
  props: { id?: NodeId; style?: Style },
  children: readonly Node[] = [],
): Node => ({
  kind: 'box',
  id: props.id,
  style: props.style,
  children,
});
export const text = (content: string, props: { id?: NodeId; style?: Style } = {}): Node => ({
  kind: 'text',
  id: props.id,
  style: props.style,
  content,
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Layout — Node tree → node-free paint list (Yoga; runs on Node, verified)
// ═══════════════════════════════════════════════════════════════════════════

export interface Size {
  width: number;
  height: number;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Resolved paint attributes for one op — no Node reference. */
export interface PaintAttrs {
  fg?: Color;
  bg?: Color;
  border?: BorderStyle;
  borderColor?: Color;
}

/** One node's contribution to the frame: geometry + resolved paint + optional text.
 *  Deliberately node-free so the layout geometry can be cached without retaining the tree
 *  (the bug the first draft had: a cached `LaidOutNode { node }` repaints stale content). */
export interface PaintOp {
  readonly id?: NodeId; // powers hit-testing + focus; the id, not the node
  readonly rect: Rect;
  readonly z: number;
  readonly attrs: PaintAttrs;
  readonly text?: string;
}

/** An ordered, node-free display list. The compositor buckets by z into layers. */
export type Frame = readonly PaintOp[];

export interface LayoutEngine {
  /** Flatten `root` to an absolute-positioned, node-free `Frame`. Internally caches geometry
   *  keyed by a cheap layoutKey (viewport + layout-affecting shape) and recomputes Yoga only
   *  on invalidation — the pattern cli/tui.ts:2645 already uses. A text/color change that
   *  doesn't affect size reuses cached geometry and only updates the op's attrs/text. */
  layout(root: Node, viewport: Size): Frame;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Compositor — cells, z-order layers, damage, hit map
// ═══════════════════════════════════════════════════════════════════════════

/** How a cell participates in a (possibly wide) grapheme cluster. This is NOT deferrable:
 *  the cell representation must encode it from day one. A narrow glyph painted over a
 *  'wide-lead' must clear the orphaned 'wide-cont' (中 → a); a wide glyph clipped at the last
 *  column paints a space, not half a cluster; ZWJ/combining sequences collapse to one
 *  'wide-lead' plus continuations. Reuse the existing width table (cli/tui-renderer.ts:73). */
export type CellWidth = 'narrow' | 'wide-lead' | 'wide-cont';

/** Preallocated cell grid. One packed entry per cell (cluster + fg + bg + attrs + CellWidth)
 *  in a typed array; the render hot path allocates nothing. Transparency (bg alpha lets lower
 *  layers show through) and equal-z stable ordering are compositor rules, not view concerns. */
export interface CellBuffer {
  readonly size: Size;
  resize(size: Size): void;
  clear(): void;
}

/** Cell -> owning NodeId, built as a byproduct of compositing. Powers mouse hit-testing.
 *  Continuation cells inherit their lead's hit target. */
export interface HitMap {
  at(x: number, y: number): NodeId | null;
}

/** Rectangular regions that changed versus the previous frame. */
export type Damage = readonly Rect[];

export interface Compositor {
  /** Rasterize the paint list into the back buffer, bucketing by z into layers so overlays
   *  paint over lower content with correct occlusion; diff against the front buffer; return
   *  the changed regions and this frame's hit map. Also owns cursor placement + selection. */
  composite(frame: Frame): { damage: Damage; hits: HitMap };
  /** Encode damaged cells to a minimal ANSI byte stream (RLE across runs of equal style). */
  encode(damage: Damage): Uint8Array;
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Input — parsed terminal events, delivered to `onInput`
// ═══════════════════════════════════════════════════════════════════════════

export interface Key {
  name: string; // "a", "enter", "escape", "up", "tab", "backspace", …
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  runes?: string; // literal text for printable keys
}

export type MousePhase = 'down' | 'up' | 'move' | 'drag' | 'wheel';
export type MouseButton = 'left' | 'middle' | 'right' | 'none';

export interface Mouse {
  phase: MousePhase;
  x: number;
  y: number;
  button: MouseButton;
  wheel?: -1 | 1;
  /** Hit-tested by the runtime against the LAST frame's HitMap before reaching `onInput`.
   *  This is why MVU can do mouse without a widget tree: geometry lives in the compositor. */
  target: NodeId | null;
}

export type InputEvent =
  | { kind: 'key'; key: Key }
  | { kind: 'mouse'; mouse: Mouse }
  | { kind: 'resize'; size: Size }
  | { kind: 'paste'; text: string };

// ═══════════════════════════════════════════════════════════════════════════
// 6. Runtime — the loop that ties it together
// ═══════════════════════════════════════════════════════════════════════════

export interface RuntimeOptions {
  output?: { write(bytes: Uint8Array | string): void };
  input?: { on(event: 'data', cb: (chunk: Uint8Array) => void): void };
  mouse?: boolean; // enable SGR mouse reporting (default true)
  altScreen?: boolean; // use the alternate screen buffer (default true)
}

export interface Runtime<Msg> {
  /** Enter the terminal, render the initial view, and drive the loop until `stop()`.
   *
   *  Msgs are processed FIFO and NON-REENTRANTLY: one Msg fully applies (update → effects
   *  scheduled → frame emitted) before the next is dequeued, so `update` never sees a torn
   *  model. Effects from `update`'s returned Cmd are interpreted here: `task`s run against an
   *  AbortController tracked by `key`; a same-key task aborts and replaces the prior one; a
   *  result whose generation was superseded is dropped (late-result suppression); a rejected
   *  task maps through `onError` or is dropped with a structured log. */
  run(): Promise<void>;
  /** Inject a Msg from outside the loop (e.g. an agent-stream Sub calls this). */
  dispatch(msg: Msg): void;
  /** Restore the terminal, abort in-flight commands, and tear down subs. */
  stop(): void;
}

/** Wire a Program to concrete Layout/Compositor implementations and a terminal. */
export declare function createRuntime<Model, Msg>(
  program: Program<Model, Msg>,
  deps: {
    layout: LayoutEngine;
    compositor: Compositor;
    buffers: { front: CellBuffer; back: CellBuffer };
  },
  opts?: RuntimeOptions,
): Runtime<Msg>;
