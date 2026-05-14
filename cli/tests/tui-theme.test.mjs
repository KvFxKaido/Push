import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTheme,
  detectColorTier,
  detectThemeName,
  detectUnicode,
  isThemeName,
  renderThemePreview,
  TOKENS,
  THEME_NAMES,
  VARIANTS,
  GLYPHS_UNICODE,
  GLYPHS_ASCII,
} from '../tui-theme.ts';

// ─── detectColorTier ────────────────────────────────────────────

describe('detectColorTier', () => {
  it('returns a string', () => {
    const tier = detectColorTier();
    assert.equal(typeof tier, 'string');
    assert.ok(['truecolor', '256', '16', 'none'].includes(tier));
  });
});

// ─── detectUnicode ──────────────────────────────────────────────

describe('detectUnicode', () => {
  it('returns a boolean', () => {
    assert.equal(typeof detectUnicode(), 'boolean');
  });
});

// ─── TOKENS ─────────────────────────────────────────────────────

describe('TOKENS', () => {
  it('has all required design tokens from Visual Language Spec', () => {
    const required = [
      'bg.base',
      'bg.panel',
      'fg.primary',
      'fg.secondary',
      'fg.muted',
      'fg.dim',
      'border.default',
      'border.hover',
      'accent.primary',
      'accent.secondary',
      'accent.link',
      'state.success',
      'state.warn',
      'state.error',
    ];
    for (const token of required) {
      assert.ok(TOKENS[token], `Missing token: ${token}`);
      assert.match(TOKENS[token], /^#[0-9a-f]{6}$/i, `Token ${token} should be hex color`);
    }
  });

  it('bg.base matches Push web token push-surface', () => {
    assert.equal(TOKENS['bg.base'], '#070a10');
  });

  it('fg.primary matches Push web token push-fg', () => {
    assert.equal(TOKENS['fg.primary'], '#f5f7ff');
  });

  it('accent.primary matches Push web token push-accent', () => {
    assert.equal(TOKENS['accent.primary'], '#0070f3');
  });
});

// ─── GLYPHS ─────────────────────────────────────────────────────

describe('GLYPHS', () => {
  it('unicode set has box drawing characters', () => {
    assert.equal(GLYPHS_UNICODE.topLeft, '┌');
    assert.equal(GLYPHS_UNICODE.topRight, '┐');
    assert.equal(GLYPHS_UNICODE.bottomLeft, '└');
    assert.equal(GLYPHS_UNICODE.bottomRight, '┘');
    assert.equal(GLYPHS_UNICODE.horizontal, '─');
    assert.equal(GLYPHS_UNICODE.vertical, '│');
    assert.equal(GLYPHS_UNICODE.prompt, '›');
    assert.equal(GLYPHS_UNICODE.statusDot, '●');
  });

  it('ASCII set has fallback characters', () => {
    assert.equal(GLYPHS_ASCII.topLeft, '+');
    assert.equal(GLYPHS_ASCII.horizontal, '-');
    assert.equal(GLYPHS_ASCII.vertical, '|');
    assert.equal(GLYPHS_ASCII.prompt, '>');
    assert.equal(GLYPHS_ASCII.statusDot, '*');
  });

  it('both sets have the same keys', () => {
    const uniKeys = Object.keys(GLYPHS_UNICODE).sort();
    const asciiKeys = Object.keys(GLYPHS_ASCII).sort();
    assert.deepEqual(uniKeys, asciiKeys);
  });
});

// ─── createTheme ────────────────────────────────────────────────

describe('createTheme', () => {
  it('creates theme with detected defaults', () => {
    const theme = createTheme();
    assert.ok(theme.tier);
    assert.equal(typeof theme.unicode, 'boolean');
    assert.ok(theme.glyphs);
    assert.equal(typeof theme.fg, 'function');
    assert.equal(typeof theme.bg, 'function');
    assert.equal(typeof theme.style, 'function');
    assert.equal(typeof theme.bold, 'function');
    assert.equal(typeof theme.dim, 'function');
  });

  it('respects tier override', () => {
    const theme = createTheme({ tier: 'none' });
    assert.equal(theme.tier, 'none');
  });

  it('respects unicode override', () => {
    const theme = createTheme({ unicode: false });
    assert.equal(theme.unicode, false);
    assert.equal(theme.glyphs.prompt, '>');
  });

  it('style returns plain text when tier=none', () => {
    const theme = createTheme({ tier: 'none' });
    assert.equal(theme.style('fg.primary', 'hello'), 'hello');
    assert.equal(theme.styleBg('bg.base', 'test'), 'test');
  });

  it('style wraps text with ANSI when tier=truecolor', () => {
    const theme = createTheme({ tier: 'truecolor' });
    const styled = theme.style('fg.primary', 'hello');
    assert.ok(styled.includes('\x1b[38;2;'));
    assert.ok(styled.includes('hello'));
    assert.ok(styled.includes('\x1b[0m'));
  });

  it('fg returns truecolor escape for known token', () => {
    // Pin the theme explicitly — this test is about the truecolor
    // escape mechanism, not the runtime default theme.
    const theme = createTheme({ tier: 'truecolor', name: 'default' });
    const esc = theme.fg('state.error');
    // default state.error = #ef4444 → rgb(239, 68, 68)
    assert.ok(esc.includes('239'));
    assert.ok(esc.includes('68'));
  });

  it('fg returns empty string for unknown token', () => {
    const theme = createTheme({ tier: 'truecolor' });
    assert.equal(theme.fg('nonexistent.token'), '');
  });

  it('bold/dim work correctly', () => {
    const theme = createTheme({ tier: 'truecolor' });
    assert.ok(theme.bold('x').includes('\x1b[1m'));
    assert.ok(theme.dim('x').includes('\x1b[2m'));
  });

  it('bold/dim are no-op when tier=none', () => {
    const theme = createTheme({ tier: 'none' });
    assert.equal(theme.bold('x'), 'x');
    assert.equal(theme.dim('x'), 'x');
  });

  it('RESET constant is \\x1b[0m', () => {
    const theme = createTheme();
    assert.equal(theme.RESET, '\x1b[0m');
  });

  it('16-color tier uses ANSI codes', () => {
    const theme = createTheme({ tier: '16' });
    const esc = theme.fg('fg.primary');
    assert.ok(esc.includes('\x1b['));
    // bright white = \x1b[97m
    assert.equal(esc, '\x1b[97m');
  });

  it('styleFgBg combines fg and bg', () => {
    const theme = createTheme({ tier: 'truecolor' });
    const result = theme.styleFgBg('fg.primary', 'bg.panel', 'test');
    assert.ok(result.includes('\x1b[38;2;'));
    assert.ok(result.includes('\x1b[48;2;'));
    assert.ok(result.includes('test'));
  });

  it('defaults theme name to "mono"', () => {
    const prev = process.env.PUSH_THEME;
    delete process.env.PUSH_THEME;
    try {
      const theme = createTheme();
      assert.equal(theme.name, 'mono');
    } finally {
      if (prev !== undefined) process.env.PUSH_THEME = prev;
    }
  });

  it('respects name override', () => {
    const theme = createTheme({ name: 'neon', tier: 'truecolor' });
    assert.equal(theme.name, 'neon');
    // neon accent.primary = #ff2bd6 → rgb(255, 43, 214)
    const esc = theme.fg('accent.primary');
    assert.ok(esc.includes('255'));
    assert.ok(esc.includes('43'));
    assert.ok(esc.includes('214'));
  });

  it('falls back to mono for unknown theme name', () => {
    const prev = process.env.PUSH_THEME;
    delete process.env.PUSH_THEME;
    try {
      const theme = createTheme({ name: 'not-a-real-theme', tier: 'truecolor' });
      assert.equal(theme.name, 'mono');
    } finally {
      if (prev !== undefined) process.env.PUSH_THEME = prev;
    }
  });

  it('theme variants produce different escapes for accent.primary', () => {
    const seen = new Set();
    for (const name of THEME_NAMES) {
      const theme = createTheme({ name, tier: 'truecolor' });
      seen.add(theme.fg('accent.primary'));
    }
    // All 6 variants should produce distinct accent.primary colors
    assert.equal(seen.size, THEME_NAMES.length);
  });
});

// ─── THEME_NAMES / VARIANTS ─────────────────────────────────────

describe('theme variants', () => {
  it('THEME_NAMES includes expected set', () => {
    assert.deepEqual([...THEME_NAMES].sort(), [
      'default',
      'forest',
      'metallic',
      'mono',
      'neon',
      'solarized',
    ]);
  });

  it('every variant has a full token palette with valid hex values', () => {
    const required = Object.keys(TOKENS);
    for (const name of THEME_NAMES) {
      const variant = VARIANTS[name];
      assert.ok(variant, `Missing variant: ${name}`);
      assert.ok(typeof variant.label === 'string' && variant.label.length > 0);
      assert.ok(typeof variant.description === 'string' && variant.description.length > 0);
      for (const token of required) {
        assert.match(
          variant.tokens[token],
          /^#[0-9a-f]{6}$/i,
          `${name}.${token} must be a hex color`,
        );
      }
    }
  });

  it('every variant has an ANSI fallback entry for each token', () => {
    const required = Object.keys(TOKENS);
    for (const name of THEME_NAMES) {
      const variant = VARIANTS[name];
      for (const token of required) {
        assert.ok(variant.ansiFallback[token], `${name} missing ANSI fallback for ${token}`);
      }
    }
  });

  it('every variant has a valid defaultAnimation', () => {
    const allowed = new Set(['off', 'pulse', 'shimmer', 'rainbow']);
    for (const name of THEME_NAMES) {
      const effect = VARIANTS[name].defaultAnimation;
      assert.ok(
        allowed.has(effect),
        `${name}.defaultAnimation must be one of ${[...allowed].join(', ')}, got ${effect}`,
      );
    }
  });
});

// ─── detectThemeName / isThemeName ──────────────────────────────

describe('isThemeName', () => {
  it('accepts every registered theme name', () => {
    for (const name of THEME_NAMES) {
      assert.equal(isThemeName(name), true);
    }
  });
  it('rejects unknown strings and non-strings', () => {
    assert.equal(isThemeName('mystery'), false);
    assert.equal(isThemeName(''), false);
    assert.equal(isThemeName(42), false);
    assert.equal(isThemeName(null), false);
    assert.equal(isThemeName(undefined), false);
  });
  it('rejects Object.prototype keys (does not use `in`)', () => {
    for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
      assert.equal(isThemeName(key), false, `must reject prototype key: ${key}`);
    }
  });
});

