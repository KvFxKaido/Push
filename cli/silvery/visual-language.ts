/**
 * Push TUI Visual Language v2 — pure presentation substrate for `cli/silvery/`.
 *
 * Source of truth: `docs/cli/design/TUI Visual Language v2.md`.
 * This module encodes the laws as helpers the surface and fault shell call —
 * glyphs with ASCII fallback, the one-accent color budget, frame/stream split
 * copy, shared-clock motion phases, and density meters. It does not paint;
 * silvery components consume the return values.
 */

import { isReducedMotion } from '../tui-verbs.js';
import { detectUnicode, VARIANTS } from '../tui-theme.js';

// ── Color budget (laws 2–3) ─────────────────────────────────────────
//
// Silvery semantic tokens the surface may use. Anything outside this set is a
// design regression: no success green, no warning yellow chrome, no
// multi-color role rainbow. Themes pick *which hue* `$fg-accent` is; they
// may not raise the budget.

export const VL_COLOR = {
  /** The single "where the action is" accent (cursor, selection, live). */
  accent: '$fg-accent',
  /** Fault exception — errors and deny only. Never decoration. */
  fault: '$fg-error',
  /** Primary stream text. */
  primary: '$fg-default',
  /** Secondary labels, path, muted chrome. */
  muted: '$fg-muted',
} as const;

export type VlColor = (typeof VL_COLOR)[keyof typeof VL_COLOR];

/**
 * Shimmer endpoints — raw hex, not `$` tokens, because the sweep interpolates
 * BETWEEN them per character and silvery resolves a token to a single color.
 * (`resolveThemeColor` passes any non-`$` string straight through, so a mixed
 * hex is a legal `<Text color>`.)
 *
 * Read off the mono canvas, which is the same source `theme.tsx` builds
 * `$fg-muted` / `$fg-default` from — so the shimmer's trough lands exactly on
 * `VL_COLOR.muted`, and a static (reduced-motion) verb is indistinguishable
 * from any other muted chrome. Theme-independent by construction: themes move
 * the accent hue, never the grayscale posture.
 */
const SHIMMER_BASE = VARIANTS.mono.tokens['fg.muted'];
const SHIMMER_HIGHLIGHT = VARIANTS.mono.tokens['fg.primary'];

// ── Glyphs (laws 4–5, tier 3 ASCII) ──────────────────────────────────

export interface VisualGlyphs {
  /** Idle / pending / routine chrome mark. */
  hexIdle: string;
  /** Active / attention / filled chrome mark. */
  hexActive: string;
  /**
   * Activity spine — Push is WORKING (a tool call, in any state).
   *
   * Named for what the glyph actually separates, not for a state it doesn't carry:
   * pending / ok / error are distinguished by COLOR, and `tool_ok` — a settled call —
   * wears this same mark. The previous names (`dotActive` / `dotIdle`) claimed a
   * live-vs-settled distinction the code never made.
   */
  markWork: string;
  /** Activity spine — Push is TALKING (prose, status). The quiet register. */
  markQuiet: string;
  /** The human's turn — a prompt caret (❯), the one voice that is *not* Push. */
  human: string;
  /** Continuous meter cells, sparse → solid. */
  density: readonly string[];
}

export const GLYPHS_UNICODE: VisualGlyphs = {
  hexIdle: '⬡',
  hexActive: '⬢',
  // Silvery promotes bare U+25AA/U+25AB to emoji presentation (VS16), making
  // them two cells wide. VS15 keeps the square spine monochrome and one-cell.
  markWork: '▪\uFE0E',
  markQuiet: '▫\uFE0E',
  human: '❯',
  density: ['░', '▒', '▓', '█'],
};

export const GLYPHS_ASCII: VisualGlyphs = {
  hexIdle: 'o',
  hexActive: '@',
  markWork: '+',
  markQuiet: '-',
  human: '>',
  density: ['.', ':', '#'],
};

export function resolveGlyphs(unicode: boolean = detectUnicode()): VisualGlyphs {
  return unicode ? GLYPHS_UNICODE : GLYPHS_ASCII;
}

