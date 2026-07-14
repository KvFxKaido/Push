/**
 * Stream markdown pass (#1432) + emoji strip (#1433) — pure parse layer.
 * Source: docs/cli/design/TUI Visual Language v2.md laws 1–2.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseInline, parseMarkdown, stripDecorativeEmoji } from '../silvery/markdown.tsx';

describe('stripDecorativeEmoji (#1433 / law 2)', () => {
  it('strips pictographs and collapses the internal orphaned space', () => {
    assert.equal(stripDecorativeEmoji('opened 👉 the PR'), 'opened the PR');
    assert.equal(stripDecorativeEmoji('Done ✅ shipping'), 'Done shipping');
    assert.equal(stripDecorativeEmoji('nice 🎉🎉 work'), 'nice work');
  });

  it('strips ZWJ sequences, skin tones, and flags as one unit', () => {
    assert.equal(stripDecorativeEmoji('team 👩‍💻 here'), 'team here');
    assert.equal(stripDecorativeEmoji('wave 👋🏽 back'), 'wave back');
    assert.equal(stripDecorativeEmoji('the 🇺🇸 flag'), 'the flag');
  });

  it('leaves edge whitespace for parseInline to trim (per-span contract)', () => {
    // Edge trimming is the line owner's job — the function only collapses runs.
    assert.equal(stripDecorativeEmoji('PR 👉'), 'PR ');
  });

  it('leaves prose and code punctuation untouched (fast path)', () => {
    const plain = 'const x = arr.map((a) => a * 2); // ok';
    assert.equal(stripDecorativeEmoji(plain), plain);
    assert.equal(stripDecorativeEmoji(''), '');
  });

  it('never eats Push chrome glyphs (geometric, not pictographic)', () => {
    assert.equal(stripDecorativeEmoji('• · ⬡ ⬢ ░▒▓█'), '• · ⬡ ⬢ ░▒▓█');
  });

  it('keeps text-presentation symbols (arrows, ▶, ✓) — only emoji get stripped', () => {
    // Extended_Pictographic but NOT Emoji_Presentation: meaningful prose, kept.
    assert.equal(
      stripDecorativeEmoji('maps a ↔ b, returns ↩, then ➡ next'),
      'maps a ↔ b, returns ↩, then ➡ next',
    );
    assert.equal(stripDecorativeEmoji('press ▶ to play ✓ done'), 'press ▶ to play ✓ done');
  });

  it('strips a pictograph forced to emoji with VS16, keeps its bare form', () => {
    assert.equal(stripDecorativeEmoji('go ➡️ there'), 'go there');
    assert.equal(stripDecorativeEmoji('go ➡ there'), 'go ➡ there');
    assert.equal(stripDecorativeEmoji('hit ▶️ now'), 'hit now');
  });

  it('strips keycap sequences (digit/#/* + VS16 + U+20E3)', () => {
    assert.equal(stripDecorativeEmoji('step 1️⃣ then 2️⃣ go'), 'step then go');
    assert.equal(stripDecorativeEmoji('press #️⃣ key'), 'press key');
  });
});

describe('parseInline (law 2 span budget)', () => {
  it('marks bold, italic, and inline code', () => {
    assert.deepEqual(parseInline('a **b** c'), [
      { text: 'a ' },
      { text: 'b', bold: true },
      { text: ' c' },
    ]);
    assert.deepEqual(parseInline('run `git push` now'), [
      { text: 'run ' },
      { text: 'git push', code: true },
      { text: ' now' },
    ]);
    assert.deepEqual(parseInline('*emphasis*'), [{ text: 'emphasis', italic: true }]);
  });

  it('longest emphasis wins: *** before ** before *', () => {
    assert.deepEqual(parseInline('***both***'), [{ text: 'both', bold: true, italic: true }]);
    assert.deepEqual(parseInline('**b** and *i*'), [
      { text: 'b', bold: true },
      { text: ' and ' },
      { text: 'i', italic: true },
    ]);
  });

  it('keeps a link label as accent and carries the url', () => {
    assert.deepEqual(parseInline('see [PR #1431](https://x/1431) merged'), [
      { text: 'see ' },
      { text: 'PR #1431', link: true, url: 'https://x/1431' },
      { text: ' merged' },
    ]);
  });

  it('does not treat snake_case or bare underscores as emphasis', () => {
    assert.deepEqual(parseInline('call foo_bar_baz and __init__'), [
      { text: 'call foo_bar_baz and __init__' },
    ]);
  });

  it('preserves code content verbatim (no emoji strip inside code)', () => {
    assert.deepEqual(parseInline('`echo 🎉`'), [{ text: 'echo 🎉', code: true }]);
  });

  it('strips emoji from plain runs', () => {
    assert.deepEqual(parseInline('ok 👍 done'), [{ text: 'ok done' }]);
  });

  it('trims the space an edge emoji orphans, keeping inter-span spacing', () => {
    assert.deepEqual(parseInline('shipped it 🎉'), [{ text: 'shipped it' }]);
    assert.deepEqual(parseInline('🎉 shipped'), [{ text: 'shipped' }]);
    // Emoji between a plain run and a styled span keeps the connecting space.
    assert.deepEqual(parseInline('done 👉 **now**'), [
      { text: 'done ' },
      { text: 'now', bold: true },
    ]);
  });

  it('a pure-emoji line survives as an empty span (row/height preserved)', () => {
    assert.deepEqual(parseInline('🎉'), [{ text: '' }]);
  });

  it('preserves leading/trailing whitespace when no emoji was removed', () => {
    // Indented non-fenced content (stack traces, ASCII tables) keeps alignment.
    assert.deepEqual(parseInline('    indented line'), [{ text: '    indented line' }]);
    assert.deepEqual(parseInline('col1    col2    '), [{ text: 'col1    col2    ' }]);
  });
});

describe('parseMarkdown (law 1 — line-oriented, count preserved)', () => {
  it('produces exactly one MdLine per source line', () => {
    const text = '# Title\n\nbody line\n- item\n1. step\n> quote\n\n```ts\ncode();\n```';
    const lines = parseMarkdown(text);
    assert.equal(lines.length, text.split('\n').length);
  });

  it('classifies headings, lists, quotes, and rules', () => {
    assert.equal(parseMarkdown('## Heading')[0].kind, 'heading');
    assert.equal(parseMarkdown('- a')[0].kind, 'bullet');
    assert.equal(parseMarkdown('3) third')[0].kind, 'ordered');
    assert.equal(parseMarkdown('> quoted')[0].kind, 'quote');
    assert.equal(parseMarkdown('---')[0].kind, 'hr');
    assert.equal(parseMarkdown('')[0].kind, 'blank');
  });

  it('renders fenced blocks verbatim with dimmed fences', () => {
    const lines = parseMarkdown('```js\nconst x = 1;\n```');
    assert.equal(lines[0].kind, 'fence');
    assert.equal(lines[0].lang, 'js');
    assert.equal(lines[1].kind, 'code');
    assert.equal(lines[1].raw, 'const x = 1;');
    assert.equal(lines[2].kind, 'fence');
    assert.equal(lines[2].lang, '');
  });

  it('does not parse markdown syntax inside a fence', () => {
    const lines = parseMarkdown('```\n**not bold**\n```');
    assert.equal(lines[1].kind, 'code');
    assert.equal(lines[1].raw, '**not bold**');
  });

  it('keeps a ```-prefixed info-string line inside a fence as verbatim code', () => {
    // Only a bare ``` closes; ```extra is code content, not a silent drop.
    const lines = parseMarkdown('```\ncode\n```extra\nstill code\n```');
    assert.equal(lines.length, 5);
    assert.equal(lines[2].kind, 'code');
    assert.equal(lines[2].raw, '```extra');
    assert.equal(lines[3].kind, 'code');
    assert.equal(lines[3].raw, 'still code');
    assert.equal(lines[4].kind, 'fence'); // the real close
  });

  it('normalizes CRLF: one row per line, no stray carriage return', () => {
    const lines = parseMarkdown('one\r\ntwo\r\n```\r\ncode\r\n```');
    assert.equal(lines.length, 5);
    assert.deepEqual(lines[0].spans, [{ text: 'one' }]);
    assert.equal(lines[3].kind, 'code');
    assert.equal(lines[3].raw, 'code'); // no trailing \r
  });

  it('sizes a horizontal rule to its source length (width-non-increasing)', () => {
    assert.equal(parseMarkdown('---')[0].raw, '---');
    assert.equal(parseMarkdown('-----')[0].raw, '-----');
    assert.equal(parseMarkdown('  ***  ')[0].raw, '***');
  });

  it('carries the ordered marker with its indent and number', () => {
    const [line] = parseMarkdown('  2. second');
    assert.equal(line.kind, 'ordered');
    assert.equal(line.marker, '  2. ');
    assert.deepEqual(line.spans, [{ text: 'second' }]);
  });
});
