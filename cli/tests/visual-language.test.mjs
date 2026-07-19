/**
 * Visual Language v2 pure helpers — glyphs, color budget, motion, frame copy.
 * Source: docs/cli/design/TUI Visual Language v2.md
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { defaultDarkTheme, displayWidth, resolveThemeColor } from 'silvery';

import { createPushSilveryTokens } from '../silvery/theme.tsx';
import { VARIANTS } from '../tui-theme.ts';

import {
  GLYPHS_ASCII,
  GLYPHS_UNICODE,
  MOTION_TICKS,
  PUSH_BRAND_ART_COLS,
  VL_COLOR,
  accentHexForTheme,
  brandShimmerColors,
  livenessHex,
  shimmerIntensity,
  verbShimmerColors,
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
  pushBrandArt,
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
    assert.equal(GLYPHS_ASCII.hexActive, '@');
    assert.equal(resolveGlyphs(true).hexIdle, '⬡');
    assert.equal(resolveGlyphs(false).hexActive, '@');
  });

  it('puts a SQUARE on the activity spine, never a diamond or the hexagon (law 5)', () => {
    // The workhorse must not rhyme with the signature: `◆` and `⬢` are both angular
    // filled polygons and read as the same family in a scrolling transcript.
    assert.equal(GLYPHS_UNICODE.markWork, '▪\uFE0E');
    assert.equal(GLYPHS_UNICODE.markQuiet, '▫\uFE0E');
    assert.equal(displayWidth(GLYPHS_UNICODE.markWork), 1);
    assert.equal(displayWidth(GLYPHS_UNICODE.markQuiet), 1);
    assert.ok(!GLYPHS_UNICODE.markWork.includes('\uFE0F'), 'work mark is never emoji presentation');
    assert.ok(
      !GLYPHS_UNICODE.markQuiet.includes('\uFE0F'),
      'quiet mark is never emoji presentation',
    );
    assert.equal(GLYPHS_ASCII.markWork, '+');
    assert.equal(GLYPHS_ASCII.markQuiet, '-');
    for (const glyphs of [GLYPHS_UNICODE, GLYPHS_ASCII]) {
      for (const spine of [glyphs.markWork, glyphs.markQuiet]) {
        assert.ok(!['◆', '◇'].includes(spine), 'the spine is not a diamond');
        assert.notEqual(spine, glyphs.hexIdle, 'the spine is not the signature');
        assert.notEqual(spine, glyphs.hexActive, 'the spine is not the signature');
        assert.notEqual(spine, glyphs.human, 'the spine is not the human caret');
      }
    }
  });

  it('never reuses a density cell as a spine mark (ASCII tier collision)', () => {
    // `dotIdle: '.'` collided with `density[0]: '.'` — two meanings on one glyph in the
    // same frame, which is exactly what law 4 says not to do.
    for (const glyphs of [GLYPHS_UNICODE, GLYPHS_ASCII]) {
      assert.ok(!glyphs.density.includes(glyphs.markWork));
      assert.ok(!glyphs.density.includes(glyphs.markQuiet));
    }
  });

  it('carries state on the spine by COLOR, not by glyph (law 4)', () => {
    // A settled tool call wears the SAME mark as a live one — only the color differs.
    // This is why the glyphs are named markWork/markQuiet and not active/idle.
    const g = GLYPHS_UNICODE;
    const pending = streamMark('tool_pending', g);
    const ok = streamMark('tool_ok', g);
    const error = streamMark('tool_error', g);
    assert.equal(pending.glyph, g.markWork);
    assert.equal(ok.glyph, g.markWork);
    assert.equal(error.glyph, g.markWork);
    assert.notEqual(pending.color, ok.color);
    assert.notEqual(ok.color, error.color);
    // The lead agent is Push's face in its quiet register — the hollow hex,
    // distinct from the filled hex the independent review voices wear.
    assert.equal(streamMark('assistant', g).glyph, g.hexIdle);
    assert.notEqual(streamMark('assistant', g).glyph, streamMark('reviewer', g).glyph);
    // The human is neither the spine nor the hex — the caret.
    assert.equal(streamMark('user', g).glyph, g.human);
  });

  it('renders the Push mark as a HEXAGON — flat vertical sides, not a rhombus (law 6)', () => {
    // The property that matters, and the one a line-width assertion cannot see: the real
    // PushMarkIcon path (M8 1 14.5 5v6L8 15 1.5 11V5L8 1Z) holds x = 1.5 and x = 14.5
    // from y = 5 to y = 11. Pure diagonals give you a diamond — which is what the
    // hand-drawn version shipped, under a test that asserted [1,5,9,13,13,9,5,1] and
    // called it "the Push hex mark".
    for (const unicode of [true, false]) {
      const art = pushBrandArt(unicode);
      // Trim the sloped top/bottom proportionally so this survives a mark resize:
      // ~22% off each end leaves the flat-sided middle band (3 rows off a 13-row
      // mark, 2 off the 9-row one).
      const trim = Math.max(1, Math.round(art.length * 0.22));
      const middle = art.slice(trim, art.length - trim);
      assert.ok(middle.length >= 3, 'need a middle band to test the sides');

      // A column that is lit on EVERY middle row is a vertical side. A rhombus has none.
      const litEveryRow = [];
      for (let c = 0; c < art[0].length; c += 1) {
        if (middle.every((row) => row[c] !== undefined && row[c] !== ' ')) litEveryRow.push(c);
      }
      assert.ok(
        litEveryRow.length >= 4,
        `expected flat vertical sides, got ${litEveryRow.length} sustained columns (a rhombus has 0)`,
      );
      // Sides on BOTH edges, mirrored about the centre.
      const mid = (art[0].length - 1) / 2;
      assert.ok(
        litEveryRow.some((c) => c < mid),
        'a left vertical side',
      );
      assert.ok(
        litEveryRow.some((c) => c > mid),
        'a right vertical side',
      );
    }
  });

  it('draws the mark from glyphs the language already owns, at a uniform width (law 6)', () => {
    const unicode = pushBrandArt(true);
    const ascii = pushBrandArt(false);
    // Equal-width rows: the surface centers the block with alignItems=center, which
    // centers each line by its OWN width — a ragged row would shear the hexagon.
    assert.equal(new Set(unicode.map((l) => l.length)).size, 1);
    assert.equal(new Set(ascii.map((l) => l.length)).size, 1);
    assert.equal(unicode[0].length, PUSH_BRAND_ART_COLS);

    // No new glyphs enter the language: the mark is drawn from the density ramp.
    const allowed = (g) => new Set([' ', ...g.density]);
    for (const [art, g] of [
      [unicode, GLYPHS_UNICODE],
      [ascii, GLYPHS_ASCII],
    ]) {
      for (const ch of art.join('')) {
        assert.ok(allowed(g).has(ch), `mark uses "${ch}", which is not a density cell`);
      }
    }
  });

  it('renders the compact 17x9 launch mark', () => {
    const art = pushBrandArt(true);
    assert.equal(art.length, 9, 'default mark is 9 rows tall');
    assert.equal(art[0].length, 17, 'default mark is 17 cols wide');
    assert.equal(
      PUSH_BRAND_ART_COLS,
      17,
      'exported width matches the default the surface guards on',
    );
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

  it('puts squares on tools and hexes only on independent voices (law 5)', () => {
    const g = GLYPHS_UNICODE;
    assert.equal(streamMark('tool_pending', g).glyph, g.markWork);
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
    assert.equal(GLYPHS_UNICODE.human, '❯');
    assert.equal(GLYPHS_ASCII.human, '>');
    assert.equal(displayWidth(GLYPHS_UNICODE.human), 1);
    const g = GLYPHS_UNICODE;
    const user = streamMark('user', g);
    assert.equal(user.glyph, '❯');
    assert.notEqual(user.glyph, g.hexActive); // not Push's face (independent voices)
    assert.notEqual(user.glyph, g.hexIdle); // nor the lead agent's hollow hex
    assert.notEqual(user.glyph, g.markWork); // not Push's activity spine
    assert.notEqual(user.glyph, g.markQuiet);
    assert.equal(user.color, VL_COLOR.accent);
    assert.equal(streamMark('user', GLYPHS_ASCII).glyph, '>');
  });
});

describe('visual language v2 motion', () => {
  it('maps web motion axes into tick counts (law 9)', () => {
    assert.equal(MOTION_TICKS.modalFade, 3);
    assert.ok(MOTION_TICKS.verbShimmerPeriod >= 4);
    assert.ok(MOTION_TICKS.clockMs > 0);
  });

  it('marks liveness by glyph and accent, with nothing moving (laws 2, 8)', () => {
    const g = GLYPHS_UNICODE;
    // The hex used to breathe — law 8's one animation now belongs to the verb
    // shimmer, so this is a static anchor and takes no tick at all.
    assert.deepEqual(livenessHex('idle', g), { glyph: '⬡', bright: false });
    assert.deepEqual(livenessHex('working', g), { glyph: '⬢', bright: false });
    assert.deepEqual(livenessHex('attention', g), { glyph: '⬢', bright: true });
  });

  it('keeps working and attention distinguishable without motion (law 2)', () => {
    // Freezing the hex collapsed the old glyph-level distinction (both filled),
    // so the accent carries it. If these ever agree on BOTH axes, "needs you"
    // and "busy" become the same pixel.
    assert.notDeepEqual(
      livenessHex('working', GLYPHS_UNICODE),
      livenessHex('attention', GLYPHS_UNICODE),
    );
  });

  it('sweeps the shimmer band left to right across the verb (laws 8, 9)', () => {
    const verb = 'editing';
    // Peak intensity must TRAVEL: early in the sweep the left of the word is
    // lit, late in the sweep the right is. Silvery's own TextShimmer lights the
    // whole word at once and would fail this — see the note in theme.tsx.
    const argmax = (xs) => xs.indexOf(Math.max(...xs));
    const at = (p) => argmax([...verb].map((_, i) => shimmerIntensity(i, verb.length, p)));
    assert.ok(at(0.15) < at(0.85), `band did not travel: ${at(0.15)} → ${at(0.85)}`);
  });

  it('lights only a band, never the whole label (law 9: light, not space)', () => {
    const len = 10;
    const lit = [...Array(len)].map((_, i) => shimmerIntensity(i, len, 0.5)).filter((t) => t > 0);
    assert.ok(lit.length > 0, 'band vanished mid-sweep');
    assert.ok(lit.length < len, 'band swamped the whole label — that is a pulse, not a sweep');
  });

  it('returns one color per character and never resizes the label', () => {
    // Width safety: a color effect must not be able to reflow the header.
    for (const verb of ['ok', 'committing', 'brewing']) {
      assert.equal(verbShimmerColors(verb, 3, false).length, [...verb].length);
    }
  });

  it('phase-locks the sweep to the shared tick and wraps cleanly (law 8)', () => {
    const period = MOTION_TICKS.verbShimmerPeriod;
    // Same phase of a later cycle → identical frame. That is what "one clock"
    // buys: no drift against the modal fade.
    assert.deepEqual(
      verbShimmerColors('editing', 2, false),
      verbShimmerColors('editing', 2 + period, false),
    );
    // A negative tick must not yield a NaN color.
    for (const color of verbShimmerColors('editing', -3, false)) {
      assert.match(color, /^#[0-9a-f]{6}$/);
    }
  });

  it('flattens to one static color under reduced motion (law 10)', () => {
    const colors = verbShimmerColors('editing', 7, true);
    assert.equal(new Set(colors).size, 1, 'reduced motion still gradients');
    assert.deepEqual(colors, verbShimmerColors('editing', 999, true));
  });

  it('shimmers the brand mark at half the verb tempo, in a clean 2:1 (law 8)', () => {
    // The launch mark and the working verb are one effect at two speeds; a 2:1
    // octave keeps them from reading as two different broken clocks.
    assert.equal(MOTION_TICKS.brandShimmerPeriod, MOTION_TICKS.verbShimmerPeriod * 2);
    // A raster row round-trips to one color per column (so the surface can zip
    // colors to characters without a bounds check) and never NaNs.
    const row = pushBrandArt(true)[4];
    const colors = brandShimmerColors(row, 5, false);
    assert.equal(colors.length, [...row].length);
    for (const color of colors) assert.match(color, /^#[0-9a-f]{6}$/);
    // Phase-locked to the SLOW period: identical frame one brand-cycle later, and
    // (crucially) NOT yet identical one verb-cycle later — proof it runs slower.
    assert.deepEqual(colors, brandShimmerColors(row, 5 + MOTION_TICKS.brandShimmerPeriod, false));
    assert.notDeepEqual(colors, brandShimmerColors(row, 5 + MOTION_TICKS.verbShimmerPeriod, false));
  });

  it('freezes the brand mark to the muted trough under reduced motion (law 10)', () => {
    const row = pushBrandArt(true)[4];
    const colors = brandShimmerColors(row, 9, true);
    assert.equal(new Set(colors).size, 1, 'reduced-motion mark still shimmers');
    // The trough is the muted canvas, so a static mark is indistinguishable from
    // any other dim chrome — identical at any tick.
    assert.deepEqual(colors, brandShimmerColors(row, 500, true));
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
      branch: 'main',
      path: '~/proj',
      context: '12k',
      turn: 'turn 3',
    });
    // No brand mark and no verb: those are separately styled zones (accent hex,
    // shimmering verb) and cannot ride a joined muted string. Carrying
    // `brandMark` here is what kept this helper unwired while HeaderBar
    // hand-built the same row.
    assert.deepEqual(segs, ['main', '~/proj', '12k', 'turn 3']);
  });

  it('omits empty facts rather than emitting empty segments', () => {
    assert.deepEqual(headerSegments({ branch: 'main', path: '', context: '12k', turn: '' }), [
      'main',
      '12k',
    ]);
  });

  it('formats turn timestamps compactly and tolerates missing legacy timestamps', () => {
    const at = new Date(2026, 6, 12, 15, 7).getTime();
    assert.equal(formatTurnTimestamp(at, 'en-US'), '3:07 PM');
    assert.equal(formatTurnTimestamp(undefined, 'en-US'), '');
  });

  it('switches footer keybinds by focus scope (law 1)', () => {
    assert.match(footerKeybinds('composer'), /ctrl\+k/i);
    assert.match(footerKeybinds('composer'), /tab complete/i);
    assert.match(footerKeybinds('composer'), /\? help/i);
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

  it("keeps Push's near-black neutral foundation across accent themes", () => {
    const neutral = VARIANTS.mono.tokens;
    const neon = createPushSilveryTokens('neon');
    const forest = createPushSilveryTokens('forest');

    for (const tokens of [neon, forest]) {
      assert.equal(tokens.bg, neutral['bg.base']);
      assert.equal(tokens.fg, neutral['fg.primary']);
      assert.equal(tokens['bg-default'], neutral['bg.base']);
      assert.equal(tokens['bg-surface-default'], neutral['bg.base']);
      assert.equal(tokens['bg-surface-subtle'], neutral['bg.panel']);
      assert.equal(tokens['fg-default'], neutral['fg.primary']);
      assert.equal(tokens['fg-muted'], neutral['fg.muted']);
      assert.equal(tokens['border-default'], neutral['border.default']);
      assert.notEqual(tokens['bg-default'], defaultDarkTheme['bg-default']);
    }

    assert.notEqual(neon['fg-accent'], forest['fg-accent']);
  });
});
