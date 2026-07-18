/**
 * tui-highlight.ts — Dependency-free, synchronous syntax highlighting for
 * code fences in the transcript. Zero dependencies (matches the rest of the
 * TUI core); a small per-language lexer rather than a tree-sitter/WASM
 * dependency, chosen because transcript snippets are short and the framer
 * render path is synchronous.
 *
 * Three invariants make this safe to drop into the existing renderer:
 *
 *  1. **Width-preserving.** Only ANSI escapes are inserted; the visible text
 *     is never altered. `visibleWidth()` / `wordWrap()` already exclude
 *     escapes, so layout math is untouched. `stripAnsi(highlight(x)) === x`.
 *
 *  2. **Wrap-safe.** `wordWrap()` only ever splits at spaces (and hard-breaks
 *     an over-long single word by *stripping* ANSI). So every
 *     whitespace-delimited word we emit carries its own balanced
 *     set-colour/RESET pair — a colour is never left open across a space.
 *     A wrap split therefore can never leak a colour or drop a reset. See
 *     `styleSpan`.
 *
 *  3. **Tier/theme-agnostic.** Token categories map onto the existing
 *     semantic theme tokens, so all six themes and four colour tiers
 *     (including NO_COLOR → plain) degrade for free. `tier: 'none'` returns
 *     the input verbatim so transcript goldens stay byte-identical.
 */
import type { Theme, TokenName } from './tui-theme.js';

// ── Category → theme token ──────────────────────────────────────────
// Reuse semantic tokens rather than minting syntax-specific ones: a new
// token would need a hex value + 16-colour fallback across all six theme
// variants, whereas the semantic tokens already carry that.

type Category =
  | 'keyword'
  | 'type'
  | 'function'
  | 'string'
  | 'property'
  | 'number'
  | 'comment'
  | 'variable'
  | 'operator'
  | 'plain'
  | 'diff-add'
  | 'diff-del'
  | 'diff-hunk'
  | 'diff-meta';

const CAT_TOKEN: Record<Category, TokenName> = {
  keyword: 'accent.primary',
  type: 'accent.secondary',
  function: 'accent.link',
  string: 'state.success',
  property: 'accent.link',
  number: 'accent.secondary',
  comment: 'fg.dim',
  variable: 'accent.secondary',
  operator: 'fg.muted',
  plain: 'fg.secondary',
  'diff-add': 'state.success',
  'diff-del': 'state.error',
  'diff-hunk': 'accent.link',
  'diff-meta': 'fg.dim',
};

/**
 * Style `text` such that each space-delimited word is independently wrapped
 * in a balanced colour/RESET pair (invariant #2). Spaces themselves stay
 * unstyled, so runs of spaces and the exact column count are preserved.
 */
function styleSpan(theme: Theme, token: TokenName, text: string): string {
  if (text.indexOf(' ') === -1) return theme.style(token, text);
  return text
    .split(' ')
    .map((part) => (part === '' ? '' : theme.style(token, part)))
    .join(' ');
}

// ── Language specs ──────────────────────────────────────────────────

interface StringSpec {
  open: string;
  close: string;
  /** String may span newlines (template literals, triple-quoted). */
  multiline?: boolean;
  /** Backslash escapes the next char. */
  escape?: boolean;
}

interface LangSpec {
  keywords: Set<string>;
  /** Built-in types / well-known globals — rendered as `type`. */
  builtins?: Set<string>;
  /** Ordered longest-open-first so e.g. `"""` wins over `"`. */
  strings: StringSpec[];
  lineComment?: string[];
  blockComment?: [string, string];
  /** Variable sigil (`$` in shell) → `variable`. */
  variableSigil?: string;
  /** A string immediately followed by `:` is a property key (JSON/objects). */
  propertyKeys?: boolean;
}

const set = (...words: string[]): Set<string> => new Set(words);

