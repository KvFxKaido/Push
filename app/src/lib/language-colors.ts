// GitHub language colors — canonical per-language data colors used for repo
// language badges (mirrors github-linguist). These are DATA, not DESIGN.md
// design tokens, so this module is carved out of the design-token ratchet
// (see app/scripts/check-design-tokens.mjs and
// docs/runbooks/Design Token Migration Plan.md).

export const LANGUAGE_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572a5',
  Go: '#00add8',
  Rust: '#dea584',
  Java: '#b07219',
  Shell: '#89e051',
  HTML: '#e34c26',
  CSS: '#563d7c',
  Ruby: '#701516',
  Swift: '#f05138',
  Kotlin: '#a97bff',
  MDX: '#fcb32c',
  C: '#555555',
  'C++': '#f34b7d',
  'C#': '#178600',
};

// Fallback for languages without a known color.
export const LANGUAGE_COLOR_FALLBACK = '#8b8b8b';

export function getLanguageColor(language: string | null | undefined): string {
  return (language && LANGUAGE_COLORS[language]) || LANGUAGE_COLOR_FALLBACK;
}
