import { createBundledHighlighter } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import type { HighlightResult, PushCodeLanguage } from './push-code-plugin';

const PUSH_SHIKI_THEME = 'github-dark-default';

const LANGUAGE_LOADERS = {
  bash: () => import('shiki/langs/shellscript.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
} as const;

const createHighlighter = createBundledHighlighter({
  langs: LANGUAGE_LOADERS,
  themes: {
    [PUSH_SHIKI_THEME]: () => import('shiki/themes/github-dark-default.mjs'),
  },
  engine: () => createJavaScriptRegexEngine({ forgiving: true }),
});

const highlighterCache = new Map<PushCodeLanguage, ReturnType<typeof createHighlighter>>();

function getHighlighter(language: PushCodeLanguage) {
  const cached = highlighterCache.get(language);
  if (cached) return cached;

  const pending = createHighlighter({
    langs: [language],
    themes: [PUSH_SHIKI_THEME],
  });
  highlighterCache.set(language, pending);
  return pending;
}

export async function highlightPushCode(
  code: string,
  language: PushCodeLanguage,
): Promise<HighlightResult> {
  const highlighter = await getHighlighter(language);
  return highlighter.codeToTokens(code, {
    lang: language,
    themes: {
      light: PUSH_SHIKI_THEME,
      dark: PUSH_SHIKI_THEME,
    },
  });
}
