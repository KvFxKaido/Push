import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTheme, detectColorTier, detectUnicode,
  TOKENS, GLYPHS_UNICODE, GLYPHS_ASCII,
} from '../tui-theme.mjs';

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
      'bg.base', 'bg.panel',
      'fg.primary', 'fg.secondary', 'fg.muted', 'fg.dim',
      'border.default', 'border.hover',
      'accent.primary', 'accent.secondary', 'accent.link',
      'state.success', 'state.warn', 'state.error',
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
    const theme = createTheme({ tier: 'truecolor' });
    const esc = theme.fg('state.error');
    // #ef4444 -> rgb(239, 68, 68)
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
});
