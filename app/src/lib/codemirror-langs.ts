/**
 * Lazy language loader for CodeMirror 6.
 *
 * Each language is loaded via dynamic import() so Vite code-splits them
 * into separate chunks — only the requested language hits the network.
 */

import type { LanguageSupport } from '@codemirror/language';

type LangLoader = () => Promise<LanguageSupport>;

const loaders: Record<string, LangLoader> = {
  javascript: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: false })),
  typescript: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true })),
  jsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  tsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true, typescript: true })),
  python: () => import('@codemirror/lang-python').then((m) => m.python()),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  markdown: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  java: () => import('@codemirror/lang-java').then((m) => m.java()),
  rust: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  cpp: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  c: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  sql: () => import('@codemirror/lang-sql').then((m) => m.sql()),
};

/**
 * Map file extensions and language names to loader keys.
 */
const aliases: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  jsx: 'jsx',
  tsx: 'tsx',
  py: 'python',
  rb: 'python', // fallback — no Ruby support, Python is closest
  md: 'markdown',
  mdx: 'markdown',
  htm: 'html',
  xml: 'html',
  svg: 'html',
  scss: 'css',
  less: 'css',
  sass: 'css',
  rs: 'rust',
  h: 'cpp',
  hpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  yaml: 'json',  // no YAML support — JSON is structurally closest
  yml: 'json',
  toml: 'json',
  jsonc: 'json',
  json5: 'json',
};

/**
 * Load a language extension by name or file extension.
 * Returns `null` for unsupported languages (plain text fallback).
 */
export async function loadLanguage(lang: string): Promise<LanguageSupport | null> {
  const key = lang.toLowerCase().replace(/^\./, '');
  const resolved = loaders[key] ? key : aliases[key];
  if (!resolved || !loaders[resolved]) return null;

  try {
    return await loaders[resolved]();
  } catch (err) {
    console.warn(`[CodeMirror] Failed to load language "${resolved}":`, err);
    return null;
  }
}
