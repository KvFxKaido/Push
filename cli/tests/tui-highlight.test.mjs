/**
 * tui-highlight.test.mjs — Syntax highlighter invariants.
 *
 * The highlighter feeds the synchronous framer render path, so its three
 * contracts (width-preserving, wrap-safe, tier-agnostic) are the regression
 * net here. If any of them breaks the transcript layout/colour math breaks
 * with it, so these are pinned rather than snapshotted.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { highlightCode, highlightToSpans, supportedHighlightLangs } from '../tui-highlight.ts';
import { createTheme } from '../tui-theme.ts';
import { stripAnsi } from '../tui-renderer.ts';

const colored = () => createTheme({ tier: 'truecolor', unicode: true, name: 'default' });
const none = () => createTheme({ tier: 'none', unicode: true, name: 'default' });

const SAMPLES = {
  js: `const x = 1; // count\nfunction greet(name) {\n  return \`hi \${name}\`;\n}`,
  python: `def greet(name):\n    """multi\n    line"""\n    return f"hi {name}"  # comment`,
  go: `package main\nfunc main() {\n\tx := 42\n\treturn\n}`,
  rust: `fn main() {\n    let mut v: Vec<i32> = vec![1, 2];\n}`,
  shell: `#!/bin/bash\nfor f in *.ts; do\n  echo "$f \${HOME}"\n  echo $? $$ $@ $1\ndone`,
  json: `{\n  "tool": "Read",\n  "n": 42,\n  "ok": true\n}`,
};

describe('highlightCode: width-preserving (invariant #1)', () => {
  for (const [lang, code] of Object.entries(SAMPLES)) {
    it(`${lang}: stripAnsi round-trips to the input`, () => {
      const out = highlightCode(colored(), code, lang).join('\n');
      assert.equal(stripAnsi(out), code);
    });
  }

  it('diff: stripAnsi round-trips to the input', () => {
    const diff = `diff --git a/x b/x\n@@ -1 +1 @@\n-old line\n+new line\n unchanged`;
    const out = highlightCode(colored(), diff, 'diff').join('\n');
    assert.equal(stripAnsi(out), diff);
  });

  it('unknown language: stripAnsi round-trips to the input', () => {
    const code = 'some arbitrary !@# text\nsecond line';
    const out = highlightCode(colored(), code, 'brainfuck').join('\n');
    assert.equal(stripAnsi(out), code);
  });
});

describe('highlightCode: line count is preserved', () => {
  for (const [lang, code] of Object.entries(SAMPLES)) {
    it(`${lang}: output line count matches input`, () => {
      assert.equal(highlightCode(colored(), code, lang).length, code.split('\n').length);
    });
  }

  it('preserves leading/trailing blank lines', () => {
    const code = '\nconst x = 1;\n\n';
    assert.equal(highlightCode(colored(), code, 'js').length, code.split('\n').length);
  });
});

describe('highlightCode: wrap-safe — balanced ANSI per word (invariant #2)', () => {
  const SET_SGR = /\x1b\[(?!0m)[0-9;]*m/; // an SGR that is not the reset
  const RESET = '\x1b[0m';

  for (const [lang, code] of Object.entries(SAMPLES)) {
    it(`${lang}: every space-delimited word that opens a colour also closes it`, () => {
      for (const line of highlightCode(colored(), code, lang)) {
        for (const word of line.split(' ')) {
          if (SET_SGR.test(word)) {
            assert.ok(
              word.includes(RESET),
              `word opened a colour without a reset: ${JSON.stringify(word)}`,
            );
          }
        }
      }
    });
  }
});

describe('highlightCode: tier-agnostic (invariant #3)', () => {
  it('tier:none returns the input verbatim (keeps framer goldens stable)', () => {
    for (const [lang, code] of Object.entries(SAMPLES)) {
      assert.deepEqual(highlightCode(none(), code, lang), code.split('\n'));
    }
    assert.deepEqual(highlightCode(none(), 'const x = 1;', 'js'), ['const x = 1;']);
  });

  it('coloured tier actually emits ANSI', () => {
    const out = highlightCode(colored(), 'const x = 1;', 'js').join('\n');
    assert.notEqual(out, 'const x = 1;');
    assert.ok(out.includes('\x1b['));
  });
});

describe('highlightCode: category colouring', () => {
  const theme = colored();
  const styled = (token, text) => theme.style(token, text);

  it('js keyword → accent.primary, string → state.success', () => {
    const out = highlightCode(theme, 'const s = "hi";', 'js').join('\n');
    assert.ok(out.includes(styled('accent.primary', 'const')), 'keyword coloured');
    assert.ok(out.includes(styled('state.success', '"hi"')), 'string coloured');
  });

  it('shell variables (special, positional, braced) are each a single token', () => {
    const out = highlightCode(theme, 'echo $? $$ $@ $! $# $1 ${HOME}', 'shell').join('\n');
    for (const v of ['$?', '$$', '$@', '$!', '$#', '$1', '${HOME}']) {
      assert.ok(out.includes(styled('accent.secondary', v)), `expected ${v} as one variable token`);
    }
  });

  it('diff +/- lines → success/error, @@ → link', () => {
    const lines = highlightCode(theme, '@@ -1 +1 @@\n-gone\n+added', 'diff');
    assert.ok(lines[1].includes(styled('state.error', '-gone')), 'removal red');
    assert.ok(lines[2].includes(styled('state.success', '+added')), 'addition green');
    assert.ok(lines[0].includes('\x1b['), 'hunk header coloured');
  });

  it('json property key (string before colon) differs from string value', () => {
    const out = highlightCode(theme, '{"tool": "Read"}', 'json').join('\n');
    assert.ok(out.includes(styled('accent.link', '"tool":')) === false, 'colon stays unstyled');
    assert.ok(out.includes(styled('accent.link', '"tool"')), 'key uses property colour');
    assert.ok(out.includes(styled('state.success', '"Read"')), 'value uses string colour');
  });
});

describe('supportedHighlightLangs', () => {
  it('lists the lexer languages plus diff', () => {
    const langs = supportedHighlightLangs();
    for (const expected of ['js', 'python', 'go', 'rust', 'shell', 'json', 'diff']) {
      assert.ok(langs.includes(expected), `missing ${expected}`);
    }
  });
});

describe('highlightToSpans: silvery span emitter', () => {
  const langs = ['ts', 'python', 'go', 'rust', 'shell', 'json', 'diff'];
  const sample = {
    ts: 'const greet = (n: string) => {\n  // hi\n  return `x ${n}`;\n};',
    python: 'def add(a, b):\n    # sum\n    return a + b',
    go: 'func main() {\n\tx := 42 // n\n\tfmt.Println("hi")\n}',
    rust: 'fn main() {\n    let x = 42; // n\n}',
    shell: '# comment\necho "hello" | grep x',
    json: '{"key": "value", "n": 42, "ok": true}',
    diff: '@@ -1,2 +1,2 @@\n-old\n+new\n ctx',
  };

  it('preserves every character — concat(spans) === source line (width invariant)', () => {
    // The one invariant that cannot regress: a highlighted line must be
    // byte-identical to its source, or the retained layout math (which counts
    // visible width) desyncs and the fence shears. Checked per line, per lang.
    for (const lang of langs) {
      const code = sample[lang];
      const spanLines = highlightToSpans(code, lang);
      assert.ok(spanLines, `${lang}: expected spans`);
      const src = code.split('\n');
      assert.equal(spanLines.length, src.length, `${lang}: line count preserved`);
      for (let i = 0; i < src.length; i += 1) {
        const recon = (spanLines[i] ?? []).map((sp) => sp.text).join('');
        assert.equal(recon, src[i], `${lang} line ${i}: span concat must equal source`);
      }
    }
  });

  it('returns null for an unknown language, so the caller renders flat', () => {
    assert.equal(highlightToSpans('x = 1', 'brainfuck'), null);
    assert.equal(highlightToSpans('x = 1', ''), null);
  });

  it('colors the core categories distinctly (keyword / string / comment / number)', () => {
    const spans = highlightToSpans('const n = 42; // note', 'ts').flat();
    const colorOf = (text) => spans.find((sp) => sp.text === text)?.color;
    const keyword = colorOf('const');
    const number = colorOf('42');
    const comment = spans.find((sp) => sp.text.includes('note'))?.color;
    const str = highlightToSpans('const s = "hi"', 'ts')
      .flat()
      .find((sp) => sp.text === '"hi"')?.color;
    for (const [name, c] of [
      ['keyword', keyword],
      ['number', number],
      ['comment', comment],
      ['string', str],
    ]) {
      assert.match(c ?? '', /^#[0-9a-f]{6}$/, `${name} should have a hex color`);
    }
    // Distinct categories must not collapse to one color, or highlighting is decorative.
    assert.equal(new Set([keyword, number, comment, str]).size, 4, 'four categories, four colors');
  });

  it('reuses the same language set as the ANSI highlighter', () => {
    for (const lang of supportedHighlightLangs()) {
      assert.ok(highlightToSpans('x', lang) !== null, `${lang} should highlight to spans`);
    }
  });

  it('carries the diff signal (add / del / hunk on distinct colors)', () => {
    const [hunk, del, add] = highlightToSpans('@@ -1 +1 @@\n-a\n+b', 'diff');
    assert.equal(new Set([hunk[0].color, del[0].color, add[0].color]).size, 3);
  });
});
