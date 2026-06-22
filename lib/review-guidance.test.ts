import { describe, expect, it } from 'vitest';
import { capReviewGuidanceLines, REVIEW_GUIDANCE_MAX_LINES } from './review-guidance.js';

describe('capReviewGuidanceLines', () => {
  const makeLines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

  it('returns the text unchanged at or under the line cap', () => {
    const text = makeLines(REVIEW_GUIDANCE_MAX_LINES);
    expect(capReviewGuidanceLines(text)).toBe(text);
  });

  it('caps to the line limit and marks the cut when over', () => {
    const result = capReviewGuidanceLines(makeLines(REVIEW_GUIDANCE_MAX_LINES + 50));
    const lines = result.split('\n');
    // 600 content lines + 1 marker line — the cut is not silent.
    expect(lines).toHaveLength(REVIEW_GUIDANCE_MAX_LINES + 1);
    expect(lines[REVIEW_GUIDANCE_MAX_LINES - 1]).toBe(`line ${REVIEW_GUIDANCE_MAX_LINES}`);
    expect(result).not.toContain(`line ${REVIEW_GUIDANCE_MAX_LINES + 1}`);
    expect(result).toMatch(/truncated at 600 lines/);
  });
});