// JS/TS share one spec (TS keywords/types are a superset and harmless in JS).
const JS_SPEC: LangSpec = {
  keywords: set(
    'const',
    'let',
    'var',
    'function',
    'return',
    'if',
    'else',
    'for',
    'while',
    'do',
    'switch',
    'case',
    'break',
    'continue',
    'new',
    'delete',
    'typeof',
    'instanceof',
    'in',
    'of',
    'class',
    'extends',
    'super',
    'this',
    'import',
    'export',
    'from',
    'as',
    'default',
    'async',
    'await',
    'yield',
    'try',
    'catch',
    'finally',
    'throw',
    'void',
    'null',
    'undefined',
    'true',
    'false',
    'static',
    'get',
    'set',
    'public',
    'private',
    'protected',
    'readonly',
    'interface',
    'type',
    'enum',
    'namespace',
    'implements',
    'abstract',
    'declare',
    'satisfies',
    'keyof',
    'infer',
    'is',
    'with',
    'debugger',
  ),
  builtins: set(
    'string',
    'number',
    'boolean',
    'any',
    'unknown',
    'never',
    'object',
    'bigint',
    'symbol',
    'Array',
    'Promise',
    'Record',
    'Map',
    'Set',
    'Date',
    'RegExp',
    'Error',
    'Object',
    'JSON',
    'Math',
    'Symbol',
    'WeakMap',
    'WeakSet',
    'Partial',
    'Readonly',
    'Pick',
    'Omit',
    'ReturnType',
    'console',
  ),
  strings: [
    { open: '`', close: '`', multiline: true, escape: true },
    { open: "'", close: "'", escape: true },
    { open: '"', close: '"', escape: true },
  ],
  lineComment: ['//'],
  blockComment: ['/*', '*/'],
};

const PYTHON_SPEC: LangSpec = {
  keywords: set(
    'def',
    'class',
    'return',
    'if',
    'elif',
    'else',
    'for',
    'while',
    'in',
    'is',
    'not',
    'and',
    'or',
    'pass',
    'break',
    'continue',
    'import',
    'from',
    'as',
    'with',
    'try',
    'except',
    'finally',
    'raise',
    'yield',
    'lambda',
    'global',
    'nonlocal',
    'del',
    'assert',
    'async',
    'await',
    'None',
    'True',
    'False',
    'match',
    'case',
  ),
  builtins: set(
    'print',
    'len',
    'range',
    'int',
    'str',
    'float',
    'bool',
    'list',
    'dict',
    'set',
    'tuple',
    'self',
    'cls',
    'super',
    'open',
    'enumerate',
    'zip',
    'map',
    'filter',
    'sorted',
    'type',
    'isinstance',
    'Exception',
  ),
  strings: [
    { open: '"""', close: '"""', multiline: true, escape: true },
    { open: "'''", close: "'''", multiline: true, escape: true },
    { open: "'", close: "'", escape: true },
    { open: '"', close: '"', escape: true },
  ],
  lineComment: ['#'],
};

const GO_SPEC: LangSpec = {
  keywords: set(
    'func',
    'package',
    'import',
    'var',
    'const',
    'type',
    'struct',
    'interface',
    'map',
    'chan',
    'go',
    'defer',
    'return',
    'if',
    'else',
    'for',
    'range',
    'switch',
    'case',
    'break',
    'continue',
    'default',
    'select',
    'fallthrough',
    'goto',
    'nil',
    'true',
    'false',
    'iota',
  ),
  builtins: set(
    'string',
    'int',
    'int8',
    'int16',
    'int32',
    'int64',
    'uint',
    'uint8',
    'uint16',
    'uint32',
    'uint64',
    'byte',
    'rune',
    'float32',
    'float64',
    'bool',
    'error',
    'make',
    'new',
    'len',
    'cap',
    'append',
    'copy',
    'delete',
    'panic',
    'recover',
    'print',
    'println',
  ),
  strings: [
    { open: '`', close: '`', multiline: true },
    { open: '"', close: '"', escape: true },
    { open: "'", close: "'", escape: true },
  ],
  lineComment: ['//'],
  blockComment: ['/*', '*/'],
};

const RUST_SPEC: LangSpec = {
  keywords: set(
    'fn',
    'let',
    'mut',
    'const',
    'static',
    'struct',
    'enum',
    'impl',
    'trait',
    'pub',
    'use',
    'mod',
    'match',
    'if',
    'else',
    'for',
    'while',
    'loop',
    'return',
    'self',
    'Self',
    'where',
    'as',
    'ref',
    'move',
    'dyn',
    'async',
    'await',
    'unsafe',
    'extern',
    'crate',
    'super',
    'in',
    'type',
    'true',
    'false',
    'break',
    'continue',
  ),
  builtins: set(
    'String',
    'str',
    'Vec',
    'Option',
    'Result',
    'Box',
    'Rc',
    'Arc',
    'i8',
    'i16',
    'i32',
    'i64',
    'i128',
    'u8',
    'u16',
    'u32',
    'u64',
    'u128',
    'usize',
    'isize',
    'f32',
    'f64',
    'bool',
    'char',
    'Some',
    'None',
    'Ok',
    'Err',
    'println',
    'print',
    'vec',
    'format',
    'panic',
  ),
  strings: [{ open: '"', close: '"', escape: true }],
  lineComment: ['//'],
  blockComment: ['/*', '*/'],
};