// ── The Push mark (law 6) ────────────────────────────────────────────
//
// The web `PushMarkIcon` path, verbatim: `M8 1 14.5 5v6L8 15 1.5 11V5L8 1Z` on a
// 16×16 viewBox. A hexagon with FLAT VERTICAL SIDES (x = 1.5 and x = 14.5, held
// from y = 5 to y = 11) — which is precisely what a hand-drawn version loses: pure
// diagonals give you a rhombus, and a rhombus is not Push's face.
const PUSH_MARK_VERTICES: ReadonlyArray<readonly [number, number]> = [
  [8, 1],
  [14.5, 5],
  [14.5, 11],
  [8, 15],
  [1.5, 11],
  [1.5, 5],
];

/** Terminal cells are ~2:1 tall, so the grid is wider than it is high to keep the
 *  hexagon's proportions honest on screen rather than in the array. */
const BRAND_ART_COLS = 25;
const BRAND_ART_ROWS = 13;
/** Half-width of the fully-lit stroke, in viewBox units. */
const BRAND_STROKE = 0.35;
/** How far the mark fades out past the stroke, in viewBox units. */
const BRAND_FALLOFF = 0.95;

/** Shortest distance from a point to the mark's OUTLINE (not its interior). */
function distanceToMarkOutline(px: number, py: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < PUSH_MARK_VERTICES.length; i += 1) {
    const [ax, ay] = PUSH_MARK_VERTICES[i];
    const [bx, by] = PUSH_MARK_VERTICES[(i + 1) % PUSH_MARK_VERTICES.length];
    const vx = bx - ax;
    const vy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
    best = Math.min(best, Math.hypot(px - (ax + t * vx), py - (ay + t * vy)));
  }
  return best;
}

/**
 * The Push mark, rasterized onto terminal cells from the real icon geometry.
 *
 * Generated rather than hand-drawn, because hand-drawing it is how it became a
 * rhombus. The ramp reuses the language's existing density cells (law 4's meter
 * glyphs) instead of importing a new charset — the mark introduces no glyph the
 * language did not already own.
 *
 * It belongs only in an EMPTY transcript (law 6): identity, not decoration. It is
 * static, dim, and gone the moment there is a row to show.
 */
export function pushBrandArt(unicode: boolean = detectUnicode()): readonly string[] {
  const ramp = [' ', ...resolveGlyphs(unicode).density];
  const rows: string[] = [];
  for (let r = 0; r < BRAND_ART_ROWS; r += 1) {
    let line = '';
    for (let c = 0; c < BRAND_ART_COLS; c += 1) {
      const x = ((c + 0.5) / BRAND_ART_COLS) * 16;
      const y = ((r + 0.5) / BRAND_ART_ROWS) * 16;
      const d = distanceToMarkOutline(x, y);
      const lit = Math.max(0, 1 - Math.max(0, d - BRAND_STROKE) / BRAND_FALLOFF);
      line += ramp[Math.round(lit * (ramp.length - 1))];
    }
    // Equal-width rows, trailing spaces INTACT. The surface centers the block with
    // `alignItems: center`, which centers each line by its OWN width — so a trimmed
    // row would re-center independently and shear the hexagon. Padding makes the
    // centering a no-op per line and a true block-center for the mark.
    rows.push(line.padEnd(BRAND_ART_COLS, ' '));
  }
  return rows;
}

/** Width of every {@link pushBrandArt} row — the surface needs it to decide whether
 *  the mark fits before it renders one. */
export const PUSH_BRAND_ART_COLS = BRAND_ART_COLS;

// ── Motion (laws 8–10) ──────────────────────────────────────────────
//
// Web motion axes (`DESIGN.md`) → tick counts. One shared clock drives all
// concurrent effects so they stay phase-locked. Stream content never uses
// these delays — chrome only.

export const MOTION_TICKS = {
  /** Modal backdrop fade enter/exit (law 9: 2–3 ticks). */
  modalFade: 3,
  /**
   * Verb-shimmer sweep period, in ticks. 16 × 150ms = 2400ms — the same
   * cadence as the web's `--verb-shimmer-dur: 2.4s`, reached through the
   * shared tick counter rather than a private wall-clock timer. Law 8 is the
   * reason for the indirection: a second clock would beat against the modal
   * fade and read as flicker, which is exactly the failure the law names.
   */
  verbShimmerPeriod: 16,
  /** Interval for the shared UI clock while working (≈ motion-fast 150ms). */
  clockMs: 150,
  /** Elapsed-seconds refresh while the turn runs (composer/status). */
  elapsedMs: 1_000,
} as const;

