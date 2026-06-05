import { describe, expect, it } from 'vitest';
import { createCodePlugin } from '@streamdown/code';

/**
 * Real verification that the Shiki highlighting wired into PushMarkdownRenderer
 * actually resolves colors — not just that Streamdown emits the code-block
 * structure. (An earlier attempt shipped uncolored output because the
 * `@streamdown/code` plugin was never installed/passed; the SSR fixtures only
 * asserted structure, so the gap went unnoticed.) This calls the same plugin
 * the adapter uses and asserts the highlighter returns real token colors.
 */
describe('@streamdown/code Shiki plugin', () => {
  it('resolves real (non-inherit) token colors for highlighted code', async () => {
    const plugin = createCodePlugin({ themes: ['github-dark-default', 'github-dark-default'] });

    const options = {
      code: 'const x: number = 1;',
      language: 'ts' as const,
      themes: ['github-dark-default', 'github-dark-default'] as [
        'github-dark-default',
        'github-dark-default',
      ],
    };

    // The plugin highlights asynchronously: the first call may return null while
    // grammars/themes load, then deliver the result via callback.
    const result = await new Promise<ReturnType<typeof plugin.highlight>>((resolve) => {
      const immediate = plugin.highlight(options, (r) => resolve(r));
      if (immediate) resolve(immediate);
    });

    expect(result).toBeTruthy();
    const tokens = result?.tokens?.flat() ?? [];
    expect(tokens.length).toBeGreaterThan(0);

    // At least one token must carry a concrete hex color, proving Shiki actually
    // highlighted rather than falling back to `inherit`. With a dual-theme
    // config Shiki emits the color via `htmlStyle` (CSS-variable theming) rather
    // than the flat `color` field, so check both.
    const hex = /^#[0-9a-f]{3,8}$/i;
    const colored = tokens.filter((t) => {
      const flat = typeof t.color === 'string' && hex.test(t.color);
      const styled = typeof t.htmlStyle?.color === 'string' && hex.test(t.htmlStyle.color);
      return flat || styled;
    });
    expect(colored.length).toBeGreaterThan(0);
    // Different syntax kinds get different colors (keyword vs identifier).
    const distinctColors = new Set(colored.map((t) => t.htmlStyle?.color ?? t.color));
    expect(distinctColors.size).toBeGreaterThan(1);
  });

  it('reports the language as supported', () => {
    const plugin = createCodePlugin();
    expect(plugin.supportsLanguage('ts')).toBe(true);
    expect(plugin.name).toBe('shiki');
  });
});
