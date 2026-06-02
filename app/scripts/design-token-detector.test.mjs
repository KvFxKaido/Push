import { describe, expect, it } from 'vitest';
import { findHardcodedColors } from './design-token-detector.mjs';

describe('findHardcodedColors', () => {
  it('flags Tailwind arbitrary hex values', () => {
    const r = findHardcodedColors('<div className="bg-[#000] text-[#f5f7ff]" />');
    expect(r.tailwind).toBe(2);
    expect(r.inlineHex).toBe(0);
    expect(r.total).toBe(2);
  });

  it('flags the arbitrary-property form', () => {
    expect(findHardcodedColors('[background-color:#121926]').tailwind).toBe(1);
  });

  it('flags quoted hex literals (inline styles / constants)', () => {
    const r = findHardcodedColors(`const s = { color: '#fff', background: "#0b0d12" };`);
    expect(r.inlineHex).toBe(2);
  });

  it('does not double-count a Tailwind value as a quoted hex', () => {
    const r = findHardcodedColors('className="bg-[#000]"');
    expect(r.tailwind).toBe(1);
    expect(r.inlineHex).toBe(0);
  });

  it('ignores token classes and non-color code', () => {
    const r = findHardcodedColors('<div className="bg-push-surface text-push-fg" />');
    expect(r.total).toBe(0);
  });

  it('counts 3-, 6-, and 8-digit hex literals', () => {
    const r = findHardcodedColors(`a('#fff'); b('#0b0d12'); c('#a78bfa26');`);
    expect(r.inlineHex).toBe(3);
  });

  it('does not flag bare rgba/rgb outside arbitrary values (low-noise)', () => {
    const r = findHardcodedColors('boxShadow: "0 2px 8px rgba(0,0,0,0.25)"');
    expect(r.arbitraryRgb).toBe(0);
    expect(r.total).toBe(0);
  });

  it('flags raw rgb()/rgba() triplets inside a Tailwind arbitrary gradient', () => {
    const r = findHardcodedColors(
      'className="bg-[radial-gradient(58%_100%_at_50%_0%,rgb(125_211_252_/_0.17),transparent_72%)]"',
    );
    expect(r.arbitraryRgb).toBe(1);
    expect(r.total).toBe(1);
  });

  it('counts every raw triplet in a multi-stop arbitrary gradient', () => {
    const r = findHardcodedColors(
      'className="bg-[linear-gradient(90deg,rgba(56,189,248,0.5),rgb(125,211,252))]"',
    );
    expect(r.arbitraryRgb).toBe(2);
  });

  it('flags raw rgb() in the arbitrary-property form', () => {
    const r = findHardcodedColors('[background:linear-gradient(rgba(13,13,13,0.6),transparent)]');
    expect(r.arbitraryRgb).toBe(1);
  });

  it('does not flag a tokenized rgb(var(--token)) inside an arbitrary value', () => {
    const r = findHardcodedColors(
      'className="bg-[radial-gradient(58%_100%_at_50%_0%,rgb(var(--push-accent-rgb)_/_0.17),transparent_72%)]"',
    );
    expect(r.arbitraryRgb).toBe(0);
    expect(r.total).toBe(0);
  });

  it('ignores invalid-length hex (only 3/4/6/8 digits count)', () => {
    const r = findHardcodedColors(`a('#12345'); b('#1234567'); c('#ab');`);
    expect(r.total).toBe(0);
  });

  it('counts 4-digit (RGBA-short) hex', () => {
    expect(findHardcodedColors(`x('#abcd')`).inlineHex).toBe(1);
  });
});