export type LivenessPhase = 'idle' | 'working' | 'attention';

export type ModalMotionPhase = 'closed' | 'entering' | 'open' | 'exiting';

export interface ModalMotionState {
  phase: ModalMotionPhase;
  startedAtTick: number;
  startFade: number;
}

export function modalFadeAmount(state: ModalMotionState, tick: number, targetFade: number): number {
  const target = Math.max(0, Math.min(1, targetFade));
  if (state.phase === 'closed') return 0;
  if (state.phase === 'open') return target;
  const progress = Math.max(0, Math.min(1, (tick - state.startedAtTick) / MOTION_TICKS.modalFade));
  if (state.phase === 'entering') {
    return state.startFade + (target - state.startFade) * progress;
  }
  return state.startFade * (1 - progress);
}

export function createModalMotionState(
  open: boolean,
  tick: number,
  targetFade: number,
  reducedMotion = isReducedMotion(),
): ModalMotionState {
  return {
    phase: open ? (reducedMotion ? 'open' : 'entering') : 'closed',
    startedAtTick: tick,
    startFade: open && reducedMotion ? Math.max(0, Math.min(1, targetFade)) : 0,
  };
}

export function reduceModalMotion(
  state: ModalMotionState,
  open: boolean,
  tick: number,
  targetFade: number,
  reducedMotion = isReducedMotion(),
): ModalMotionState {
  const target = Math.max(0, Math.min(1, targetFade));
  if (reducedMotion) {
    const phase = open ? 'open' : 'closed';
    const startFade = open ? target : 0;
    if (state.phase === phase && state.startFade === startFade) return state;
    return {
      phase,
      startedAtTick: tick,
      startFade,
    };
  }

  if (open && (state.phase === 'closed' || state.phase === 'exiting')) {
    return {
      phase: 'entering',
      startedAtTick: tick,
      startFade: modalFadeAmount(state, tick, target),
    };
  }
  if (!open && (state.phase === 'open' || state.phase === 'entering')) {
    return {
      phase: 'exiting',
      startedAtTick: tick,
      startFade: modalFadeAmount(state, tick, target),
    };
  }

  if (state.phase === 'entering' && tick - state.startedAtTick >= MOTION_TICKS.modalFade) {
    return { phase: 'open', startedAtTick: tick, startFade: target };
  }
  if (state.phase === 'exiting' && tick - state.startedAtTick >= MOTION_TICKS.modalFade) {
    return { phase: 'closed', startedAtTick: tick, startFade: 0 };
  }
  return state;
}

/**
 * Header liveness mark — a STATIC anchor, not an animation.
 *
 * Was `breathingHex`, and it did breathe: law 8 originally spent the
 * working-state animation budget on this glyph. The verb shimmer now holds
 * that budget (one live animation, and it belongs on the label the eye is
 * already reading — the hex can only say "alive", the verb says "alive AND
 * what"). So this went static, and the name went with it, per the same rule
 * `markWork` above states: a helper is named for what it does, not for a
 * behavior it used to have.
 *
 * Three states, distinguished by glyph and the one-accent budget rather than
 * by motion:
 *   idle      ⬡ hollow, muted
 *   working   ⬢ filled, muted   — filled IS the working signal
 *   attention ⬢ filled, accent  — the accent is "where the action is" (law 2)
 *
 * `bright` is the accent lever, so working and attention stay distinct without
 * either one moving. Takes no tick and no reduced-motion flag: there is nothing
 * left to freeze, which is what makes law 10's static equivalent trivially true
 * here — the static rendering IS the rendering.
 */
export function livenessHex(
  phase: LivenessPhase,
  glyphs: VisualGlyphs = resolveGlyphs(),
): { glyph: string; bright: boolean } {
  if (phase === 'idle') return { glyph: glyphs.hexIdle, bright: false };
  if (phase === 'attention') return { glyph: glyphs.hexActive, bright: true };
  return { glyph: glyphs.hexActive, bright: false };
}

