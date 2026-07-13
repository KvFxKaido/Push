/**
 * Push TUI Visual Language v2 — pure presentation substrate for `cli/silvery/`.
 *
 * Source of truth: `docs/cli/design/TUI Visual Language v2.md`.
 * This module encodes the laws as helpers the surface and fault shell call —
 * glyphs with ASCII fallback, the one-accent color budget, frame/stream split
 * copy, shared-clock motion phases, and density meters. It does not paint;
 * silvery components consume the return values.
 */

import { isReducedMotion } from '../tui-spinner.js';
import { detectUnicode } from '../tui-theme.js';

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

// ── Glyphs (laws 4–5, tier 3 ASCII) ──────────────────────────────────

export interface VisualGlyphs {
  /** Idle / pending / routine chrome mark. */
  hexIdle: string;
  /** Active / attention / filled chrome mark. */
  hexActive: string;
  /** Activity spine — filled (pending/live). */
  diamondFilled: string;
  /** Activity spine — hollow (settled). */
  diamondHollow: string;
  /** Continuous meter cells, sparse → solid. */
  density: readonly string[];
}

export const GLYPHS_UNICODE: VisualGlyphs = {
  hexIdle: '⬡',
  hexActive: '⬢',
  diamondFilled: '◆',
  diamondHollow: '◇',
  density: ['░', '▒', '▓', '█'],
};

export const GLYPHS_ASCII: VisualGlyphs = {
  hexIdle: 'o',
  hexActive: '*',
  diamondFilled: '+',
  diamondHollow: '-',
  density: ['.', ':', '#'],
};

export function resolveGlyphs(unicode: boolean = detectUnicode()): VisualGlyphs {
  return unicode ? GLYPHS_UNICODE : GLYPHS_ASCII;
}

// ── Motion (laws 8–10) ──────────────────────────────────────────────
//
// Web motion axes (`DESIGN.md`) → tick counts. One shared clock drives all
// concurrent effects so they stay phase-locked. Stream content never uses
// these delays — chrome only.

export const MOTION_TICKS = {
  /** Modal backdrop fade enter/exit (law 9: 2–3 ticks). */
  modalFade: 3,
  /** Full breathe cycle length (dim→bright→dim). */
  breathePeriod: 8,
  /** Interval for the shared UI clock while working (≈ motion-fast 150ms). */
  clockMs: 150,
  /** Elapsed-seconds refresh while the turn runs (composer/status). */
  elapsedMs: 1_000,
} as const;

export type LivenessPhase = 'idle' | 'working' | 'attention';

/**
 * Breathing hex for the header liveness mark (law 8: one live animation).
 * Reduced motion freezes on the filled glyph (static equivalent, law 10).
 */
export function breathingHex(
  tick: number,
  phase: LivenessPhase,
  glyphs: VisualGlyphs = resolveGlyphs(),
  reducedMotion: boolean = isReducedMotion(),
): { glyph: string; bright: boolean } {
  if (phase === 'idle') {
    return { glyph: glyphs.hexIdle, bright: false };
  }
  if (phase === 'attention') {
    // One-shot pulse: filled + bright. Caller owns "once"; we just paint filled.
    return { glyph: glyphs.hexActive, bright: true };
  }
  // working
  if (reducedMotion) {
    return { glyph: glyphs.hexActive, bright: true };
  }
  const period = MOTION_TICKS.breathePeriod;
  const step = ((tick % period) + period) % period;
  // First half filled+bright, second half hollow+dim.
  const filled = step < period / 2;
  return {
    glyph: filled ? glyphs.hexActive : glyphs.hexIdle,
    bright: filled,
  };
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

export type FooterScope = 'composer' | 'running' | 'palette' | 'approval' | 'question' | 'fault';

/** Context-aware keybind strip for the footer (left side). */
export function footerKeybinds(scope: FooterScope): string {
  switch (scope) {
    case 'palette':
      return '↑↓ move · ↵ run · esc close';
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
      return 'ctrl+k commands · ctrl+c quit';
  }
}

export interface HeaderFacts {
  brandMark: string;
  branch: string;
  path: string;
  /** Compact context readout (e.g. "12k" or a density bar + label). */
  context: string;
  /** Turn/round counter, empty string to omit. */
  turn: string;
}

/**
 * Dot-separated fact strip for the header. Facts only — no controls (law 1).
 * Returns the joined segments; the surface styles brand vs muted separately.
 */
export function headerSegments(facts: HeaderFacts): string[] {
  const segs: string[] = [facts.brandMark];
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
  /** Leading glyph (diamond spine or hex attribution). */
  glyph: string;
  /** Silvery color token — accent, fault, muted, or default. */
  color: VlColor | undefined;
  /** Bold the label/glyph. */
  bold: boolean;
}

/**
 * Stream leading mark + color. Diamonds own the activity spine; hexagons only
 * mark independent voices (Reviewer/Auditor) and chrome elsewhere (law 5).
 * No green/cyan role rainbow — grayscale + one accent + fault (laws 2–3).
 */
export function streamMark(
  kind: StreamMarkKind,
  glyphs: VisualGlyphs = resolveGlyphs(),
): StreamMark {
  switch (kind) {
    case 'user':
      return { glyph: glyphs.hexActive, color: VL_COLOR.accent, bold: true };
    case 'assistant':
      return { glyph: glyphs.diamondHollow, color: undefined, bold: false };
    case 'tool_pending':
      return { glyph: glyphs.diamondFilled, color: VL_COLOR.accent, bold: true };
    case 'tool_ok':
      return { glyph: glyphs.diamondFilled, color: VL_COLOR.muted, bold: false };
    case 'tool_error':
      return { glyph: glyphs.diamondFilled, color: VL_COLOR.fault, bold: true };
    case 'reviewer':
    case 'auditor':
      // Independent voice — filled hex in chrome attribution (law 5).
      return { glyph: glyphs.hexActive, color: undefined, bold: true };
    case 'error':
      return { glyph: glyphs.hexActive, color: VL_COLOR.fault, bold: true };
    case 'status':
    default:
      return { glyph: glyphs.diamondHollow, color: VL_COLOR.muted, bold: false };
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
