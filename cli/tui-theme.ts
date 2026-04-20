/**
 * tui-theme.ts — Design tokens, color system, and glyph sets for Push TUI.
 * Zero dependencies. Maps web design tokens (tailwind.config.js) to terminal escapes.
 *
 * Supports three color tiers:
 *   Tier 1: truecolor (24-bit)  — COLORTERM=truecolor|24bit
 *   Tier 2: 256-color           — TERM contains "256color"
 *   Tier 3: 16-color ANSI       — fallback
 *   none:   no color             — NO_COLOR set
 */

export type ColorTier = 'truecolor' | '256' | '16' | 'none';

export type TokenName = keyof typeof TOKENS;

export type ThemeName = 'default' | 'neon' | 'metallic' | 'mono' | 'solarized' | 'forest';

export interface GlyphSet {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
  prompt: string;
  divider: string;
  statusDot: string;
  teeRight: string;
  teeLeft: string;
  teeDown: string;
  teeUp: string;
  cross: string;
  ellipsis: string;
  arrow: string;
  check: string;
  cross_mark: string;
  branch: string;
  folder: string;
}

export interface Theme {
  tier: ColorTier;
  unicode: boolean;
  name: ThemeName;
  glyphs: GlyphSet;
  RESET: string;
  fg: (token: TokenName) => string;
  bg: (token: TokenName) => string;
  style: (token: TokenName, text: string) => string;
  styleBg: (token: TokenName, text: string) => string;
  styleFgBg: (fgToken: TokenName, bgToken: TokenName, text: string) => string;
  bold: (text: string) => string;
  dim: (text: string) => string;
  inverse: (text: string) => string;
}

export interface ThemeVariant {
  label: string;
  description: string;
  tokens: Record<TokenName, string>;
  ansiFallback: Record<TokenName, AnsiFallbackEntry>;
}

interface AnsiFallbackEntry {
  fg: string | null;
  bg: string | null;
}

const RESET = '\x1b[0m';

// ── Tier detection ──────────────────────────────────────────────────

export function detectColorTier(): ColorTier {
  if (process.env.NO_COLOR) return 'none';
  if (process.env.FORCE_COLOR === 'true' || process.env.FORCE_COLOR === '1') return 'truecolor';
  const ct = (process.env.COLORTERM || '').toLowerCase();
  if (ct === 'truecolor' || ct === '24bit') return 'truecolor';
  const term = (process.env.TERM || '').toLowerCase();
  if (term.includes('256color')) return '256';
  if (process.stdout?.isTTY) return '16';
  return 'none';
}

export function detectUnicode(): boolean {
  const lang = (process.env.LANG || process.env.LC_ALL || process.env.LC_CTYPE || '').toLowerCase();
  if (lang.includes('utf-8') || lang.includes('utf8')) return true;
  const term = (process.env.TERM_PROGRAM || '').toLowerCase();
  if (
    ['iterm', 'iterm2', 'hyper', 'wezterm', 'alacritty', 'kitty', 'warp', 'vscode'].some((t) =>
      term.includes(t),
    )
  )
    return true;
  // Windows Terminal sets WT_SESSION
  if (process.env.WT_SESSION) return true;
  return false;
}

