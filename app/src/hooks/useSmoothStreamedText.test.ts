import { describe, expect, it } from 'vitest';
import { revealStep, sliceToSafeBoundary } from './useSmoothStreamedText';

const FRAME_MS = 16; // ~60fps

describe('revealStep', () => {
  it('returns the target when already caught up', () => {
    expect(revealStep(40, 40, FRAME_MS)).toBe(40);
    expect(revealStep(50, 40, FRAME_MS)).toBe(40); // never exceeds target
  });

  it('always advances at least one character so a trickle never stalls', () => {
    // A 1-char gap with a tiny frame still moves forward.
    expect(revealStep(10, 11, 1)).toBe(11);
    // Even a zero-elapsed frame guarantees the minimum step.
    expect(revealStep(0, 5, 0)).toBe(1);
  });

  it('never overshoots the target', () => {
    for (let dt = 0; dt <= 200; dt += 7) {
      const next = revealStep(98, 100, dt);
      expect(next).toBeLessThanOrEqual(100);
      expect(next).toBeGreaterThan(98);
    }
  });

  it('reveals faster when the backlog is larger (catch-up)', () => {
    const smallGap = revealStep(0, 20, FRAME_MS);
    const largeGap = revealStep(0, 400, FRAME_MS);
    expect(largeGap - 0).toBeGreaterThan(smallGap - 0);
  });

  it('snaps straight to the target for paste-sized bursts', () => {
    expect(revealStep(0, 2000, FRAME_MS)).toBe(2000);
    expect(revealStep(0, 1500, FRAME_MS)).toBe(1500);
    // Just under the snap threshold should still ease in gradually.
    expect(revealStep(0, 1499, FRAME_MS)).toBeLessThan(1499);
  });

  it('is frame-rate independent: longer frames reveal proportionally more', () => {
    const oneFrame = revealStep(0, 1000, FRAME_MS);
    const doubleFrame = revealStep(0, 1000, FRAME_MS * 2);
    expect(doubleFrame).toBeGreaterThan(oneFrame);
  });

  it('converges to the target over a realistic stream', () => {
    let current = 0;
    const target = 240;
    // Simulate ~1.5s of 60fps frames; the reveal should fully catch up.
    for (let i = 0; i < 90 && current < target; i++) {
      current = revealStep(current, target, FRAME_MS);
    }
    expect(current).toBe(target);
  });
});

describe('sliceToSafeBoundary', () => {
  it('passes through plain ASCII at any boundary', () => {
    expect(sliceToSafeBoundary('hello world', 5)).toBe('hello');
    expect(sliceToSafeBoundary('hello', 0)).toBe('');
    expect(sliceToSafeBoundary('hello', 5)).toBe('hello');
  });

  it('never splits a surrogate pair (astral emoji)', () => {
    const text = 'hi 🎉 there'; // 🎉 is a surrogate pair at indices 3-4
    // Boundary landing on the low surrogate backs off to exclude the half-char.
    const sliced = sliceToSafeBoundary(text, 4);
    expect(sliced).toBe('hi ');
    // Boundary past the full pair keeps the whole emoji.
    expect(sliceToSafeBoundary(text, 5)).toBe('hi 🎉');
  });

  it('does not end on a dangling zero-width joiner', () => {
    // Family emoji: woman + ZWJ + boy = [D83D DC69][200D][D83D DC66]
    const family = '👩‍👦';
    // A boundary just after the ZWJ must not leave a trailing joiner; it backs
    // off to the completed leading cluster.
    expect(sliceToSafeBoundary(family, 3)).toBe('👩');
    // Mid second surrogate pair also backs off to the complete first emoji.
    expect(sliceToSafeBoundary(family, 4)).toBe('👩');
  });

  it('returns the full string when end is at or past length', () => {
    expect(sliceToSafeBoundary('abc', 3)).toBe('abc');
    expect(sliceToSafeBoundary('abc', 99)).toBe('abc');
  });
});
