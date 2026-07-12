/**
 * Silvery theme bridge — maps Push theme variants onto silvery's ThemeProvider.
 *
 * Law 2: themes pick *which hue* the accent is; they may not raise the budget.
 * We provide a sparse flat-token override so `$fg-accent` / cursor / selection
 * share one primary while every other semantic token inherits Silvery's
 * complete base theme. Surfaces must still refuse `$fg-success` / multi-color
 * role chrome — that discipline lives in `visual-language.ts` + `surface.tsx`.
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
  return {
    name: `push-${resolved}`,
    'fg-accent': accent,
    'bg-accent': accent,
    'border-accent': accent,
    'fg-accent-hover': accent,
    'fg-accent-active': accent,
    'bg-cursor': accent,
    'bg-selected': accent,
    'bg-selected-hover': accent,
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