// ── Verb shimmer (laws 8–10) ────────────────────────────────────────
//
// A brightness band sweeps left→right across the live status verb. The label
// IS the loader, so no cell is spent on a separate spinner glyph.
//
// Ported from the pre-Silvery `cli/tui-shimmer.ts` (#1373), which the ANSI
// printer's deletion took with it. Two things changed in the port, both
// forced:
//
//  1. It returns COLORS, not escape sequences. Silvery's compositor owns
//     painting; the old module wrote `\x1b[38;2;…m` per character directly to
//     the buffer, which is precisely the layer that no longer exists. Handing
//     back a color per character keeps the math pure and lets `<Text>` paint.
//  2. Phase comes from the shared tick, not wall-clock ms. The old module used
//     `Date.now()` on purpose (continuous across dropped frames); law 8's
//     phase-lock outranks that, and at a 150ms clock the difference is a frame.
//
// NOT silvery's `TextShimmer` — see the component note in `theme.tsx`. It is a
// whole-word binary flip on a private timer, which is neither this effect nor
// law 8-compatible.

/**
 * Band half-width as a fraction of the label length, with a floor.
 *
 * Proportional, not fixed: a fixed band swamps a word shorter than itself, and
 * these verbs run 7–10 chars ("thinking", "committing"). The web's gradient
 * shows a ~0.6-label-width highlight window; half of that is the 0.3 here.
 */
const BAND_HALF_FRACTION = 0.3;
const BAND_HALF_MIN = 1.5;

/**
 * Triangular highlight intensity in [0, 1] for the character at `index` of a
 * `len`-char label, at sweep `progress` in [0, 1).
 *
 * The band center travels from just off the left edge to just off the right
 * (the web's off-canvas 320% lead-in/out), so the highlight enters and exits
 * smoothly instead of popping in at full strength on character 0.
 */
