// engine.ts — core signatures for a pure-TS, MVU, retained-compositor TUI engine.
// Design sketch (spike/tui-retained-mode). Not wired to a build; typechecks standalone.
//
// The bet: "Bubble Tea v2, in TypeScript." MVU authoring on top; a cell compositor with
// z-order layers underneath. No reconciler, no mutable widget tree.
//
// ── The retention budget (the whole argument, made explicit) ─────────────────
// Between frames, EXACTLY these things persist. Everything else is rebuilt from the model:
//   1. the model                         (the single source of truth; only `update` mutates it)
//   2. two cell buffers                  (front/back, for damage diffing — preallocated typed arrays)
//   3. the last frame's HitMap           (so a mouse event can be told which node it hit)
//   4. active subscriptions              (long-lived Msg sources, keyed)
//   5. a cached layout                   (invalidated by a dirty flag; a perf cache, not state)
// What is NOT retained: any widget/view-node tree. `view(model)` returns a FRESH immutable
// tree each frame; the engine lays it out and rasterizes it to CELLS, then throws it away.
// Diffing happens at the cell level (damage), never at the node level. That is the line
// between this and a reconciler: a reconciler diffs two node trees and mutates a retained
// one; here there is no retained tree to mutate.

// ═══════════════════════════════════════════════════════════════════════════
// 1. MVU core
// ═══════════════════════════════════════════════════════════════════════════

/** A one-shot async effect (tool call, git op, timer) that resolves to a Msg (or null).
 *  Cancellable, so `update` can abandon in-flight work when the model moves on. */
export interface Cmd<Msg> {
  run(signal: AbortSignal): Promise<Msg | null>;
}

/** Cmd constructors. `Cmd` is both a type and a small module of builders (Elm-style). */
export declare const Cmd: {
  readonly none: Cmd<never>;
  batch<Msg>(cmds: readonly Cmd<Msg>[]): Cmd<Msg>;
  of<Msg>(run: (signal: AbortSignal) => Promise<Msg | null>): Cmd<Msg>;
  /** Fire a Msg on the next tick (no async work). */
  msg<Msg>(m: Msg): Cmd<Msg>;
};

/** A long-lived source of Msgs: terminal resize, the agent event stream, a ticker.
 *  `subscriptions(model)` is recomputed each update; the runtime diffs the list BY KEY and
 *  starts/stops sources. (This is the only place the runtime keeps per-source state — it is
 *  diffing effects by key, not a view tree.) */
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
   *  hit-tested (`mouse.target` set from the last frame's HitMap), so the app matches on a
   *  NodeId, not coordinates. Return null to ignore an event. */
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
// 3. Layout — Yoga (WASM; runs on Node, verified in the OpenTUI smoke test)
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

/** A node with its absolute cell rect and resolved stacking order. */
export interface LaidOutNode {
  readonly node: Node;
  readonly rect: Rect;
  readonly z: number;
  readonly children: readonly LaidOutNode[];
}

export interface LayoutEngine {
  /** Build a Yoga tree from `root`, compute layout against `viewport`, return absolute rects.
   *  Dirty-flagged by the runtime: skipped entirely when the layout-affecting shape of the
   *  tree is unchanged (e.g. a streaming text delta that doesn't resize its box). */
  layout(root: Node, viewport: Size): LaidOutNode;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. Compositor — cells, z-order layers, damage, hit map
// ═══════════════════════════════════════════════════════════════════════════

/** Preallocated cell grid. One packed entry per cell (char cluster + fg + bg + attrs) in a
 *  typed array; the render hot path allocates nothing. */
export interface CellBuffer {
  readonly size: Size;
  resize(size: Size): void;
  clear(): void;
}

/** Cell -> owning NodeId, built as a byproduct of compositing. Powers mouse hit-testing. */
export interface HitMap {
  at(x: number, y: number): NodeId | null;
}

/** Rectangular regions that changed versus the previous frame. */
export type Damage = readonly Rect[];

export interface Compositor {
  /** Rasterize laid-out nodes into the back buffer, bucketing by z into layers so overlays
   *  paint over lower content with correct occlusion; diff against the front buffer; return
   *  the changed regions and this frame's hit map. */
  composite(root: LaidOutNode): { damage: Damage; hits: HitMap };
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
  /** Where to write encoded frames. Defaults to process.stdout at construction. */
  output?: { write(bytes: Uint8Array | string): void };
  /** Raw input source (keypress/mouse/resize). Defaults to process.stdin. */
  input?: { on(event: 'data', cb: (chunk: Uint8Array) => void): void };
  mouse?: boolean; // enable SGR mouse reporting (default true)
  altScreen?: boolean; // use the alternate screen buffer (default true)
}

export interface Runtime<Msg> {
  /** Enter the terminal, render the initial view, and drive the loop until `stop()`.
   *  Per Msg (from input, a resolved Cmd, or a Sub): model' = update(msg, model); if the
   *  view is affected, re-layout (unless dirty-clean) → composite → encode → write. */
  run(): Promise<void>;
  /** Inject a Msg from outside the loop (e.g. an agent-stream Sub calls this). */
  dispatch(msg: Msg): void;
  /** Restore the terminal (leave alt-screen, disable mouse) and tear down subs. */
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
