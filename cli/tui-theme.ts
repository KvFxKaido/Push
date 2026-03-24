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
  if (['iterm', 'iterm2', 'hyper', 'wezterm', 'alacritty', 'kitty', 'warp', 'vscode'].some(t => term.includes(t))) return true;
  // Windows Terminal sets WT_SESSION
  if (process.env.WT_SESSION) return true;
  return false;
}

// ── Escape builders ─────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function fgTrue(hex: string): string { const [r, g, b] = hexToRgb(hex); return `\x1b[38;2;${r};${g};${b}m`; }
function bgTrue(hex: string): string { const [r, g, b] = hexToRgb(hex); return `\x1b[48;2;${r};${g};${b}m`; }

// Approximate truecolor hex to nearest 256-color index
function rgbTo256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round((r - 8) / 247 * 24) + 232;
  }
  return 16 + (36 * Math.round(r / 255 * 5)) + (6 * Math.round(g / 255 * 5)) + Math.round(b / 255 * 5);
}

function fg256(hex: string): string { const [r, g, b] = hexToRgb(hex); return `\x1b[38;5;${rgbTo256(r, g, b)}m`; }
function bg256(hex: string): string { const [r, g, b] = hexToRgb(hex); return `\x1b[48;5;${rgbTo256(r, g, b)}m`; }

// ── Design tokens ───────────────────────────────────────────────────
// Source of truth: app/tailwind.config.js push-* colors + Visual Language Spec

export const TOKENS = {
  'bg.base':           '#070a10',
  'bg.panel':          '#0c1018',
  'fg.primary':        '#f5f7ff',
  'fg.secondary':      '#b4becf',
  'fg.muted':          '#8b96aa',
  'fg.dim':            '#667086',
  'border.default':    '#1f2531',
  'border.hover':      '#2f3949',
  'accent.primary':    '#0070f3',
  'accent.secondary':  '#38bdf8',
  'accent.link':       '#5cb7ff',
  'state.success':     '#10b981',
  'state.warn':        '#fbbf24',
  'state.error':       '#ef4444',
} as const;

// 16-color ANSI fallback mapping (from Visual Language Spec)
const ANSI_FALLBACK: Record<TokenName, AnsiFallbackEntry> = {
  'bg.base':          { fg: null, bg: '\x1b[40m' },          // black bg
  'bg.panel':         { fg: null, bg: '\x1b[40m' },          // black bg
  'fg.primary':       { fg: '\x1b[97m', bg: null },          // bright white
  'fg.secondary':     { fg: '\x1b[37m', bg: null },          // white
  'fg.muted':         { fg: '\x1b[90m', bg: null },          // bright black (gray)
  'fg.dim':           { fg: '\x1b[90m', bg: null },          // bright black (gray)
  'border.default':   { fg: '\x1b[90m', bg: null },          // dim gray
  'border.hover':     { fg: '\x1b[37m', bg: null },          // white
  'accent.primary':   { fg: '\x1b[34m', bg: null },          // blue
  'accent.secondary': { fg: '\x1b[36m', bg: null },          // cyan
  'accent.link':      { fg: '\x1b[96m', bg: null },          // bright cyan
  'state.success':    { fg: '\x1b[32m', bg: null },          // green
  'state.warn':       { fg: '\x1b[33m', bg: null },          // yellow
  'state.error':      { fg: '\x1b[31m', bg: null },          // red
};

// ── Glyph sets ──────────────────────────────────────────────────────

export const GLYPHS_UNICODE: GlyphSet = {
  topLeft:     '┌',
  topRight:    '┐',
  bottomLeft:  '└',
  bottomRight: '┘',
  horizontal:  '─',
  vertical:    '│',
  prompt:      '›',
  divider:     '─',
  statusDot:   '●',
  teeRight:    '├',
  teeLeft:     '┤',
  teeDown:     '┬',
  teeUp:       '┴',
  cross:       '┼',
  ellipsis:    '…',
  arrow:       '→',
  check:       '✓',
  cross_mark:  '✗',
  branch:      '',
  folder:      '',
};

export const GLYPHS_ASCII: GlyphSet = {
  topLeft:     '+',
  topRight:    '+',
  bottomLeft:  '+',
  bottomRight: '+',
  horizontal:  '-',
  vertical:    '|',
  prompt:      '>',
  divider:     '-',
  statusDot:   '*',
  teeRight:    '+',
  teeLeft:     '+',
  teeDown:     '+',
  teeUp:       '+',
  cross:       '+',
  ellipsis:    '...',
  arrow:       '->',
  check:       'ok',
  cross_mark:  'x',
  branch:      'git:',
  folder:      'dir:',
};

// ── Theme factory ───────────────────────────────────────────────────

/**
 * Create a theme object. All styling goes through this.
 */
export function createTheme(overrides: { tier?: ColorTier; unicode?: boolean } = {}): Theme {
  const tier: ColorTier = overrides.tier ?? detectColorTier();
  const unicode: boolean = overrides.unicode ?? detectUnicode();
  const glyphs: GlyphSet = unicode ? GLYPHS_UNICODE : GLYPHS_ASCII;

  /**
   * Return the ANSI escape to set foreground color for a given token.
   * Does NOT include RESET — caller is responsible for resetting.
   */
  function fg(token: TokenName): string {
    if (tier === 'none') return '';
    const hex = TOKENS[token];
    if (!hex) return '';
    if (tier === 'truecolor') return fgTrue(hex);
    if (tier === '256') return fg256(hex);
    return ANSI_FALLBACK[token]?.fg || '';
  }

  /**
   * Return the ANSI escape to set background color for a given token.
   */
  function bg(token: TokenName): string {
    if (tier === 'none') return '';
    const hex = TOKENS[token];
    if (!hex) return '';
    if (tier === 'truecolor') return bgTrue(hex);
    if (tier === '256') return bg256(hex);
    return ANSI_FALLBACK[token]?.bg || '';
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

  function bold(text: string): string { return tier === 'none' ? text : `\x1b[1m${text}\x1b[22m`; }
  function dim(text: string): string  { return tier === 'none' ? text : `\x1b[2m${text}\x1b[22m`; }
  function inverse(text: string): string { return tier === 'none' ? text : `\x1b[7m${text}\x1b[27m`; }

  return {
    tier,
    unicode,
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
