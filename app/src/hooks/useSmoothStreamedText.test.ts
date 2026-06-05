import { describe, expect, it } from 'vitest';
import { revealStep } from './useSmoothStreamedText';

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
