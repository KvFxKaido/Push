/**
 * Visual Language v2 pure helpers — glyphs, color budget, motion, frame copy.
 * Source: docs/cli/design/TUI Visual Language v2.md
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultDarkTheme, resolveThemeColor } from 'silvery';

import { createPushSilveryTokens } from '../silvery/theme.tsx';

import {
  GLYPHS_ASCII,
  GLYPHS_UNICODE,
  MOTION_TICKS,
  VL_COLOR,
  accentHexForTheme,
  breathingHex,
  countUserTurns,
  createModalMotionState,
  densityMeter,
  diffLineColor,
  faultCopy,
  footerKeybinds,
  formatTurnTimestamp,
  headerSegments,
  modeLabel,
  modalFadeAmount,
  reduceModalMotion,
  resolveGlyphs,
  shortenPath,
  streamMark,
} from '../silvery/visual-language.ts';

describe('visual language v2 glyphs', () => {
  it('ships hollow/filled hexagons with ASCII fallbacks (law 4)', () => {
    assert.equal(GLYPHS_UNICODE.hexIdle, '⬡');
    assert.equal(GLYPHS_UNICODE.hexActive, '⬢');
    assert.equal(GLYPHS_ASCII.hexIdle, 'o');
    assert.equal(GLYPHS_ASCII.hexActive, '*');
    assert.equal(resolveGlyphs(true).hexIdle, '⬡');
    assert.equal(resolveGlyphs(false).hexActive, '*');
  });

  it('keeps diamonds on the activity spine with ASCII fallbacks (law 5)', () => {
    assert.equal(GLYPHS_UNICODE.diamondFilled, '◆');
    assert.equal(GLYPHS_UNICODE.diamondHollow, '◇');
    assert.equal(GLYPHS_ASCII.diamondFilled, '+');
    assert.equal(GLYPHS_ASCII.diamondHollow, '-');
  });
});

describe('visual language v2 color budget', () => {
  it('exposes only accent + fault + grayscale tokens (laws 2–3)', () => {
    assert.deepEqual(Object.keys(VL_COLOR).sort(), ['accent', 'fault', 'muted', 'primary']);
    assert.equal(VL_COLOR.accent, '$fg-accent');
    assert.equal(VL_COLOR.fault, '$fg-error');
  });

  it('styles diffs without success green or del red (law 2)', () => {
    assert.equal(diffLineColor('add'), VL_COLOR.primary);
    assert.equal(diffLineColor('del'), VL_COLOR.muted);
    assert.equal(diffLineColor('ctx'), VL_COLOR.muted);
  });

  it('puts diamonds on tools and hexes only on independent voices (law 5)', () => {
    const g = GLYPHS_UNICODE;
    assert.equal(streamMark('tool_pending', g).glyph, '◆');
    assert.equal(streamMark('tool_pending', g).color, VL_COLOR.accent);
    assert.equal(streamMark('tool_ok', g).color, VL_COLOR.muted);
    assert.equal(streamMark('tool_error', g).color, VL_COLOR.fault);
    assert.equal(streamMark('reviewer', g).glyph, '⬢');
    assert.equal(streamMark('auditor', g).glyph, '⬢');
    // Reviewer/Auditor get bold attribution, not a second accent hue.
    assert.equal(streamMark('reviewer', g).color, undefined);
    assert.equal(streamMark('reviewer', g).bold, true);
  });

  it('marks the human turn with the caret, never a Push glyph (law 5, #1438)', () => {
    // The hexagon is Push's face; the user is the one voice that is not Push.
    assert.equal(GLYPHS_UNICODE.human, '›');
    assert.equal(GLYPHS_ASCII.human, '>');
    const g = GLYPHS_UNICODE;
    const user = streamMark('user', g);
    assert.equal(user.glyph, '›');
    assert.notEqual(user.glyph, g.hexActive); // not Push's face
    assert.notEqual(user.glyph, g.diamondFilled); // not Push's activity spine
    assert.notEqual(user.glyph, g.diamondHollow);
    assert.equal(user.color, VL_COLOR.accent);
    assert.equal(streamMark('user', GLYPHS_ASCII).glyph, '>');
  });
});

describe('visual language v2 motion', () => {
  it('maps web motion axes into tick counts (law 9)', () => {
    assert.equal(MOTION_TICKS.modalFade, 3);
    assert.ok(MOTION_TICKS.breathePeriod >= 4);
    assert.ok(MOTION_TICKS.clockMs > 0);
  });

  it('breathes on the shared clock while working; freezes under reduced motion (laws 8, 10)', () => {
    const g = GLYPHS_UNICODE;
    const idle = breathingHex(0, 'idle', g, false);
    assert.equal(idle.glyph, '⬡');
    assert.equal(idle.bright, false);

    const reduced = breathingHex(3, 'working', g, true);
    assert.equal(reduced.glyph, '⬢');
    assert.equal(reduced.bright, true);

    const a = breathingHex(0, 'working', g, false);
    const b = breathingHex(MOTION_TICKS.breathePeriod / 2, 'working', g, false);
    // Opposite halves of the cycle must disagree on fill (phase-locked breathe).
    assert.notEqual(a.glyph === '⬢', b.glyph === '⬢');
  });

  it('attention is a single filled pulse, not a loop vocabulary (law 8)', () => {
    const pulse = breathingHex(99, 'attention', GLYPHS_UNICODE, false);
    assert.equal(pulse.glyph, '⬢');
    assert.equal(pulse.bright, true);
  });

  it('ramps modal backdrop fades over the shared three-tick window (law 9)', () => {
    const target = 0.3;
    let motion = createModalMotionState(false, 0, target, false);
    motion = reduceModalMotion(motion, true, 0, target, false);
    assert.equal(motion.phase, 'entering');
    assert.equal(modalFadeAmount(motion, 0, target), 0);
    assert.ok(Math.abs(modalFadeAmount(motion, 1, target) - 0.1) < 1e-12);
    assert.ok(Math.abs(modalFadeAmount(motion, 2, target) - 0.2) < 1e-12);
    motion = reduceModalMotion(motion, true, MOTION_TICKS.modalFade, target, false);
    assert.equal(motion.phase, 'open');
    assert.equal(modalFadeAmount(motion, MOTION_TICKS.modalFade, target), target);

    motion = reduceModalMotion(motion, false, 3, target, false);
    assert.equal(motion.phase, 'exiting');
    assert.ok(Math.abs(modalFadeAmount(motion, 4, target) - 0.2) < 1e-12);
    motion = reduceModalMotion(motion, false, 6, target, false);
    assert.equal(motion.phase, 'closed');
    assert.equal(modalFadeAmount(motion, 6, target), 0);
  });

  it('preserves fade continuity when a modal reverses and skips ramps under reduced motion', () => {
    const target = 0.3;
    let motion = createModalMotionState(false, 0, target, false);
    motion = reduceModalMotion(motion, true, 0, target, false);
    motion = reduceModalMotion(motion, false, 1, target, false);
    const beforeReverse = modalFadeAmount(motion, 2, target);
    motion = reduceModalMotion(motion, true, 2, target, false);
    assert.equal(modalFadeAmount(motion, 2, target), beforeReverse);

    motion = reduceModalMotion(motion, true, 9, target, true);
    assert.equal(motion.phase, 'open');
    assert.equal(modalFadeAmount(motion, 9, target), target);
    motion = reduceModalMotion(motion, false, 9, target, true);
    assert.equal(motion.phase, 'closed');
  });
});

describe('visual language v2 frame helpers', () => {
  it('builds a fact-only header strip (law 1)', () => {
    const segs = headerSegments({
      brandMark: '⬢',
      branch: 'main',
      path: '~/proj',
      context: '12k',
      turn: 'turn 3',
    });
    assert.deepEqual(segs, ['⬢', 'main', '~/proj', '12k', 'turn 3']);
  });

  it('formats turn timestamps compactly and tolerates missing legacy timestamps', () => {
    const at = new Date(2026, 6, 12, 15, 7).getTime();
    assert.equal(formatTurnTimestamp(at, 'en-US'), '3:07 PM');
    assert.equal(formatTurnTimestamp(undefined, 'en-US'), '');
  });

  it('switches footer keybinds by focus scope (law 1)', () => {
    assert.match(footerKeybinds('composer'), /ctrl\+k/i);
    assert.doesNotMatch(footerKeybinds('composer'), /\? help/i);
    assert.match(footerKeybinds('approval'), /approve/i);
    assert.match(footerKeybinds('palette'), /esc/i);
    assert.match(footerKeybinds('picker'), /select/i);
    assert.match(footerKeybinds('running'), /cancel/i);
  });

  it('maps exec modes onto operational labels', () => {
    assert.equal(modeLabel('yolo'), 'always-approve');
    assert.equal(modeLabel('strict'), 'strict');
    assert.equal(modeLabel('auto'), 'auto');
    assert.equal(modeLabel(undefined), 'auto');
  });

  it('shortens paths and counts user turns', () => {
    const home = process.env.HOME || '/home/user';
    assert.equal(shortenPath(`${home}/projects/Push`, 80).startsWith('~'), true);
    assert.equal(
      shortenPath('/very/long/path/that/should/be/truncated/for/display', 12).startsWith('…'),
      true,
    );
    assert.equal(countUserTurns([{ role: 'user' }, { role: 'assistant' }, { role: 'user' }]), 2);
  });

  it('renders a fixed-width density meter (law 9)', () => {
    const empty = densityMeter(0, 8, GLYPHS_UNICODE);
    const full = densityMeter(1, 8, GLYPHS_UNICODE);
    assert.equal(empty.length, 8);
    assert.equal(full.length, 8);
    assert.notEqual(empty, full);
    assert.equal(densityMeter(0, 4, GLYPHS_ASCII).length, 4);
  });
});

describe('visual language v2 fault copy', () => {
  it('narrates what faulted, what was preserved, and the one action (law 11)', () => {
    const copy = faultCopy(new Error('layout blew up'));
    assert.match(copy.title, /failed to render/i);
    assert.equal(copy.detail, 'layout blew up');
    assert.match(copy.preserved, /daemon/i);
    assert.match(copy.action, /Restart|continue/i);
  });
});

describe('visual language v2 theme accent', () => {
  it('accepts hex accents and falls back safely', () => {
    assert.equal(accentHexForTheme('#38bdf8'), '#38bdf8');
    assert.equal(accentHexForTheme('not-a-color'), '#7dd3fc');
  });

  it('resolves the flat semantic tokens used by the rendered surface', () => {
    const tokens = createPushSilveryTokens('neon');
    const theme = { ...defaultDarkTheme, ...tokens };

    for (const token of Object.values(VL_COLOR)) {
      assert.ok(resolveThemeColor(token, theme), `${token} must resolve`);
    }
    assert.equal(resolveThemeColor('$fg-accent', theme), tokens['fg-accent']);
    assert.equal(resolveThemeColor('$bg-cursor', theme), tokens['fg-accent']);
    assert.equal(resolveThemeColor('$bg-selected', theme), tokens['fg-accent']);
  });
});
