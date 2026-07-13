/**
 * Silvery theme bridge — maps Push theme variants onto silvery's ThemeProvider.
 *
 * Law 2: themes pick *which hue* the accent is; they may not raise the budget.
 * We provide a sparse flat-token override so `$fg-accent` / cursor / selection
 * share one primary, while Push's mono palette supplies the neutral canvas.
 * This keeps named themes inside the one-accent budget instead of inheriting
 * Silvery's chromatic Nord surface. Surfaces must still refuse `$fg-success` /
 * multi-color role chrome — that discipline lives in `visual-language.ts` +
 * `surface.tsx`.
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
  const accent = accentHexForTheme(VARIANTS[resolved].tokens['accent.primary']);
  const neutral = VARIANTS.mono.tokens;
  const background = neutral['bg.base'];
  const panel = neutral['bg.panel'];
  const foreground = neutral['fg.primary'];
  const muted = neutral['fg.muted'];
  const border = neutral['border.default'];
  const fault = neutral['state.error'];
  return {
    name: `push-${resolved}`,
    // Push's severe near-black canvas is identity, not terminal decoration.
    // Theme selection changes the live accent; it does not replace the
    // grayscale posture with Silvery's stock Nord surfaces.
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
    'fg-link': accent,
    'fg-cursor': background,
    'bg-cursor': accent,
    'bg-selected': accent,
    'fg-on-selected': background,
    'bg-selected-hover': accent,
    'bg-inverse': foreground,
    'fg-on-inverse': background,
    'fg-error': fault,
    'bg-error': fault,
    'fg-on-error': background,
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
