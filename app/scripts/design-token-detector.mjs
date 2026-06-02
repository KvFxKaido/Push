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

// Tailwind arbitrary value: `bg-[...]`, `text-[...]`, or the arbitrary-property
// form `[background:linear-gradient(...)]`. Arbitrary values carry no literal
// whitespace (Tailwind writes spaces as `_`), so the content is a run of
// non-`]`, non-whitespace chars. Used to scope the rgb()/rgba() scan below to
// "inside an arbitrary value", where a raw triplet is the same token violation a
// `bg-[#hex]` would be — without flagging bare `rgba(0,0,0,.25)` boxShadow noise.
const TAILWIND_ARBITRARY_VALUE = /(?:-\[|\[[a-zA-Z-]+:)[^\]\s]*\]/g;

// A raw rgb()/rgba() color triplet — its first argument is a number (or `%`),
// e.g. `rgb(125_211_252_/_.17)`, `rgba(56,189,248,0.5)`. A tokenized
// `rgb(var(--push-accent-rgb) / .17)` opens with `var`, not a digit, so it is
// correctly left alone — referencing a token var is the fix, not the violation.
const RAW_RGB = /rgba?\(\s*[.\d]/gi;

/**
 * Count hardcoded colors in a source string.
 * @param {string} source
 * @returns {{ tailwind: number, inlineHex: number, arbitraryRgb: number, total: number }}
 */
export function findHardcodedColors(source) {
  const tailwind = (source.match(TAILWIND_ARBITRARY_HEX) ?? []).length;
  const inlineHex = (source.match(QUOTED_HEX) ?? []).length;
  let arbitraryRgb = 0;
  for (const m of source.matchAll(TAILWIND_ARBITRARY_VALUE)) {
    arbitraryRgb += (m[0].match(RAW_RGB) ?? []).length;
  }
  return { tailwind, inlineHex, arbitraryRgb, total: tailwind + inlineHex + arbitraryRgb };
}