const SHELL_SPEC: LangSpec = {
  keywords: set(
    'if',
    'then',
    'else',
    'elif',
    'fi',
    'for',
    'while',
    'until',
    'do',
    'done',
    'case',
    'esac',
    'function',
    'in',
    'select',
    'return',
    'break',
    'continue',
    'local',
    'export',
    'readonly',
    'declare',
    'set',
    'unset',
    'shift',
    'trap',
    'exit',
    'source',
  ),
  builtins: set(
    'echo',
    'cd',
    'ls',
    'cat',
    'grep',
    'sed',
    'awk',
    'cp',
    'mv',
    'rm',
    'mkdir',
    'touch',
    'chmod',
    'curl',
    'wget',
    'git',
    'npm',
    'node',
    'sudo',
    'printf',
    'test',
    'read',
    'eval',
    'exec',
  ),
  strings: [
    { open: '"', close: '"', escape: true },
    { open: "'", close: "'" },
  ],
  lineComment: ['#'],
  variableSigil: '$',
};

const JSON_SPEC: LangSpec = {
  keywords: set('true', 'false', 'null'),
  strings: [{ open: '"', close: '"', escape: true }],
  propertyKeys: true,
};

const SPECS: Record<string, LangSpec> = {
  js: JS_SPEC,
  python: PYTHON_SPEC,
  go: GO_SPEC,
  rust: RUST_SPEC,
  shell: SHELL_SPEC,
  json: JSON_SPEC,
};

const ALIASES: Record<string, string> = {
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  javascript: 'js',
  ts: 'js',
  tsx: 'js',
  mts: 'js',
  cts: 'js',
  typescript: 'js',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  py: 'python',
  python: 'python',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shell: 'shell',
  console: 'shell',
  go: 'go',
  golang: 'go',
  rs: 'rust',
  rust: 'rust',
  diff: 'diff',
  patch: 'diff',
};

function resolveLang(lang: string): string | null {
  return ALIASES[(lang || '').toLowerCase().trim()] ?? null;
}

// ── Tokenizer ───────────────────────────────────────────────────────

interface Seg {
  cat: Category | 'raw';
  text: string;
}

const isIdentStart = (c: string): boolean => /[A-Za-z_$]/.test(c);
const isIdentPart = (c: string): boolean => /[A-Za-z0-9_$]/.test(c);
const isWs = (c: string): boolean => c === ' ' || c === '\t' || c === '\n' || c === '\r';

// Shell special parameters that are a single non-identifier char: $? $$ $! $# $@ $* $-.
// (Positional params like $1 and $name are handled by the isIdentPart scan instead.)
const SHELL_SPECIAL_PARAMS = '?$!#@*-';

