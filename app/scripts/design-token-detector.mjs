// Dependency-free detectors for hardcoded colors that should use the DESIGN.md
// token system (e.g. `text-push-fg`, `bg-push-surface`). Kept framework-free so
// both the ratchet script (check-design-tokens.mjs) and its vitest test can
// import it without a build step.

// Tailwind arbitrary color value: `bg-[#000]`, `border-[#1f2531]`, and the
// arbitrary-property form `[background-color:#121926]`. Matches the `#hex` that
// should instead be a token class.
const TAILWIND_ARBITRARY_HEX = /(?:-\[#|\[[a-zA-Z-]+:\s*#)[0-9a-fA-F]{3,8}\b/g;

// A quoted bare hex literal — inline `style={{ color: '#fff' }}`, theme objects
// (`backgroundColor: '#0d0d0d'`), or color constants. The quote must hug the
// `#`, so Tailwind arbitrary values inside a className string are not matched
// here (the char before `#` there is `[`, not a quote) and never double-count.
const QUOTED_HEX = /(['"`])#[0-9a-fA-F]{3,8}\1/g;

/**
 * Count hardcoded colors in a source string.
 * @param {string} source
 * @returns {{ tailwind: number, inlineHex: number, total: number }}
 */
export function findHardcodedColors(source) {
  const tailwind = (source.match(TAILWIND_ARBITRARY_HEX) ?? []).length;
  const inlineHex = (source.match(QUOTED_HEX) ?? []).length;
  return { tailwind, inlineHex, total: tailwind + inlineHex };
}
