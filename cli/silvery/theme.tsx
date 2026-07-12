/**
 * Silvery theme bridge — maps Push theme variants onto silvery's ThemeProvider.
 *
 * Law 2: themes pick *which hue* the accent is; they may not raise the budget.
 * We feed `generateTheme(accentHex, dark)` so `$fg-accent` / cursor / selection
 * share one primary. Surfaces must still refuse `$fg-success` / multi-color
 * role chrome — that discipline lives in `visual-language.ts` + `surface.tsx`.
 */

import React, { useMemo, type ReactNode } from 'react';
import { generateTheme, ThemeProvider, type Theme } from 'silvery';

import { detectThemeName, isThemeName, VARIANTS, type ThemeName } from '../tui-theme.js';
import { accentHexForTheme } from './visual-language.js';

export function resolvePushThemeName(name?: string | null): ThemeName {
  if (isThemeName(name)) return name;
  return detectThemeName();
}

export function createPushSilveryTheme(name?: string | null): Theme {
  const resolved = resolvePushThemeName(name);
  const accent = accentHexForTheme(VARIANTS[resolved].tokens['accent.primary']);
  // Runtime accepts a hex primary; silvery's published type is the named
  // AnsiPrimary union only. Cast through unknown so theme variants can supply
  // identity-palette hex values without lying about a named color.
  const theme = generateTheme(accent as unknown as 'blue', true);
  // Stamp a stable name so re-renders can key ThemeProvider when /theme flips.
  return { ...theme, name: `push-${resolved}` };
}

export function PushThemeProvider({
  themeName,
  children,
}: {
  themeName?: string | null;
  children: ReactNode;
}) {
  const theme = useMemo(() => createPushSilveryTheme(themeName), [themeName]);
  return <ThemeProvider theme={theme}>{children}</ThemeProvider>;
}