function tokenize(code: string, spec: LangSpec): Seg[] {
  const segs: Seg[] = [];
  const n = code.length;
  let i = 0;

  const push = (cat: Category | 'raw', text: string): void => {
    if (text) segs.push({ cat, text });
  };

  while (i < n) {
    const c = code[i];

    // Whitespace (incl. newlines) is emitted raw so indentation and blank
    // lines survive untouched.
    if (isWs(c)) {
      let j = i;
      while (j < n && isWs(code[j])) j++;
      push('raw', code.slice(i, j));
      i = j;
      continue;
    }

    // Block comment.
    if (spec.blockComment && code.startsWith(spec.blockComment[0], i)) {
      const [open, close] = spec.blockComment;
      const end = code.indexOf(close, i + open.length);
      const stop = end === -1 ? n : end + close.length;
      push('comment', code.slice(i, stop));
      i = stop;
      continue;
    }

    // Line comment.
    if (spec.lineComment) {
      let matched = false;
      for (const lc of spec.lineComment) {
        if (code.startsWith(lc, i)) {
          let j = i;
          while (j < n && code[j] !== '\n') j++;
          push('comment', code.slice(i, j));
          i = j;
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }

    // String literal.
    let strMatched = false;
    for (const s of spec.strings) {
      if (!code.startsWith(s.open, i)) continue;
      let j = i + s.open.length;
      while (j < n) {
        if (s.escape && code[j] === '\\') {
          j += 2;
          continue;
        }
        if (code.startsWith(s.close, j)) {
          j += s.close.length;
          break;
        }
        if (!s.multiline && code[j] === '\n') break; // unterminated single-line
        j++;
      }
      const stop = Math.min(j, n);
      let cat: Category = 'string';
      if (spec.propertyKeys) {
        let k = stop;
        while (k < n && (code[k] === ' ' || code[k] === '\t')) k++;
        if (code[k] === ':') cat = 'property';
      }
      push(cat, code.slice(i, stop));
      i = stop;
      strMatched = true;
      break;
    }
    if (strMatched) continue;

    // Number (decimal, hex/oct/bin, separators).
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(code[i + 1] || ''))) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-FxXoObB._]/.test(code[j])) j++;
      push('number', code.slice(i, j));
      i = j;
      continue;
    }

    // Variable sigil: ${...}, $name, $1, and the SHELL_SPECIAL_PARAMS
    // single-char parameters.
    if (spec.variableSigil && c === spec.variableSigil) {
      let j = i + 1;
      if (code[j] === '{') {
        const end = code.indexOf('}', j);
        j = end === -1 ? n : end + 1;
      } else if (j < n && SHELL_SPECIAL_PARAMS.includes(code[j])) {
        j++;
      } else {
        while (j < n && isIdentPart(code[j])) j++;
      }
      push('variable', code.slice(i, j));
      i = j;
      continue;
    }

    // Identifier / keyword / builtin / function call.
    if (isIdentStart(c)) {
      let j = i;
      while (j < n && isIdentPart(code[j])) j++;
      const word = code.slice(i, j);
      let cat: Category;
      if (spec.keywords.has(word)) {
        cat = 'keyword';
      } else if (spec.builtins?.has(word)) {
        cat = 'type';
      } else {
        let k = j;
        while (k < n && (code[k] === ' ' || code[k] === '\t')) k++;
        cat = code[k] === '(' ? 'function' : 'plain';
      }
      push(cat, word);
      i = j;
      continue;
    }

    // Anything else: a single punctuation/operator char.
    push('operator', c);
    i++;
  }

  return segs;
}

/**
 * Rebuild styled lines from segments. Splitting each segment on `\n` keeps
 * the line count identical to the input (one push per newline + a final
 * line) and re-applies the colour per line piece, so a multi-line string or
 * comment never leaks colour across the line boundary.
 */
function segsToLines(theme: Theme, segs: Seg[]): string[] {
  const lines: string[] = [];
  let cur = '';
  for (const seg of segs) {
    const parts = seg.text.split('\n');
    for (let p = 0; p < parts.length; p++) {
      if (p > 0) {
        lines.push(cur);
        cur = '';
      }
      const piece = parts[p];
      if (!piece) continue;
      cur += seg.cat === 'raw' ? piece : styleSpan(theme, CAT_TOKEN[seg.cat], piece);
    }
  }
  lines.push(cur);
  return lines;
}

// ── Diff highlighting ───────────────────────────────────────────────

