import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEX_GLINT_MS,
  VERB_SHIMMER_MS,
  shimmerCell,
  shimmerColorsFor,
  shimmerEligible,
  shimmerIntensity,
  shimmerText,
} from '../tui-shimmer.ts';

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

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const TRUECOLOR = {
  tier: 'truecolor',
  base: [100, 100, 100],
  highlight: [255, 255, 255],
  ansiBaseFg: '\x1b[37m',
};

describe('shimmerIntensity — band shape', () => {
  it('peaks in the middle of the label at mid-sweep, ~0 at the ends', () => {
    const mid = shimmerIntensity(4, 8, 0.5);
    assert.ok(mid > shimmerIntensity(0, 8, 0.5), 'center brighter than left edge');
    assert.ok(mid > shimmerIntensity(7, 8, 0.5), 'center brighter than right edge');
  });

  it('is a normalized triangle: intensity always within [0,1]', () => {
    for (let p = 0; p < 1; p += 0.05) {
      for (let i = 0; i < 12; i++) {
        const t = shimmerIntensity(i, 12, p);
        assert.ok(t >= 0 && t <= 1, `t=${t} out of range at i=${i} p=${p}`);
      }
    }
  });

  it('band sits off the left edge at progress 0 (smooth entry, no pop)', () => {
    // Every character is at or beyond the band half-width → no highlight yet.
    for (let i = 0; i < 8; i++) {
      assert.equal(shimmerIntensity(i, 8, 0), 0);
    }
  });

  it('band is proportional: a longer label has a wider lit region', () => {
    const litCount = (len) => {
      let n = 0;
      for (let i = 0; i < len; i++) if (shimmerIntensity(i, len, 0.5) > 0) n++;
      return n;
    };
    assert.ok(litCount(24) > litCount(6), 'longer label lights more cells at once');
  });

  it('degenerate lengths never throw or produce NaN', () => {
    assert.equal(shimmerIntensity(0, 0, 0.5), 0);
    assert.ok(Number.isFinite(shimmerIntensity(0, 1, 0.5)));
  });
});

describe('shimmerText — width invariance & escapes', () => {
  it('never changes the visible text (color only, zero reflow)', () => {
    for (const p of [0, 0.25, 0.5, 0.75]) {
      const out = shimmerText('thinking', p * VERB_SHIMMER_MS, TRUECOLOR);
      assert.equal(stripAnsi(out), 'thinking');
    }
  });

  it('emits truecolor (38;2) per-character escapes and always resets', () => {
    const out = shimmerText('hi', 0, TRUECOLOR);
    assert.match(out, /\x1b\[38;2;\d+;\d+;\d+m/);
    assert.ok(out.endsWith('\x1b[0m'), 'ends reset so styling never leaks');
  });

  it('256-color tier snaps to a palette index (38;5)', () => {
    const out = shimmerText('hi', 500, { ...TRUECOLOR, tier: '256' });
    assert.match(out, /\x1b\[38;5;\d+m/);
    assert.doesNotMatch(out, /38;2;/);
  });

  it('16-color tier degrades to DIM/BOLD modifiers on the base color', () => {
    // Sweep a long label so some cells are trough (dim) and one is peak (bold).
    const out = shimmerText('reticulating', VERB_SHIMMER_MS * 0.5, {
      ...TRUECOLOR,
      tier: '16',
    });
    assert.ok(out.includes('\x1b[2m'), 'has a dim (trough) cell');
    assert.ok(out.includes('\x1b[1m'), 'has a bold (peak) cell');
    assert.doesNotMatch(out, /38;2;|38;5;/, 'no RGB escapes at 16-color');
  });

  it('tier "none" returns the raw string, and empty input returns empty', () => {
    assert.equal(shimmerText('working', 123, { ...TRUECOLOR, tier: 'none' }), 'working');
    assert.equal(shimmerText('', 0, TRUECOLOR), '');
  });

  it('is deterministic and phase-continuous (wraps on the period)', () => {
    const a = shimmerText('musing', 400, TRUECOLOR);
    assert.equal(a, shimmerText('musing', 400, TRUECOLOR), 'same inputs → same output');
    assert.equal(
      shimmerText('musing', 400, TRUECOLOR),
      shimmerText('musing', 400 + VERB_SHIMMER_MS, TRUECOLOR),
      'one full period later is identical',
    );
  });
});

describe('shimmerCell — hexagon glint (breathe)', () => {
  it('troughs at p=0 and peaks at p=0.5 (raised-cosine breathe)', () => {
    const trough = shimmerCell('X', 0, TRUECOLOR); // base end
    const peak = shimmerCell('X', HEX_GLINT_MS * 0.5, TRUECOLOR); // highlight end
    assert.equal(stripAnsi(trough), 'X');
    assert.equal(stripAnsi(peak), 'X');
    // At the trough we're at the base color; at the peak we're at the highlight.
    assert.match(trough, /\x1b\[38;2;100;100;100m/);
    assert.match(peak, /\x1b\[38;2;255;255;255m/);
  });

  it('tier "none" returns the bare glyph', () => {
    assert.equal(shimmerCell('⬡', 800, { ...TRUECOLOR, tier: 'none' }), '⬡');
  });

  it('uses the slower hex period, distinct from the verb period', () => {
    assert.equal(HEX_GLINT_MS, 1600);
    assert.equal(VERB_SHIMMER_MS, 2400);
    assert.notEqual(HEX_GLINT_MS, VERB_SHIMMER_MS);
  });
});

describe('shimmerColorsFor — theme resolution', () => {
  it('resolves highlight brighter than base (a lift, not a tint)', () => {
    const c = shimmerColorsFor({ tier: 'truecolor', name: 'default' });
    const sum = (rgb) => rgb[0] + rgb[1] + rgb[2];
    assert.ok(sum(c.highlight) > sum(c.base), 'fg.primary brighter than fg.secondary');
  });

  it('falls back to the default variant for an unknown theme name', () => {
    const c = shimmerColorsFor({ tier: '256', name: 'nonesuch' });
    assert.equal(c.tier, '256');
    assert.equal(c.base.length, 3);
    assert.ok(c.ansiBaseFg.startsWith('\x1b['));
  });

  it('carries the theme tier through unchanged', () => {
    assert.equal(shimmerColorsFor({ tier: '16', name: 'mono' }).tier, '16');
  });
});

describe('shimmerEligible — scope rule', () => {
  it('shimmers mood (null), thinking, and streaming verbs', () => {
    assert.equal(shimmerEligible(null, 'truecolor'), true);
    assert.equal(shimmerEligible({ kind: 'thinking' }, 'truecolor'), true);
    assert.equal(shimmerEligible({ kind: 'streaming' }, 'truecolor'), true);
  });

  it('does NOT shimmer tool "phase" verbs', () => {
    assert.equal(shimmerEligible({ kind: 'tool', toolName: 'edit_file' }, 'truecolor'), false);
  });

  it('is off on a colorless terminal', () => {
    assert.equal(shimmerEligible(null, 'none'), false);
  });

  it('honors reduced-motion regardless of activity', () => {
    withEnv({ PUSH_REDUCED_MOTION: '1' }, () => {
      assert.equal(shimmerEligible(null, 'truecolor'), false);
      assert.equal(shimmerEligible({ kind: 'thinking' }, 'truecolor'), false);
    });
    withEnv({ PUSH_REDUCED_MOTION: '0', REDUCED_MOTION: undefined }, () => {
      assert.equal(shimmerEligible(null, 'truecolor'), true);
    });
  });
});
