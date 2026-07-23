/**
 * Silvery theme bridge — maps Push theme variants onto silvery's ThemeProvider.
 *
 * Law 2: the AMOLED/grayscale foundation stays fixed while themes choose a
 * restrained semantic palette. We provide a sparse flat-token override so
 * `$fg-accent` / cursor / selection share one focus color, and info/link,
 * success, warning, error, and code roles keep stable meanings.
 *
 * ── Which silvery components we may use ──────────────────────────────
 *
 * The import line is not an accident, and it is not an under-adoption to be
 * cleaned up. Silvery's API splits cleanly in two, and only one half is
 * compatible with the Push surface:
 *
 *  - STRUCTURAL — `Box`, `Text`, `ListView`, `TextArea`, `ModalDialog`,
 *    `Screen`, `useInput`, … These carry no color semantics of their own; we
 *    supply the color. Use freely. This is what the TUI is built on.
 *
 *  - SEMANTIC / CHROMATIC — `Diff`, `Alert`, `Badge`, `Banner`, `InlineAlert`,
 *    variant-bearing toasts/progress. Their role colors now resolve correctly,
 *    but adoption is still deliberate: Push's glyph, transcript geometry, and
 *    fallback contracts are not automatically satisfied by a matching hue.
 *
 * A third category worth naming, because it is neither of the above:
 *
 *  - RIGHT NAME, WRONG BEHAVIOR — `TextShimmer`. Our header verb shimmers, so
 *    this looks like the component we obviously want. It is not. Two reasons,
 *    each disqualifying on its own:
 *      1. It is a whole-word BINARY FLIP, not a sweep: the body is literally
 *         `color: value > .5 ? highColor : lowColor`. Every character changes
 *         together. That is a blink; ours is a band travelling across the
 *         label, which is the whole effect.
 *      2. It runs its OWN `useAnimation` timer at its own period. Law 8 is one
 *         shared clock precisely so concurrent effects stay phase-locked — a
 *         private 1200ms timer beating against our 150ms tick is the "two
 *         animations at different periods read as flicker" failure the law
 *         exists to prevent.
 *    Use `verbShimmerColors()` from `visual-language.ts`, which is pure, takes
 *    the shared tick, and returns one color per character.
 *
 * `Diff` still is not a drop-in replacement for `EditDiff`: its geometry,
 * wrapping, copy behavior, and no-color fallback differ from Push's transcript
 * contract. See `diffLineColor()` in `visual-language.ts`; matching semantic
 * colors is necessary, not sufficient.
 */

import React, { useMemo, type ReactNode } from 'react';
import { ThemeProvider, type ThemeTokens } from 'silvery';

import { detectThemeName, isThemeName, VARIANTS, type ThemeName } from '../tui-theme.js';
import { accentHexForTheme } from './visual-language.js';

export function resolvePushThemeName(name?: string | null): ThemeName {
  if (isThemeName(name)) return name;
  return detectThemeName();
}

export function createPushSilveryTokens(name?: string | null): ThemeTokens {
  const resolved = resolvePushThemeName(name);
  const semantic = VARIANTS[resolved].tokens;
  const accent = accentHexForTheme(semantic['accent.primary']);
  const info = semantic['accent.secondary'];
  const link = semantic['accent.link'];
  const success = semantic['state.success'];
  const warning = semantic['state.warn'];
  const fault = semantic['state.error'];
  const code = semantic['accent.secondary'];
  const neutral = VARIANTS.mono.tokens;
  const background = neutral['bg.base'];
  const panel = neutral['bg.panel'];
  const foreground = neutral['fg.primary'];
  const muted = neutral['fg.muted'];
  const border = neutral['border.default'];
  return {
    name: `push-${resolved}`,
    // Push's severe near-black canvas is identity, not terminal decoration.
    // Theme selection changes semantic hues; it does not replace the
    // AMOLED/grayscale foundation with Silvery's stock Nord surfaces.
    bg: background,
    fg: foreground,
    'fg-default': foreground,
    'fg-hover': foreground,
    'fg-active': foreground,
    'fg-muted': muted,
    'bg-default': background,
    'bg-surface-default': background,
    'bg-surface-subtle': panel,
    'bg-surface-raised': panel,
    'bg-surface-overlay': panel,
    'bg-surface-hover': panel,
    'bg-muted': panel,
    'bg-disabled': panel,
    'bg-backdrop': background,
    'border-default': border,
    'border-muted': border,
    'border-disabled': border,
    'border-focus': accent,
    'fg-accent': accent,
    'bg-accent': accent,
    'border-accent': accent,
    'fg-on-accent': background,
    'fg-accent-hover': accent,
    'fg-accent-active': accent,
    'fg-link': link,
    'fg-info': info,
    'fg-code': code,
    'fg-success': success,
    'fg-warning': warning,
    'fg-cursor': background,
    'bg-cursor': accent,
    'bg-selected': accent,
    'fg-on-selected': background,
    'bg-selected-hover': accent,
    'bg-inverse': foreground,
    'fg-on-inverse': background,
    // Semantic components stay quiet on the AMOLED canvas: hue belongs to
    // text/borders, not saturated full-cell fills.
    'bg-info': panel,
    'fg-on-info': info,
    'bg-success': panel,
    'fg-on-success': success,
    'bg-warning': panel,
    'fg-on-warning': warning,
    'fg-error': fault,
    'bg-error': panel,
    'fg-on-error': fault,
  };
}

export function PushThemeProvider({
  themeName,
  children,
}: {
  themeName?: string | null;
  children: ReactNode;
}) {
  const tokens = useMemo(() => createPushSilveryTokens(themeName), [themeName]);
  return <ThemeProvider tokens={tokens}>{children}</ThemeProvider>;
}