function highlightDiff(theme: Theme, code: string): string[] {
  return code.split('\n').map((line) => {
    if (line === '') return '';
    let cat: Category;
    if (line.startsWith('@@')) {
      cat = 'diff-hunk';
    } else if (/^(\+\+\+|---|diff |index |new file|deleted file|rename |similarity )/.test(line)) {
      cat = 'diff-meta';
    } else if (line[0] === '+') {
      cat = 'diff-add';
    } else if (line[0] === '-') {
      cat = 'diff-del';
    } else {
      cat = 'plain';
    }
    return styleSpan(theme, CAT_TOKEN[cat], line);
  });
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Highlight `code` for `lang`, returning one display string per input line
 * (line count is always preserved). Unknown languages fall back to the plain
 * `fg.secondary` look used before highlighting existed. `tier: 'none'`
 * returns the input verbatim.
 */
export function highlightCode(theme: Theme, code: string, lang: string): string[] {
  if (theme.tier === 'none') return code.split('\n');

  const key = resolveLang(lang);
  if (key === 'diff') return highlightDiff(theme, code);

  const spec = key ? SPECS[key] : null;
  if (!spec) {
    return code.split('\n').map((l) => (l === '' ? '' : styleSpan(theme, 'fg.secondary', l)));
  }

  return segsToLines(theme, tokenize(code, spec));
}

/** Languages with a dedicated lexer (plus `diff`). Exposed for tests/introspection. */
export function supportedHighlightLangs(): string[] {
  return [...Object.keys(SPECS), 'diff'];
}

// ── Silvery span emitter ────────────────────────────────────────────
//
// The retained-mode TUI (`cli/silvery/`) does not consume ANSI strings — its
// compositor paints from a component tree, so it needs a COLOR per token, not
// an escape sequence, exactly as `verbShimmerColors` returns colors rather than
// SGR codes. The lexer above (`tokenize` / `SPECS` / `resolveLang` / the diff
// categorization) is pure and reused verbatim; only the sink differs.

/** One colored run within a highlighted code line. Colors are raw hex, which
 *  silvery's `resolveThemeColor` passes straight through (non-`$` values). */
export interface CodeSpan {
  text: string;
  color: string;
}

/**
 * Fixed syntax palette for code fences — a deliberate carve-out of Visual
 * Language v2 law 2 (one accent).
 *
 * The rest of the TUI is grayscale + one accent because color there is CHROME,
 * and chrome that shouts competes with the work. Inside a code fence, color is
 * INFORMATION: distinguishing a string from a keyword from a comment is the
 * whole point of highlighting, and brightness alone (which is all law 2 would
 * allow) can't carry six token categories legibly. So a fence gets its own
 * small palette — and "small" and "desaturated" are the discipline that keeps
 * this from becoming a rainbow that fights Push's severe canvas. These are
 * tinted grays, not primaries: each hue is low-saturation and mid-light so it
 * reads as "quiet syntax color" on `#0a0a0a`, not an editor theme.
 *
 * Deliberately theme-INDEPENDENT: a token's category is a fact about the code,
 * not about the user's accent choice, so it must not shift when the accent hue
 * changes. The accent stays reserved for "where the action is" (cursor,
 * selection); code speaks its own quiet language.
 */
const SYNTAX_PALETTE: Record<Category, string> = {
  keyword: '#c9a3c4', // muted mauve — declarations / control flow
  type: '#9db8c9', // steel blue
  function: '#b3c1d4', // soft slate — callables
  string: '#a6c398', // sage
  property: '#cdbb9a', // sand
  number: '#d4b483', // amber
  comment: '#6b6b6b', // dim — recedes, like fg.dim
  variable: '#c4c4c4', // light gray
  operator: '#8a8a8a', // muted gray
  plain: '#bdbdbd', // secondary gray
  'diff-add': '#a6c398', // sage (= string)
  'diff-del': '#d19c9c', // muted rose — softer than the fault red, which law 3 reserves
  'diff-hunk': '#9db8c9', // steel (= type)
  'diff-meta': '#6b6b6b', // dim
};

/** Split tokenizer output into per-line span arrays. Mirrors `segsToLines`,
 *  but carries a color per run instead of wrapping each in ANSI. */
function segsToSpanLines(segs: Seg[]): CodeSpan[][] {
  const lines: CodeSpan[][] = [];
  let cur: CodeSpan[] = [];
  for (const seg of segs) {
    const parts = seg.text.split('\n');
    for (let p = 0; p < parts.length; p++) {
      if (p > 0) {
        lines.push(cur);
        cur = [];
      }
      const piece = parts[p];
      if (!piece) continue;
      const cat: Category = seg.cat === 'raw' ? 'plain' : seg.cat;
      cur.push({ text: piece, color: SYNTAX_PALETTE[cat] });
    }
  }
  lines.push(cur);
  return lines;
}

/** Diff categorization as spans. Mirrors `highlightDiff`. */
function diffToSpanLines(code: string): CodeSpan[][] {
  return code.split('\n').map((line) => {
    if (line === '') return [];
    let cat: Category;
    if (line.startsWith('@@')) {
      cat = 'diff-hunk';
    } else if (/^(\+\+\+|---|diff |index |new file|deleted file|rename |similarity )/.test(line)) {
      cat = 'diff-meta';
    } else if (line[0] === '+') {
      cat = 'diff-add';
    } else if (line[0] === '-') {
      cat = 'diff-del';
    } else {
      cat = 'plain';
    }
    return [{ text: line, color: SYNTAX_PALETTE[cat] }];
  });
}

/**
 * Highlight `code` into per-line colored spans for the silvery renderer.
 *
 * Returns `null` when the language has no lexer, so the caller keeps its
 * existing flat-muted rendering rather than this module inventing a fallback
 * look (the ANSI `highlightCode` styles unknown langs `fg.secondary`; here the
 * caller already owns that case). Line count is preserved: `result.length` ===
 * `code.split('\n').length`, so a caller zipping spans onto source lines stays
 * aligned.
 */
export function highlightToSpans(code: string, lang: string): CodeSpan[][] | null {
  const key = resolveLang(lang);
  if (!key) return null;
  if (key === 'diff') return diffToSpanLines(code);
  const spec = SPECS[key];
  if (!spec) return null;
  return segsToSpanLines(tokenize(code, spec));
}
