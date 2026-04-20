/**
 * tui-animator.ts — time-varying color overlay for TUI text (prototype).
 *
 * Post-processes a text string by emitting a foreground ANSI color per
 * character, where the color is a pure function of (tick, position, effect).
 * The calling code is responsible for advancing `tick` at a fixed rate and
 * forcing a re-render; this module itself does no timing and no I/O.
 *
 * Scope for the prototype:
 *   - Three effects: pulse (single-hue brightness wave), shimmer (chrome
 *     highlight travelling across), rainbow (HSL hue rotation).
 *   - Truecolor + 256-color tiers. 16-color gets a best-effort cycle; `none`
 *     returns the input text unchanged.
 *   - Foreground only — no background animation (keeps text readable).
 */

import type { ColorTier } from './tui-theme.js';
import { rgbTo256 } from './tui-theme.js';

export type AnimationEffect = 'off' | 'pulse' | 'shimmer' | 'rainbow';

export const ANIMATION_EFFECTS: readonly AnimationEffect[] = ['off', 'pulse', 'shimmer', 'rainbow'];

export const ANIMATION_DESCRIPTIONS: Record<AnimationEffect, string> = {
  off: 'No animation',
  pulse: 'Smooth sinusoidal brightness pulse (magenta)',
  shimmer: 'Chrome-like highlight sweeping across the text',
  rainbow: 'HSL hue rotation across character positions',
};

// One period (in ticks) per effect. At the prototype's 10 FPS cadence, 20
// ticks ≈ 2 s — slow enough to feel alive but not to distract.
const PERIOD_TICKS: Record<AnimationEffect, number> = {
  off: 1,
  pulse: 20,
  shimmer: 30,
  rainbow: 60,
};

// Safe wraparound modulus for the tick counter. Must be a common multiple of
// every effect's period so each phase returns to 0 when the counter wraps —
// otherwise long-running sessions would see a one-frame glitch every time
// the counter hits its cap. LCM(20, 30, 60) = 60, so any multiple of 60 is
// seamless; picking a larger value keeps the counter monotonically useful
// for debugging without sacrificing continuity.
export const TICK_MODULUS = 60 * 60 * 60; // 216 000 — every 6h at 10 FPS

export function isAnimationEffect(value: unknown): value is AnimationEffect {
  return typeof value === 'string' && (ANIMATION_EFFECTS as readonly string[]).includes(value);
}

// ── Color math ──────────────────────────────────────────────────────

function clamp8(n: number): number {
  if (n < 0) return 0;
  if (n > 255) return 255;
  return Math.round(n);
}

/**
 * HSL → RGB. h in [0, 360), s/l in [0, 1]. Returns integer channels in [0, 255].
 * Straightforward port of the CSS spec formula; kept inline to avoid a dep.
 */
export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hh = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = l - c / 2;
  let r1 = 0;
  let g1 = 0;
  let b1 = 0;
  if (hh < 60) {
    r1 = c;
    g1 = x;
  } else if (hh < 120) {
    r1 = x;
    g1 = c;
  } else if (hh < 180) {
    g1 = c;
    b1 = x;
  } else if (hh < 240) {
    g1 = x;
    b1 = c;
  } else if (hh < 300) {
    r1 = x;
    b1 = c;
  } else {
    r1 = c;
    b1 = x;
  }
  return [clamp8((r1 + m) * 255), clamp8((g1 + m) * 255), clamp8((b1 + m) * 255)];
}

/**
 * Color for one character given the effect, tick, and character position.
 * Pure function — unit-testable without any terminal state.
 */
export function effectColor(
  effect: AnimationEffect,
  tick: number,
  position: number,
): [number, number, number] {
  const period = PERIOD_TICKS[effect] || 1;

  if (effect === 'pulse') {
    // Magenta hue pulsing in brightness. Phase is tick-only so every
    // character pulses together — reads as a heartbeat.
    const phase = (tick / period) * 2 * Math.PI;
    const lightness = 0.45 + 0.25 * Math.sin(phase);
    return hslToRgb(310, 0.85, lightness);
  }

  if (effect === 'shimmer') {
    // Base cool gray with a highlight band travelling left → right across
    // the text. Phase depends on (tick - position) so the highlight moves.
    const phase = ((tick - position) / period) * 2 * Math.PI;
    const highlight = 0.5 + 0.5 * Math.sin(phase); // [0, 1]
    const lightness = 0.55 + 0.3 * highlight; // silver → bright silver
    return hslToRgb(215, 0.15, lightness);
  }

  if (effect === 'rainbow') {
    // Hue rotates with tick and spreads across positions so adjacent chars
    // sit at slightly different hues — produces a diagonal rainbow band.
    const hue = (tick * (360 / period) + position * 15) % 360;
    return hslToRgb(hue, 0.8, 0.6);
  }

  return [255, 255, 255];
}

// ── Text decoration ─────────────────────────────────────────────────

function fgTrue(r: number, g: number, b: number): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

function fg256(r: number, g: number, b: number): string {
  return `\x1b[38;5;${rgbTo256(r, g, b)}m`;
}

// Six bright ANSI foreground codes cycled by hue bucket for the 16-color
// tier. Intentionally coarse — the prototype's real target is truecolor.
const ANSI16_CYCLE = ['\x1b[91m', '\x1b[93m', '\x1b[92m', '\x1b[96m', '\x1b[94m', '\x1b[95m'];

// Default-foreground code (NOT a full SGR reset). Using `\x1b[0m` per char
// would cancel outer `theme.bold(...)` / background / underline styles that
// wrap the animated span; `\x1b[39m` only resets the foreground colour.
const FG_RESET = '\x1b[39m';

/**
 * Return `text` with per-character ANSI color escapes applied based on the
 * effect + tick. No-ops when effect is 'off' or the tier is 'none' — callers
 * can pass user-facing text directly without pre-checking.
 */
export function animateText(
  text: string,
  effect: AnimationEffect,
  tick: number,
  tier: ColorTier,
): string {
  if (effect === 'off' || tier === 'none' || text.length === 0) return text;

  const chars = [...text]; // split by code point so multi-byte glyphs animate as one unit
  const out: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    // Skip coloring on whitespace to avoid flashing empty cells.
    if (/\s/.test(ch)) {
      out.push(ch);
      continue;
    }
    const [r, g, b] = effectColor(effect, tick, i);
    let esc: string;
    if (tier === 'truecolor') {
      esc = fgTrue(r, g, b);
    } else if (tier === '256') {
      esc = fg256(r, g, b);
    } else {
      // tier === '16'
      const bucket = Math.floor(((((r * 3 + g * 6 + b) / 10 + tick) % 6) + 6) % 6);
      esc = ANSI16_CYCLE[bucket];
    }
    out.push(`${esc}${ch}${FG_RESET}`);
  }
  return out.join('');
}
