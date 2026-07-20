/**
 * Cross-surface identity palette — the single source for the colors that must
 * read identically on the web app (Tailwind `push-*` tokens) and the TUI
 * (`cli/tui-theme.ts` default variant). Each surface adapts these to its own
 * token names and renders them natively: CSS on the web, a truecolor → 256 → 16
 * downsample on the terminal.
 *
 * Scope is the *identity layer*, not every value. Web-only nuance shades (extra
 * fg tints, surface/edge variants, status soft/bg variants) and the TUI's
 * alternate theme variants (neon, …) intentionally stay per-surface — sharing
 * those would fight each surface's native expression rather than unify identity.
 *
 * Drift guard: the CJS Tailwind config (`app/tailwind.config.js`) can't import
 * this TS module at build time, so it mirrors these values into its `push-*`
 * tokens and `app/src/lib/design-tokens-drift.test.ts` fails CI if the two ever
 * disagree — the cross-boundary lock, same pattern as `protocol-drift.test.mjs`.
 * The TUI imports this module directly, so it can't drift at all.
 */
export const identityPalette = {
  /** Base + raised surfaces. Maps to web `push-surface` / `push-surface-raised`.
   *  `base` is pure black (AMOLED): the large dark areas render true `#000000`;
   *  `raised` stays a distinct dark-gray so cards/panels keep a legible lift on
   *  black even where depth shadows can't (a black ambient shadow is invisible
   *  on a black base). */
  surface: { base: '#000000', raised: '#14171f' },
  /** Text hierarchy (bright → dim). Maps to web `push-fg{,-secondary,-muted,-dim}`. */
  fg: { primary: '#f5f7ff', secondary: '#b4becf', muted: '#8b96aa', dim: '#667086' },
  /** Borders. Maps to web `push-edge` / `push-edge-hover`. */
  edge: { default: '#2b3340', hover: '#2f3949' },
  /** Sky accent — the airy identity color. Maps to web `push-accent` / `push-sky` / `push-link`. */
  accent: { sky: '#7dd3fc', skyMid: '#38bdf8', link: '#7dd3fc' },
  /** Status. Maps to web `push-status-success` / `push-status-warning` / `push-status-error`. */
  state: { success: '#22c55e', warning: '#f59e0b', error: '#ef4444' },
} as const;
