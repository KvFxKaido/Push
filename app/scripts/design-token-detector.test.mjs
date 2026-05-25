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

  it('does not flag rgba/rgb values (low-noise: hex only)', () => {
    const r = findHardcodedColors('boxShadow: "0 2px 8px rgba(0,0,0,0.25)"');
    expect(r.total).toBe(0);
  });
});
