import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  animateText,
  ANIMATION_DESCRIPTIONS,
  ANIMATION_EFFECTS,
  detectAnimationEffect,
  effectColor,
  hslToRgb,
  isAnimationEffect,
  isReducedMotion,
  TICK_MODULUS,
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
    // Uses fg-only reset (\x1b[39m), not full SGR reset, so outer
    // bold/background/underline styling around an animated span survives.
    assert.ok(out.includes('\x1b[39m'));
    assert.equal(out.includes('\x1b[0m'), false, 'must not emit full SGR reset');
    // 4 non-whitespace chars → 4 escape sequences
    const escapeCount = (out.match(/\x1b\[38;2;/g) || []).length;
    assert.equal(escapeCount, 4);
  });

  it('never emits a full SGR reset (\\x1b[0m), to preserve outer styling', () => {
    for (const effect of ['pulse', 'shimmer', 'rainbow']) {
      for (const tier of ['truecolor', '256', '16']) {
        const out = animateText('Push', effect, 7, tier);
        assert.equal(out.includes('\x1b[0m'), false, `${effect}@${tier} leaked a full SGR reset`);
      }
    }
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

// ─── TICK_MODULUS ───────────────────────────────────────────────

describe('TICK_MODULUS', () => {
  it('is a positive integer', () => {
    assert.ok(Number.isInteger(TICK_MODULUS) && TICK_MODULUS > 0);
  });

  it('wraps cleanly for every effect (phase returns to 0 at wraparound)', () => {
    // The first frame after wrap must match the zero-tick frame for every
    // effect, otherwise long-running sessions would see a visible jump.
    for (const effect of ['pulse', 'shimmer', 'rainbow']) {
      const atZero = effectColor(effect, 0, 3);
      const atWrap = effectColor(effect, TICK_MODULUS, 3);
      assert.deepEqual(
        atZero,
        atWrap,
        `${effect} is not continuous across TICK_MODULUS wraparound`,
      );
    }
  });
});

// ─── isReducedMotion / detectAnimationEffect ───────────────────

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('isReducedMotion', () => {
  it('returns false when neither env var is set', () => {
    withEnv({ PUSH_REDUCED_MOTION: undefined, REDUCED_MOTION: undefined }, () => {
      assert.equal(isReducedMotion(), false);
    });
  });

  it('returns true when PUSH_REDUCED_MOTION is truthy', () => {
    withEnv({ PUSH_REDUCED_MOTION: '1', REDUCED_MOTION: undefined }, () => {
      assert.equal(isReducedMotion(), true);
    });
  });

  it('returns true when REDUCED_MOTION is truthy (standard convention)', () => {
    withEnv({ PUSH_REDUCED_MOTION: undefined, REDUCED_MOTION: 'true' }, () => {
      assert.equal(isReducedMotion(), true);
    });
  });

  it('treats "0", "false", "no", and empty as falsy', () => {
    for (const falsy of ['0', 'false', 'no', '', '  ']) {
      withEnv({ PUSH_REDUCED_MOTION: falsy, REDUCED_MOTION: undefined }, () => {
        assert.equal(isReducedMotion(), false, `expected "${falsy}" to be falsy`);
      });
    }
  });
});

describe('detectAnimationEffect', () => {
  it('returns null when PUSH_ANIMATION unset (and not reduced-motion)', () => {
    withEnv(
      { PUSH_ANIMATION: undefined, PUSH_REDUCED_MOTION: undefined, REDUCED_MOTION: undefined },
      () => {
        assert.equal(detectAnimationEffect(), null);
      },
    );
  });

  it('returns the named effect from PUSH_ANIMATION', () => {
    withEnv(
      { PUSH_ANIMATION: 'pulse', PUSH_REDUCED_MOTION: undefined, REDUCED_MOTION: undefined },
      () => {
        assert.equal(detectAnimationEffect(), 'pulse');
      },
    );
  });

  it('is case-insensitive and tolerates whitespace', () => {
    withEnv(
      {
        PUSH_ANIMATION: '  RAINBOW  ',
        PUSH_REDUCED_MOTION: undefined,
        REDUCED_MOTION: undefined,
      },
      () => {
        assert.equal(detectAnimationEffect(), 'rainbow');
      },
    );
  });

  it('returns null when PUSH_ANIMATION is not a known effect', () => {
    withEnv(
      { PUSH_ANIMATION: 'sparkle', PUSH_REDUCED_MOTION: undefined, REDUCED_MOTION: undefined },
      () => {
        assert.equal(detectAnimationEffect(), null);
      },
    );
  });

  it('reduced-motion forces "off" regardless of PUSH_ANIMATION', () => {
    withEnv(
      { PUSH_ANIMATION: 'rainbow', PUSH_REDUCED_MOTION: '1', REDUCED_MOTION: undefined },
      () => {
        assert.equal(detectAnimationEffect(), 'off');
      },
    );
  });
});
