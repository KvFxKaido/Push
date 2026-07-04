import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cn, PUSH_FONT_SIZE_TOKENS } from './utils';

/**
 * Extract the `push-*` keys from the `fontSize` block of `tailwind.config.js`.
 * The config is CommonJS under a `type: module` package, which makes a clean
 * import awkward, so we parse the text: find `fontSize: {` and brace-match to
 * its close, then pull every `'push-…':` key. Robust to reformatting.
 */
function pushFontSizesFromConfig(): string[] {
  const configPath = fileURLToPath(new URL('../../tailwind.config.js', import.meta.url));
  const src = readFileSync(configPath, 'utf8');
  const start = src.indexOf('fontSize: {');
  if (start === -1) throw new Error('fontSize block not found in tailwind.config.js');
  let depth = 0;
  let end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) throw new Error('unterminated fontSize block in tailwind.config.js');
  const block = src.slice(start, end);
  return [...block.matchAll(/['"](push-[\w-]+)['"]\s*:/g)].map((m) => m[1]);
}

describe('cn font-size registration', () => {
  it('registers exactly the config font-size scale (drift guard)', () => {
    const fromConfig = pushFontSizesFromConfig();
    // Set-equal, order-independent: any push-* size in the config must be
    // registered with tailwind-merge, and vice versa.
    expect(new Set(PUSH_FONT_SIZE_TOKENS)).toEqual(new Set(fromConfig));
  });

  it('treats each token as a font-size, not a color', () => {
    for (const token of PUSH_FONT_SIZE_TOKENS) {
      // A standard size is a real conflict → the push size wins (last).
      expect(cn('text-sm', `text-${token}`)).toBe(`text-${token}`);
      // A push color is a different group → both survive.
      const merged = cn(`text-${token}`, 'text-push-fg-dim');
      expect(merged).toContain(`text-${token}`);
      expect(merged).toContain('text-push-fg-dim');
    }
  });

  it('still dedupes colors (regression guard for the extend)', () => {
    expect(cn('text-muted-foreground', 'text-push-fg-dim')).toBe('text-push-fg-dim');
  });
});