describe('detectThemeName', () => {
  it('returns "mono" when PUSH_THEME unset', () => {
    const prev = process.env.PUSH_THEME;
    delete process.env.PUSH_THEME;
    try {
      assert.equal(detectThemeName(), 'mono');
    } finally {
      if (prev !== undefined) process.env.PUSH_THEME = prev;
    }
  });

  it('returns the requested theme when PUSH_THEME is set', () => {
    const prev = process.env.PUSH_THEME;
    process.env.PUSH_THEME = 'forest';
    try {
      assert.equal(detectThemeName(), 'forest');
    } finally {
      if (prev === undefined) delete process.env.PUSH_THEME;
      else process.env.PUSH_THEME = prev;
    }
  });

  it('ignores PUSH_THEME when value is unknown', () => {
    const prev = process.env.PUSH_THEME;
    process.env.PUSH_THEME = 'not-a-real-theme';
    try {
      assert.equal(detectThemeName(), 'mono');
    } finally {
      if (prev === undefined) delete process.env.PUSH_THEME;
      else process.env.PUSH_THEME = prev;
    }
  });

  it('is case-insensitive and tolerates whitespace', () => {
    const prev = process.env.PUSH_THEME;
    process.env.PUSH_THEME = '  NEON  ';
    try {
      assert.equal(detectThemeName(), 'neon');
    } finally {
      if (prev === undefined) delete process.env.PUSH_THEME;
      else process.env.PUSH_THEME = prev;
    }
  });
});