// ── Escape builders ─────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function fgTrue(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}
function bgTrue(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[48;2;${r};${g};${b}m`;
}

// Approximate truecolor hex to nearest 256-color index
function rgbTo256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  return (
    16 + 36 * Math.round((r / 255) * 5) + 6 * Math.round((g / 255) * 5) + Math.round((b / 255) * 5)
  );
}

function fg256(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[38;5;${rgbTo256(r, g, b)}m`;
}
function bg256(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  return `\x1b[48;5;${rgbTo256(r, g, b)}m`;
}

// ── Design tokens ───────────────────────────────────────────────────
// Source of truth: app/tailwind.config.js push-* colors + Visual Language Spec

export const TOKENS = {
  'bg.base': '#070a10',
  'bg.panel': '#0c1018',
  'fg.primary': '#f5f7ff',
  'fg.secondary': '#b4becf',
  'fg.muted': '#8b96aa',
  'fg.dim': '#667086',
  'border.default': '#1f2531',
  'border.hover': '#2f3949',
  'accent.primary': '#0070f3',
  'accent.secondary': '#38bdf8',
  'accent.link': '#5cb7ff',
  'state.success': '#10b981',
  'state.warn': '#fbbf24',
  'state.error': '#ef4444',
} as const;

// 16-color ANSI fallback mapping (from Visual Language Spec)
const ANSI_FALLBACK: Record<TokenName, AnsiFallbackEntry> = {
  'bg.base': { fg: null, bg: '\x1b[40m' }, // black bg
  'bg.panel': { fg: null, bg: '\x1b[40m' }, // black bg
  'fg.primary': { fg: '\x1b[97m', bg: null }, // bright white
  'fg.secondary': { fg: '\x1b[37m', bg: null }, // white
  'fg.muted': { fg: '\x1b[90m', bg: null }, // bright black (gray)
  'fg.dim': { fg: '\x1b[90m', bg: null }, // bright black (gray)
  'border.default': { fg: '\x1b[90m', bg: null }, // dim gray
  'border.hover': { fg: '\x1b[37m', bg: null }, // white
  'accent.primary': { fg: '\x1b[34m', bg: null }, // blue
  'accent.secondary': { fg: '\x1b[36m', bg: null }, // cyan
  'accent.link': { fg: '\x1b[96m', bg: null }, // bright cyan
  'state.success': { fg: '\x1b[32m', bg: null }, // green
  'state.warn': { fg: '\x1b[33m', bg: null }, // yellow
  'state.error': { fg: '\x1b[31m', bg: null }, // red
};

// ── Theme variants ──────────────────────────────────────────────────
// Each variant is a full token palette + a 16-color ANSI fallback map.
// The `default` variant reuses the top-level TOKENS/ANSI_FALLBACK so
// downstream consumers that import them directly keep the same hex values.

const NEON_TOKENS: Record<TokenName, string> = {
  'bg.base': '#05020d',
  'bg.panel': '#0d061e',
  'fg.primary': '#f4eaff',
  'fg.secondary': '#c7a9ff',
  'fg.muted': '#8b6ec4',
  'fg.dim': '#5a4590',
  'border.default': '#2a1452',
  'border.hover': '#4b2691',
  'accent.primary': '#ff2bd6',
  'accent.secondary': '#00f0ff',
  'accent.link': '#7df9ff',
  'state.success': '#00ff9c',
  'state.warn': '#ffea00',
  'state.error': '#ff3566',
};

const NEON_ANSI: Record<TokenName, AnsiFallbackEntry> = {
  ...ANSI_FALLBACK,
  'accent.primary': { fg: '\x1b[95m', bg: null }, // bright magenta
  'accent.secondary': { fg: '\x1b[96m', bg: null }, // bright cyan
  'accent.link': { fg: '\x1b[96m', bg: null },
  'state.success': { fg: '\x1b[92m', bg: null }, // bright green
  'state.warn': { fg: '\x1b[93m', bg: null }, // bright yellow
  'state.error': { fg: '\x1b[91m', bg: null }, // bright red
};

const METALLIC_TOKENS: Record<TokenName, string> = {
  'bg.base': '#0a0d12',
  'bg.panel': '#141921',
  'fg.primary': '#e8ecf2',
  'fg.secondary': '#b0b9c6',
  'fg.muted': '#818b99',
  'fg.dim': '#5a6372',
  'border.default': '#2a323f',
  'border.hover': '#3d4857',
  'accent.primary': '#a0b4cf',
  'accent.secondary': '#cfd8e3',
  'accent.link': '#8eafd1',
  'state.success': '#4fd1c5',
  'state.warn': '#eab308',
  'state.error': '#f87171',
};

const METALLIC_ANSI: Record<TokenName, AnsiFallbackEntry> = {
  ...ANSI_FALLBACK,
  'accent.primary': { fg: '\x1b[37m', bg: null }, // white
  'accent.secondary': { fg: '\x1b[97m', bg: null }, // bright white
  'accent.link': { fg: '\x1b[37m', bg: null },
};

const MONO_TOKENS: Record<TokenName, string> = {
  'bg.base': '#0a0a0a',
  'bg.panel': '#121212',
  'fg.primary': '#f5f5f5',
  'fg.secondary': '#bdbdbd',
  'fg.muted': '#8a8a8a',
  'fg.dim': '#5e5e5e',
  'border.default': '#2a2a2a',
  'border.hover': '#3f3f3f',
  'accent.primary': '#eaeaea',
  'accent.secondary': '#bfbfbf',
  'accent.link': '#ffffff',
  // Tinted just enough to preserve the success/warn/error signal without
  // breaking the grayscale feel.
  'state.success': '#d5dccb',
  'state.warn': '#dcd3b3',
  'state.error': '#dcb3b3',
};

const MONO_ANSI: Record<TokenName, AnsiFallbackEntry> = {
  ...ANSI_FALLBACK,
  'accent.primary': { fg: '\x1b[97m', bg: null },
  'accent.secondary': { fg: '\x1b[37m', bg: null },
  'accent.link': { fg: '\x1b[97m', bg: null },
};

const SOLARIZED_TOKENS: Record<TokenName, string> = {
  'bg.base': '#002b36',
  'bg.panel': '#073642',
  'fg.primary': '#eee8d5',
  'fg.secondary': '#93a1a1',
  'fg.muted': '#839496',
  'fg.dim': '#657b83',
  'border.default': '#586e75',
  'border.hover': '#93a1a1',
  'accent.primary': '#268bd2',
  'accent.secondary': '#2aa198',
  'accent.link': '#6c71c4',
  'state.success': '#859900',
  'state.warn': '#b58900',
  'state.error': '#dc322f',
};

const SOLARIZED_ANSI: Record<TokenName, AnsiFallbackEntry> = {
  ...ANSI_FALLBACK,
  'accent.primary': { fg: '\x1b[94m', bg: null }, // bright blue
  'accent.secondary': { fg: '\x1b[36m', bg: null }, // cyan
  'accent.link': { fg: '\x1b[95m', bg: null }, // bright magenta (violet-ish)
};

const FOREST_TOKENS: Record<TokenName, string> = {
  'bg.base': '#0a1410',
  'bg.panel': '#101d16',
  'fg.primary': '#e4f0e0',
  'fg.secondary': '#b3c9a8',
  'fg.muted': '#849878',
  'fg.dim': '#5c6f52',
  'border.default': '#1e2f23',
  'border.hover': '#2d4433',
  'accent.primary': '#6bbf59',
  'accent.secondary': '#c4a265',
  'accent.link': '#8fd17b',
  'state.success': '#8bc34a',
  'state.warn': '#e5b53a',
  'state.error': '#d96b4a',
};

const FOREST_ANSI: Record<TokenName, AnsiFallbackEntry> = {
  ...ANSI_FALLBACK,
  'accent.primary': { fg: '\x1b[32m', bg: null }, // green
  'accent.secondary': { fg: '\x1b[33m', bg: null }, // yellow
  'accent.link': { fg: '\x1b[92m', bg: null }, // bright green
};

export const VARIANTS: Record<ThemeName, ThemeVariant> = {
  default: {
    label: 'Default',
    description: 'Push web tokens — dark navy with blue accent',
    tokens: { ...TOKENS },
    ansiFallback: ANSI_FALLBACK,
  },
  neon: {
    label: 'Neon',
    description: 'Magenta + cyan on near-black (cyberpunk)',
    tokens: NEON_TOKENS,
    ansiFallback: NEON_ANSI,
  },
  metallic: {
    label: 'Metallic',
    description: 'Steely grays with cool blue tint (chrome)',
    tokens: METALLIC_TOKENS,
    ansiFallback: METALLIC_ANSI,
  },
  mono: {
    label: 'Mono',
    description: 'Near-grayscale for minimal visual noise',
    tokens: MONO_TOKENS,
    ansiFallback: MONO_ANSI,
  },
  solarized: {
    label: 'Solarized',
    description: 'Solarized-dark-inspired warm palette',
    tokens: SOLARIZED_TOKENS,
    ansiFallback: SOLARIZED_ANSI,
  },
  forest: {
    label: 'Forest',
    description: 'Earthy greens and tans (nature)',
    tokens: FOREST_TOKENS,
    ansiFallback: FOREST_ANSI,
  },
};

export const THEME_NAMES = Object.keys(VARIANTS) as ThemeName[];

export function isThemeName(value: unknown): value is ThemeName {
  return typeof value === 'string' && value in VARIANTS;
}

export function detectThemeName(): ThemeName {
  const env = (process.env.PUSH_THEME || '').toLowerCase().trim();
  if (isThemeName(env)) return env;
  return 'default';
}

// ── Glyph sets ──────────────────────────────────────────────────────

export const GLYPHS_UNICODE: GlyphSet = {
  topLeft: '┌',
  topRight: '┐',
  bottomLeft: '└',
  bottomRight: '┘',
  horizontal: '─',
  vertical: '│',
  prompt: '›',
  divider: '─',
  statusDot: '●',
  teeRight: '├',
  teeLeft: '┤',
  teeDown: '┬',
  teeUp: '┴',
  cross: '┼',
  ellipsis: '…',
  arrow: '→',
  check: '✓',
  cross_mark: '✗',
  branch: '',
  folder: '',
};

export const GLYPHS_ASCII: GlyphSet = {
  topLeft: '+',
  topRight: '+',
  bottomLeft: '+',
  bottomRight: '+',
  horizontal: '-',
  vertical: '|',
  prompt: '>',
  divider: '-',
  statusDot: '*',
  teeRight: '+',
  teeLeft: '+',
  teeDown: '+',
  teeUp: '+',
  cross: '+',
  ellipsis: '...',
  arrow: '->',
  check: 'ok',
  cross_mark: 'x',
  branch: 'git:',
  folder: 'dir:',
};

// ── Theme factory ───────────────────────────────────────────────────

/**
 * Create a theme object. All styling goes through this.
 */
export function createTheme(
  overrides: { tier?: ColorTier; unicode?: boolean; name?: ThemeName | string } = {},
): Theme {
  const tier: ColorTier = overrides.tier ?? detectColorTier();
  const unicode: boolean = overrides.unicode ?? detectUnicode();
  const name: ThemeName = isThemeName(overrides.name) ? overrides.name : detectThemeName();
  const variant = VARIANTS[name];
  const glyphs: GlyphSet = unicode ? GLYPHS_UNICODE : GLYPHS_ASCII;

  /**
   * Return the ANSI escape to set foreground color for a given token.
   * Does NOT include RESET — caller is responsible for resetting.
   */
  function fg(token: TokenName): string {
    if (tier === 'none') return '';
    const hex = variant.tokens[token];
    if (!hex) return '';
    if (tier === 'truecolor') return fgTrue(hex);
    if (tier === '256') return fg256(hex);
    return variant.ansiFallback[token]?.fg || '';
  }

  /**
   * Return the ANSI escape to set background color for a given token.
   */
  function bg(token: TokenName): string {
    if (tier === 'none') return '';
    const hex = variant.tokens[token];
    if (!hex) return '';
    if (tier === 'truecolor') return bgTrue(hex);
    if (tier === '256') return bg256(hex);
    return variant.ansiFallback[token]?.bg || '';
  }

  /** Wrap text with foreground token color + reset. */
  function style(token: TokenName, text: string): string {
    const esc = fg(token);
    return esc ? `${esc}${text}${RESET}` : text;
  }

  /** Wrap text with background token color + reset. */
  function styleBg(token: TokenName, text: string): string {
    const esc = bg(token);
    return esc ? `${esc}${text}${RESET}` : text;
  }

  /** Combine fg + bg tokens. */
  function styleFgBg(fgToken: TokenName, bgToken: TokenName, text: string): string {
    const fgEsc = fg(fgToken);
    const bgEsc = bg(bgToken);
    if (!fgEsc && !bgEsc) return text;
    return `${fgEsc}${bgEsc}${text}${RESET}`;
  }

  function bold(text: string): string {
    return tier === 'none' ? text : `\x1b[1m${text}\x1b[22m`;
  }
  function dim(text: string): string {
    return tier === 'none' ? text : `\x1b[2m${text}\x1b[22m`;
  }
  function inverse(text: string): string {
    return tier === 'none' ? text : `\x1b[7m${text}\x1b[27m`;
  }

  return {
    tier,
    unicode,
    name,
    glyphs,
    RESET,
    fg,
    bg,
    style,
    styleBg,
    styleFgBg,
    bold,
    dim,
    inverse,
  };
}

// ── Preview rendering ────────────────────────────────────────────────
// Rows shown in the swatch preview. Order + labels chosen to group the
// semantic tokens (bg / fg / accent / state) visually.
const PREVIEW_ROWS: ReadonlyArray<{ token: TokenName; label: string; kind: 'bg' | 'fg' }> = [
  { token: 'bg.base', label: 'bg.base', kind: 'bg' },
  { token: 'bg.panel', label: 'bg.panel', kind: 'bg' },
  { token: 'fg.primary', label: 'fg.primary', kind: 'fg' },
  { token: 'fg.secondary', label: 'fg.secondary', kind: 'fg' },
  { token: 'fg.muted', label: 'fg.muted', kind: 'fg' },
  { token: 'fg.dim', label: 'fg.dim', kind: 'fg' },
  { token: 'border.default', label: 'border.default', kind: 'fg' },
  { token: 'border.hover', label: 'border.hover', kind: 'fg' },
  { token: 'accent.primary', label: 'accent.primary', kind: 'fg' },
  { token: 'accent.secondary', label: 'accent.secondary', kind: 'fg' },
  { token: 'accent.link', label: 'accent.link', kind: 'fg' },
  { token: 'state.success', label: 'state.success', kind: 'fg' },
  { token: 'state.warn', label: 'state.warn', kind: 'fg' },
  { token: 'state.error', label: 'state.error', kind: 'fg' },
];

/**
 * Render a multi-line preview of a theme variant: colored swatches +
 * token names + hex values. Honours `tier` so NO_COLOR / 16-color
 * terminals still get a readable (if uncoloured) listing.
 */
export function renderThemePreview(
  name: ThemeName | string,
  opts: { tier?: ColorTier; unicode?: boolean } = {},
): string {
  const resolvedName: ThemeName = isThemeName(name) ? name : 'default';
  const variant = VARIANTS[resolvedName];
  const theme = createTheme({ ...opts, name: resolvedName });
  const swatchGlyph = theme.unicode ? '██████' : '######';
  const widestLabel = PREVIEW_ROWS.reduce((w, r) => Math.max(w, r.label.length), 0);

  const header = `${theme.bold(variant.label)} ${theme.dim(`(${resolvedName})`)} — ${variant.description}`;
  const rows = PREVIEW_ROWS.map((row) => {
    const hex = variant.tokens[row.token];
    const swatch =
      row.kind === 'bg'
        ? theme.styleBg(row.token, swatchGlyph)
        : theme.style(row.token, swatchGlyph);
    const label = row.label.padEnd(widestLabel);
    return `  ${swatch}  ${label}  ${theme.dim(hex)}`;
  });
  return [header, ...rows].join('\n');
}
