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

  it('does not flag grayscale rgba (shadows, sheens, scrims)', () => {
    // Black/white/neutral triplets are legit (not token-able) and stay silent.
    expect(findHardcodedColors('boxShadow: "0 2px 8px rgba(0,0,0,0.25)"').total).toBe(0);
    expect(findHardcodedColors('background: "rgba(255,255,255,0.05)"').total).toBe(0);
    expect(findHardcodedColors('"rgb(20, 24, 30)"').total).toBe(0); // near-neutral, spread <= 12
  });

  it('flags chromatic rgb()/rgba() triplets (legacy comma + modern slash)', () => {
    expect(findHardcodedColors('rgba(125,211,252,0.17)').rgbTriplet).toBe(1); // Sky
    expect(findHardcodedColors('rgb(125 211 252 / 0.17)').rgbTriplet).toBe(1);
    expect(findHardcodedColors('rgba(17,61,42,0.18)').rgbTriplet).toBe(1); // status green tint
  });

  it('flags the underscore form used inside Tailwind arbitrary values', () => {
    const r = findHardcodedColors(
      'bg-[radial-gradient(circle,rgb(125_211_252_/_0.17),transparent)]',
    );
    expect(r.rgbTriplet).toBe(1);
  });

  it('does NOT flag the tokenized rgb(var(--token) / a) form', () => {
    // The whole point of the fix: using the CSS var is the correct pattern.
    const r = findHardcodedColors('rgb(var(--push-accent-rgb) / 0.17)');
    expect(r.rgbTriplet).toBe(0);
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