// ─── renderThemePreview ─────────────────────────────────────────

describe('renderThemePreview', () => {
  it('includes the variant label, description, and all token hex values', () => {
    const preview = renderThemePreview('neon', { tier: 'none', unicode: true });
    const variant = VARIANTS.neon;
    assert.ok(preview.includes(variant.label));
    assert.ok(preview.includes(variant.description));
    for (const hex of Object.values(variant.tokens)) {
      assert.ok(preview.includes(hex), `preview missing hex ${hex}`);
    }
    for (const token of Object.keys(TOKENS)) {
      assert.ok(preview.includes(token), `preview missing token label ${token}`);
    }
  });

  it('falls back to default for unknown theme names', () => {
    const preview = renderThemePreview('not-a-real-theme', { tier: 'none' });
    assert.ok(preview.includes(VARIANTS.default.label));
  });

  it('emits ANSI escapes when tier=truecolor', () => {
    const preview = renderThemePreview('forest', { tier: 'truecolor', unicode: true });
    assert.ok(preview.includes('\x1b[38;2;'));
    assert.ok(preview.includes('\x1b[48;2;'));
  });

  it('emits no ANSI escapes when tier=none', () => {
    const preview = renderThemePreview('mono', { tier: 'none', unicode: true });
    assert.equal(preview.includes('\x1b['), false);
  });

  it('uses ASCII glyphs when unicode=false', () => {
    const preview = renderThemePreview('default', { tier: 'none', unicode: false });
    // ASCII swatch uses `#` characters, unicode uses block glyphs
    assert.ok(preview.includes('######'));
    assert.equal(preview.includes('██████'), false);
  });
});
