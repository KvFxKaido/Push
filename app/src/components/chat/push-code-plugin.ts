import type { CodeHighlighterPlugin, ThemeInput } from 'streamdown';

const PUSH_SHIKI_THEME = 'github-dark-default';
const PUSH_SHIKI_THEMES = [PUSH_SHIKI_THEME, PUSH_SHIKI_THEME] satisfies [ThemeInput, ThemeInput];

const SUPPORTED_LANGUAGE_IDS = [
  'bash',
  'c',
  'css',
  'diff',
  'dockerfile',
  'go',
  'html',
  'ini',
  'java',
  'javascript',
  'json',
  'jsonc',
  'jsx',
  'markdown',
  'python',
  'rust',
  'scss',
  'sql',
  'toml',
  'tsx',
  'typescript',
  'xml',
  'yaml',
] as const;

export type PushCodeLanguage = (typeof SUPPORTED_LANGUAGE_IDS)[number];
export type HighlightResult = NonNullable<ReturnType<CodeHighlighterPlugin['highlight']>>;
type HighlightCallback = NonNullable<Parameters<CodeHighlighterPlugin['highlight']>[1]>;

const LANGUAGE_ALIASES: Record<string, PushCodeLanguage> = {
  bat: 'bash',
  batch: 'bash',
  cjs: 'javascript',
  conf: 'ini',
  cpp: 'c',
  cxx: 'c',
  h: 'c',
  hpp: 'c',
  js: 'javascript',
  json5: 'jsonc',
  md: 'markdown',
  mjs: 'javascript',
  py: 'python',
  rs: 'rust',
  sh: 'bash',
  shell: 'bash',
  shellscript: 'bash',
  ts: 'typescript',
  yml: 'yaml',
  zsh: 'bash',
};

const SUPPORTED_LANGUAGES = new Set<PushCodeLanguage>(SUPPORTED_LANGUAGE_IDS);
const resultCache = new Map<string, HighlightResult>();
const callbackCache = new Map<string, Set<HighlightCallback>>();

function normalizeLanguage(language: string): PushCodeLanguage | null {
  const normalized = language.trim().toLowerCase();
  return (
    LANGUAGE_ALIASES[normalized] ??
    (SUPPORTED_LANGUAGES.has(normalized as PushCodeLanguage)
      ? (normalized as PushCodeLanguage)
      : null)
  );
}

function cacheKey(code: string, language: PushCodeLanguage): string {
  return `${language}\0${code}`;
}

function buildPlainResult(code: string): HighlightResult {
  return {
    bg: 'transparent',
    fg: 'inherit',
    tokens: code.split('\n').map((line) => [
      {
        content: line,
        color: 'inherit',
        bgColor: 'transparent',
        htmlStyle: {},
        offset: 0,
      },
    ]),
  };
}

export function createPushCodePlugin(): CodeHighlighterPlugin {
  return {
    name: 'shiki',
    type: 'code-highlighter',

    getThemes() {
      return PUSH_SHIKI_THEMES;
    },

    getSupportedLanguages() {
      return Array.from(SUPPORTED_LANGUAGES);
    },

    supportsLanguage(language) {
      return Boolean(normalizeLanguage(language));
    },

    highlight({ code, language }, callback) {
      const normalizedLanguage = normalizeLanguage(language);
      if (!normalizedLanguage) return buildPlainResult(code);

      const key = cacheKey(code, normalizedLanguage);
      const cached = resultCache.get(key);
      if (cached) return cached;

      if (callback) {
        const callbacks = callbackCache.get(key) ?? new Set<HighlightCallback>();
        callbacks.add(callback);
        callbackCache.set(key, callbacks);
      }

      void import('./push-shiki-highlighter')
        .then(({ highlightPushCode }) => highlightPushCode(code, normalizedLanguage))
        .then((result) => {
          resultCache.set(key, result);
          const callbacks = callbackCache.get(key);
          if (callbacks) {
            for (const cb of callbacks) cb(result);
            callbackCache.delete(key);
          }
        })
        .catch((error: unknown) => {
          console.error('[Push Code] Failed to highlight code:', error);
          callbackCache.delete(key);
        });

      return null;
    },
  };
}

export const pushCodePlugin = createPushCodePlugin();
