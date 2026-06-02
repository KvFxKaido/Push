// Dependency-free detectors for hardcoded colors that should use the DESIGN.md
// token system (e.g. `text-push-fg`, `bg-push-surface`). Kept framework-free so
// both the ratchet script (check-design-tokens.mjs) and its vitest test can
// import it without a build step.

// Valid CSS hex lengths only (8 RGBA, 6 RGB, 4 RGBA-short, 3 RGB-short),
// longest-first so the alternation is greedy. Excludes invalid lengths like
// `#12345` / `#1234567` that would otherwise add ratchet noise.
const HEX = '(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})';

// Tailwind arbitrary color value: `bg-[#000]`, `border-[#1f2531]`, and the
// arbitrary-property form `[background-color:#121926]`. Matches the `#hex` that
// should instead be a token class.
const TAILWIND_ARBITRARY_HEX = new RegExp(`(?:-\\[#|\\[[a-zA-Z-]+:\\s*#)${HEX}\\b`, 'g');

// A quoted bare hex literal — inline `style={{ color: '#fff' }}`, theme objects
// (`backgroundColor: '#0d0d0d'`), or color constants. The quote must hug the
// `#`, so Tailwind arbitrary values inside a className string are not matched
// here (the char before `#` there is `[`, not a quote) and never double-count.
const QUOTED_HEX = new RegExp(`(['"\`])#${HEX}\\1`, 'g');

// rgb()/rgba() with literal numeric channels — e.g. `rgba(125,211,252,0.17)`
// (legacy comma) or `rgb(125 211 252 / .17)` (modern), including the
// underscore form Tailwind arbitrary values use (`rgb(125_211_252...`). We
// capture R/G/B so the caller can keep only *chromatic* triplets; grayscale
// ones (black shadows, white sheens, gray scrims) are legitimate and not
// token-able. The `[0-9]` first channel means `rgb(var(--token) ...)` — the
// correct, tokenized form — never matches.
const RGB_TRIPLET = /\brgba?\(\s*([0-9]{1,3})[\s,_]+([0-9]{1,3})[\s,_]+([0-9]{1,3})/g;

// A triplet counts as chromatic (i.e. a real hue that probably duplicates a
// palette token) when its channel spread exceeds this. Pure black/white and
// neutral grays sit at/near 0 spread and are skipped.
const CHROMATIC_SPREAD = 12;

/**
 * Count hardcoded colors in a source string.
 * @param {string} source
 * @returns {{ tailwind: number, inlineHex: number, rgbTriplet: number, total: number }}
 */
export function findHardcodedColors(source) {
  const tailwind = (source.match(TAILWIND_ARBITRARY_HEX) ?? []).length;
  const inlineHex = (source.match(QUOTED_HEX) ?? []).length;

  let rgbTriplet = 0;
  for (const m of source.matchAll(RGB_TRIPLET)) {
    const r = Number(m[1]);
    const g = Number(m[2]);
    const b = Number(m[3]);
    if (Math.max(r, g, b) - Math.min(r, g, b) > CHROMATIC_SPREAD) rgbTriplet += 1;
  }

  return { tailwind, inlineHex, rgbTriplet, total: tailwind + inlineHex + rgbTriplet };
}
