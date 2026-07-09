/**
 * tui-shimmer.ts — verb shimmer + hexagon-avatar glint for the "busy" indicator.
 *
 * Terminal port of the web app's `.status-verb-shimmer` and `.hex-thinking`
 * animations (`app/src/index.css`). A soft brightness band sweeps across the
 * live thinking-verb — the label *is* the loader, so there's no separate
 * spinner glyph to spend a column on — and the hexagon avatar glints on its
 * own slower cadence so it stays a live anchor when the verb is long enough
 * to truncate off the right edge.
 *
 * Faithful to the web's *character* (a brightness lift, not a hue tint; a
 * band sized proportional to the label; two cadences — 2.4s verb / 1.6s hex)
 * rendered through the terminal's per-cell reality (Codex's per-character
 * intensity approach):
 *   - truecolor / 256 : interpolate the cell fg base → highlight per char.
 *   - 16-color        : degrade the lift to DIM → normal → BOLD on the base.
 *   - none            : plain text (no escapes).
 *
 * Pure and unit-testable: same (text, elapsedMs, colors) → same string. The
 * render sites pass wall-clock ms, so the sweep is phase-continuous across
 * dropped frames (unlike a per-render counter) and lands on the same 2.4s /
 * 1.6s periods as the web.
 */

import { rgbTo256, VARIANTS } from './tui-theme.js';
import type { ColorTier, Theme, ThemeName } from './tui-theme.js';
import { isReducedMotion } from './tui-spinner.js';
import type { SpinnerActivity } from './tui-spinner.js';

const RESET = '\x1b[0m';

/** Web parity: `--verb-shimmer-dur: 2.4s` and `hex-thinking-trace 1.6s`. */
export const VERB_SHIMMER_MS = 2400;
export const HEX_GLINT_MS = 1600;

// Band half-width as a fraction of the label length. The web gradient shows a
// ~0.6-label-width highlight window (`background-size: 320%`, a 20%-of-gradient
// stop span). A *proportional* band keeps a short verb ("thinking") reading as
// a sweep rather than a whole-word pulse — the one place we follow the web over
// Codex's fixed-width band, which would swamp a word shorter than the band.
const BAND_HALF_FRACTION = 0.3;
const BAND_HALF_MIN = 1.5;

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function lerpRgb(base: Rgb, highlight: Rgb, t: number): Rgb {
  return [
    lerp(base[0], highlight[0], t),
    lerp(base[1], highlight[1], t),
    lerp(base[2], highlight[2], t),
  ];
}

function fgEscForRgb(tier: ColorTier, [r, g, b]: Rgb): string {
  if (tier === 'truecolor') return `\x1b[38;2;${r};${g};${b}m`;
  return `\x1b[38;5;${rgbTo256(r, g, b)}m`; // '256'
}

export interface ShimmerColors {
  tier: ColorTier;
  base: Rgb;
  highlight: Rgb;
  /** 16-color ANSI fg escape for the base color (used only at tier '16'). */
  ansiBaseFg: string;
}

/**
 * Triangular highlight intensity in [0, 1] for the character at `index` within
 * a `len`-char label, given sweep `progress` in [0, 1). The band center travels
 * left→right from just off the left edge to just off the right, so the
 * highlight enters and exits smoothly (the web's off-canvas 320% lead-in/out)
 * rather than popping at the ends.
 */
export function shimmerIntensity(index: number, len: number, progress: number): number {
  if (len <= 0) return 0;
  const half = Math.max(BAND_HALF_MIN, len * BAND_HALF_FRACTION);
  // Center sweeps [-half, (len-1)+half] as progress goes 0→1 (left→right).
  const center = -half + progress * (len - 1 + 2 * half);
  const d = Math.abs(index - center);
  if (d >= half) return 0;
  return 1 - d / half;
}

/** Sweep phase in [0, 1) for the given period. Wraps on negative input too. */
function phase(elapsedMs: number, periodMs: number): number {
  const m = ((elapsedMs % periodMs) + periodMs) % periodMs;
  return m / periodMs;
}

function styleCharByIntensity(ch: string, t: number, c: ShimmerColors): string {
  if (c.tier === 'none') return ch;
  if (c.tier === '16') {
    // No RGB blend available — degrade the brightness lift to modifiers on the
    // base color: DIM at the trough, BOLD at the peak, plain in the midband.
    const mod = t < 0.34 ? '\x1b[2m' : t < 0.67 ? '' : '\x1b[1m';
    return `${mod}${c.ansiBaseFg}${ch}${RESET}`;
  }
  const esc = fgEscForRgb(c.tier, lerpRgb(c.base, c.highlight, t));
  return `${esc}${ch}${RESET}`;
}

/**
 * Shimmer `text`: a brightness band sweeps left→right once per period.
 * Per-character SGR; never changes width (color only), so it is a drop-in
 * replacement for a `theme.style(...)` verb with no reflow risk.
 */
export function shimmerText(
  text: string,
  elapsedMs: number,
  colors: ShimmerColors,
  periodMs: number = VERB_SHIMMER_MS,
): string {
  if (colors.tier === 'none' || text.length === 0) return text;
  const p = phase(elapsedMs, periodMs);
  const len = text.length;
  let out = '';
  for (let i = 0; i < len; i++) {
    out += styleCharByIntensity(text[i], shimmerIntensity(i, len, p), colors);
  }
  return out;
}

/**
 * Single-cell glint for the hexagon avatar: a smooth breathe 0→1→0 over the
 * (slower) hex period. In one cell a traveling gap and a breathe are
 * indistinguishable, so this is the honest terminal rendering of the web
 * avatar's orbiting-gap "one slow lap, not a spinner".
 */
export function shimmerCell(
  glyph: string,
  elapsedMs: number,
  colors: ShimmerColors,
  periodMs: number = HEX_GLINT_MS,
): string {
  if (colors.tier === 'none') return glyph;
  const p = phase(elapsedMs, periodMs);
  // Raised-cosine breathe: 0 at p=0, 1 at p=0.5, 0 at p=1 — smooth and seamless.
  const t = 0.5 * (1 - Math.cos(2 * Math.PI * p));
  return styleCharByIntensity(glyph, t, colors);
}

// ── Theme-aware resolution ────────────────────────────────────────────────
// Resolve base/highlight from the theme's own tokens so the shimmer tracks the
// active variant: base = fg.secondary (muted), highlight = fg.primary (a
// brighter fg). That is the same base→highlight relationship the web encodes
// (`push-fg-secondary` → a brighter fg) — a brightness lift, never a hue tint.

export function shimmerColorsFor(theme: Pick<Theme, 'tier' | 'name'>): ShimmerColors {
  const variant = VARIANTS[theme.name as ThemeName] ?? VARIANTS.default;
  return {
    tier: theme.tier,
    base: hexToRgb(variant.tokens['fg.secondary']),
    highlight: hexToRgb(variant.tokens['fg.primary']),
    ansiBaseFg: variant.ansiFallback['fg.secondary'].fg ?? '',
  };
}

/**
 * True when the live verb should shimmer: motion is allowed (not reduced,
 * terminal has color) and this is a talking/thinking verb — a mood verb (no
 * activity), `thinking`, or `streaming` — not a tool "phase" verb. Matches the
 * web's rule of shimmering the themed dead-air verbs but not phase labels.
 */
export function shimmerEligible(activity: SpinnerActivity, tier: ColorTier): boolean {
  if (tier === 'none' || isReducedMotion()) return false;
  if (!activity) return true; // mood verb — the thinking dead-air state
  return activity.kind === 'thinking' || activity.kind === 'streaming';
}
