import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  animateText,
  ANIMATION_DESCRIPTIONS,
  ANIMATION_EFFECTS,
  effectColor,
  hslToRgb,
  isAnimationEffect,
} from '../tui-animator.ts';

// ─── hslToRgb ───────────────────────────────────────────────────

describe('hslToRgb', () => {
  it('pure red at hue=0, s=1, l=0.5', () => {
    assert.deepEqual(hslToRgb(0, 1, 0.5), [255, 0, 0]);
  });
  it('pure green at hue=120', () => {
    assert.deepEqual(hslToRgb(120, 1, 0.5), [0, 255, 0]);
  });
  it('pure blue at hue=240', () => {
    assert.deepEqual(hslToRgb(240, 1, 0.5), [0, 0, 255]);
  });
  it('grayscale when saturation=0', () => {
    const [r, g, b] = hslToRgb(180, 0, 0.5);
    assert.equal(r, g);
    assert.equal(g, b);
  });
  it('clamps channels to [0, 255]', () => {
    for (let h = 0; h < 360; h += 30) {
      const [r, g, b] = hslToRgb(h, 1, 0.6);
      for (const c of [r, g, b]) {
        assert.ok(c >= 0 && c <= 255, `channel ${c} out of range at h=${h}`);
      }
    }
  });
});

// ─── isAnimationEffect ──────────────────────────────────────────

describe('isAnimationEffect', () => {
  it('accepts every registered effect', () => {
    for (const name of ANIMATION_EFFECTS) {
      assert.equal(isAnimationEffect(name), true);
    }
  });
  it('rejects unknown strings and non-strings', () => {
    assert.equal(isAnimationEffect('sparkle'), false);
    assert.equal(isAnimationEffect(''), false);
    assert.equal(isAnimationEffect(42), false);
    assert.equal(isAnimationEffect(undefined), false);
  });
});

// ─── effectColor ────────────────────────────────────────────────

describe('effectColor', () => {
  it('returns a 3-channel RGB tuple for every effect', () => {
    for (const effect of ANIMATION_EFFECTS) {
      const color = effectColor(effect, 0, 0);
      assert.equal(color.length, 3);
      for (const c of color) {
        assert.ok(c >= 0 && c <= 255);
      }
    }
  });

  it('pulse depends on tick only (all positions share a color at a given tick)', () => {
    const atTickZero = [effectColor('pulse', 0, 0), effectColor('pulse', 0, 10)];
    assert.deepEqual(atTickZero[0], atTickZero[1]);
    const atTickFive = effectColor('pulse', 5, 0);
    assert.notDeepEqual(atTickZero[0], atTickFive);
  });

  it('shimmer depends on both tick and position', () => {
    const a = effectColor('shimmer', 0, 0);
    const b = effectColor('shimmer', 0, 5);
    assert.notDeepEqual(a, b);
  });

  it('rainbow hue advances with tick', () => {
    const a = effectColor('rainbow', 0, 0);
    const b = effectColor('rainbow', 15, 0);
    assert.notDeepEqual(a, b);
  });
});

// ─── animateText ────────────────────────────────────────────────

describe('animateText', () => {
  it('passes text through unchanged when effect=off', () => {
    assert.equal(animateText('Push', 'off', 0, 'truecolor'), 'Push');
  });

  it('passes text through unchanged when tier=none', () => {
    assert.equal(animateText('Push', 'pulse', 5, 'none'), 'Push');
  });

  it('emits truecolor escapes for every non-whitespace char at tier=truecolor', () => {
    const out = animateText('Push', 'rainbow', 3, 'truecolor');
    assert.ok(out.includes('\x1b[38;2;'));
    assert.ok(out.includes('\x1b[0m'));
    // 4 non-whitespace chars → 4 escape sequences
    const escapeCount = (out.match(/\x1b\[38;2;/g) || []).length;
    assert.equal(escapeCount, 4);
  });

  it('emits 256-color escapes at tier=256', () => {
    const out = animateText('Push', 'rainbow', 3, '256');
    assert.ok(out.includes('\x1b[38;5;'));
  });

  it('does not color whitespace characters', () => {
    const out = animateText('a b', 'rainbow', 0, 'truecolor');
    // Only two colored runs around the space
    const escapeCount = (out.match(/\x1b\[38;2;/g) || []).length;
    assert.equal(escapeCount, 2);
  });

  it('produces stable output for the same inputs (pure function)', () => {
    const a = animateText('Push', 'pulse', 7, 'truecolor');
    const b = animateText('Push', 'pulse', 7, 'truecolor');
    assert.equal(a, b);
  });

  it('returns empty string for empty input', () => {
    assert.equal(animateText('', 'rainbow', 0, 'truecolor'), '');
  });
});

// ─── registry ───────────────────────────────────────────────────

describe('ANIMATION_EFFECTS registry', () => {
  it('contains the prototype effects', () => {
    assert.deepEqual([...ANIMATION_EFFECTS].sort(), ['off', 'pulse', 'rainbow', 'shimmer']);
  });

  it('has a description for every effect', () => {
    for (const name of ANIMATION_EFFECTS) {
      const desc = ANIMATION_DESCRIPTIONS[name];
      assert.ok(typeof desc === 'string' && desc.length > 0);
    }
  });
});