export function shimmerIntensity(index: number, len: number, progress: number): number {
  if (len <= 0) return 0;
  const half = Math.max(BAND_HALF_MIN, len * BAND_HALF_FRACTION);
  const center = -half + progress * (len - 1 + 2 * half);
  const distance = Math.abs(index - center);
  if (distance >= half) return 0;
  return 1 - distance / half;
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function mixHex(base: string, highlight: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(base);
  const [r2, g2, b2] = hexToRgb(highlight);
  const channel = (a: number, b: number) =>
    Math.round(a + (b - a) * t)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(r1, r2)}${channel(g1, g2)}${channel(b1, b2)}`;
}

/**
 * Per-character colors for `text` at `tick`. One entry per character, always —
 * the array length is the string length, so a caller can zip the two without
 * a bounds check.
 *
 * Color only: nothing here changes width, so the shimmer can never reflow the
 * header. Reduced motion returns the flat base (law 10's static equivalent —
 * the verb still says what it says).
 *
 * Base/highlight default to the mono canvas rather than the active theme's
 * accent on purpose: per `theme.tsx`, themes pick the accent hue but never
 * replace the grayscale posture, and the accent is reserved for "where the
 * action is" (law 2). A shimmer is a brightness lift, not a hue tint — same
 * call the web makes.
 */
export function verbShimmerColors(
  text: string,
  tick: number,
  reducedMotion: boolean = isReducedMotion(),
  base: string = SHIMMER_BASE,
  highlight: string = SHIMMER_HIGHLIGHT,
): string[] {
  const chars = [...text];
  if (reducedMotion) return chars.map(() => base);
  const period = MOTION_TICKS.verbShimmerPeriod;
  const progress = (((tick % period) + period) % period) / period;
  return chars.map((_, i) => mixHex(base, highlight, shimmerIntensity(i, chars.length, progress)));
}

// ── Density meter (law 9) ───────────────────────────────────────────

/**
 * Fixed-width density ramp for context / progress feel.
 * `ratio` in [0, 1]; width is cell count (default 8).
 */
export function densityMeter(
  ratio: number,
  width = 8,
  glyphs: VisualGlyphs = resolveGlyphs(),
): string {
  const r = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const filled = Math.round(r * width);
  const ramp = glyphs.density;
  const solid = ramp[ramp.length - 1] ?? '#';
  const empty = ramp[0] ?? '.';
  // Mid density for a partial last cell when not at a boundary.
  const mid = ramp[Math.min(ramp.length - 1, 1)] ?? solid;
  let out = '';
  for (let i = 0; i < width; i++) {
    if (i < filled - 1) out += solid;
    else if (i === filled - 1) out += filled === width || r * width >= filled ? solid : mid;
    else out += empty;
  }
  return out;
}

// ── Frame helpers (law 1) ───────────────────────────────────────────

export type FooterScope =
  | 'composer'
  | 'running'
  | 'palette'
  | 'picker'
  | 'approval'
  | 'question'
  | 'fault';

/** Context-aware keybind strip for the footer (left side). */
export function footerKeybinds(scope: FooterScope): string {
  switch (scope) {
    case 'palette':
      return '↑↓ move · ↵ run · esc close';
    case 'picker':
      return '↑↓ move · ↵ select · esc close';
    case 'approval':
      return 'y approve · n/esc deny';
    case 'question':
      return '↵ answer · esc skip';
    case 'running':
      return 'ctrl+c cancel';
    case 'fault':
      return 'restart this screen';
    case 'composer':
    default:
      return 'tab complete · ctrl+k commands · ctrl+r sessions · ? help · ctrl+c quit';
  }
}

export interface HeaderFacts {
  branch: string;
  path: string;
  /** Compact context readout (e.g. "12k" or a density bar + label). */
  context: string;
  /** Turn/round counter, empty string to omit. */
  turn: string;
}

/**
 * Dot-separated fact strip for the header. Facts only — no controls (law 1).
 *
 * Deliberately carries neither the brand mark nor the status verb, though it
 * used to take a `brandMark`. That was why it sat unwired while `HeaderBar`
 * hand-built the same string: the header has three independently styled zones
 * (accent/muted hex, per-character shimmering verb, muted facts), and a zone
 * cannot be styled from inside a joined string it shares with the others. The
 * old signature's own doc comment said "the surface styles brand vs muted
 * separately" while putting the brand mark in the array — the contradiction
 * that kept every caller away. Facts are the part that IS uniformly muted;
 * that is the part this owns.
 */
export function headerSegments(facts: HeaderFacts): string[] {
  const segs: string[] = [];
  if (facts.branch) segs.push(facts.branch);
  if (facts.path) segs.push(facts.path);
  if (facts.context) segs.push(facts.context);
  if (facts.turn) segs.push(facts.turn);
  return segs;
}

/** Shorten a workspace path for the header fact strip. */
export function shortenPath(cwd: string, max = 28): string {
  if (!cwd) return '—';
  const home = process.env.HOME || process.env.USERPROFILE || '';
  let display = cwd;
  if (home && (display === home || display.startsWith(`${home}/`))) {
    display = `~${display.slice(home.length)}`;
  }
  if (display.length <= max) return display;
  // Keep the tail (most specific).
  return `…${display.slice(-(max - 1))}`;
}

/**
 * Exec-mode label for the composer rule (footer right / mode line).
 * Maps CLI exec modes onto the language's operational copy.
 */
export function modeLabel(execMode: string | undefined | null): string {
  const mode = (execMode || 'auto').toLowerCase().trim();
  if (mode === 'yolo') return 'always-approve';
  if (mode === 'strict') return 'strict';
  return 'auto';
}

/** Count user turns in a transcript for the header counter. */
export function countUserTurns(rows: readonly { role?: string }[]): number {
  let n = 0;
  for (const row of rows) {
    if (row.role === 'user') n += 1;
  }
  return n;
}

/** Compact local time for a transcript turn header. */
export function formatTurnTimestamp(timestampMs: number | undefined, locale?: string): string {
  if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs)) return '';
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' }).format(
    new Date(timestampMs),
  );
}

// ── Stream styling (laws 2, 5, 6) ────────────────────────────────────

export type StreamMarkKind =
  | 'user'
  | 'assistant'
  | 'tool_pending'
  | 'tool_ok'
  | 'tool_error'
  | 'reviewer'
  | 'auditor'
  | 'status'
  | 'error';

export interface StreamMark {
  /** Leading glyph (square spine or hex attribution). */
  glyph: string;
  /** Silvery color token — accent, fault, muted, or default. */
  color: VlColor | undefined;
  /** Bold the label/glyph. */
  bold: boolean;
}

/**
 * Stream leading mark + color. The hexagon is Push's face (law 5): the lead
 * agent wears the HOLLOW hex (`hexIdle`, quiet register — it *is* the voice you
 * talk to, no name needed), while independent review voices (Reviewer/Auditor)
 * wear the FILLED hex (`hexActive`) plus their name so attribution stays legible.
 * The square spine (`markWork`) is Push's tool ACTIVITY and delegated phases; the
 * caret (`human`, ❯) is the one voice that is not Push.
 * No green/cyan role rainbow — grayscale + one accent + fault (laws 2–3).
 *
 * The spine glyph separates exactly one thing: Push WORKING (`markWork`) from Push
 * TALKING (`markQuiet`). Pending / ok / error ride COLOR, not shape — `tool_ok` is a
 * settled call and still wears `markWork`.
 */
export function streamMark(
  kind: StreamMarkKind,
  glyphs: VisualGlyphs = resolveGlyphs(),
): StreamMark {
  switch (kind) {
    case 'user':
      // The human voice — a prompt caret in the accent. Never a hexagon: the
      // hex is Push's face (law 5), and the user is the one turn that is not
      // Push. Never the square spine either — that is Push's own activity.
      return { glyph: glyphs.human, color: VL_COLOR.accent, bold: true };
    case 'assistant':
      // The lead agent — Push's face in its quiet register. Hollow hex, no
      // name: it is the one voice you converse with, so it needs no label.
      return { glyph: glyphs.hexIdle, color: undefined, bold: false };
    case 'tool_pending':
      return { glyph: glyphs.markWork, color: VL_COLOR.accent, bold: true };
    case 'tool_ok':
      return { glyph: glyphs.markWork, color: VL_COLOR.muted, bold: false };
    case 'tool_error':
      return { glyph: glyphs.markWork, color: VL_COLOR.fault, bold: true };
    case 'reviewer':
    case 'auditor':
      // Independent voice — filled hex in chrome attribution (law 5).
      return { glyph: glyphs.hexActive, color: undefined, bold: true };
    case 'error':
      return { glyph: glyphs.hexActive, color: VL_COLOR.fault, bold: true };
    case 'status':
    default:
      return { glyph: glyphs.markQuiet, color: VL_COLOR.muted, bold: false };
  }
}

/**
 * Diff line color under the one-accent budget (law 2).
 * Adds read bold/primary, dels dim/muted — never success green / del red
 * (red is reserved for the fault exception).
 */
export function diffLineColor(kind: 'add' | 'del' | 'ctx'): VlColor | undefined {
  if (kind === 'add') return VL_COLOR.primary;
  if (kind === 'del') return VL_COLOR.muted;
  return VL_COLOR.muted;
}

// ── Fault surface copy (fault section + law 11) ──────────────────────

export interface FaultCopy {
  title: string;
  detail: string;
  preserved: string;
  action: string;
}

/**
 * Narrating-voice fault card (law 11 + fault surfaces).
 * What faulted, what was preserved, the one action — no animation.
 */
export function faultCopy(error: Error | { message: string }): FaultCopy {
  const message = (error?.message || 'unknown render fault').trim() || 'unknown render fault';
  return {
    title: 'This screen failed to render',
    detail: message,
    preserved:
      'Your session is still in the daemon — this fault only hit the view. Nothing was written by the crash.',
    action: 'Restart this screen or continue from another client.',
  };
}

// ── Theme accent resolution ─────────────────────────────────────────

/**
 * Map a Push theme variant's primary accent hex for silvery `generateTheme`.
 * Themes pick the hue; the budget stays one accent (law 2, non-goals).
 */
export function accentHexForTheme(accentPrimaryHex: string): string {
  const hex = (accentPrimaryHex || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(hex)) return hex;
  // Fallback: identity sky accent so a bad token never blanks the theme.
  return '#7dd3fc';
}
