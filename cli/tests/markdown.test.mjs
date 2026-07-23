/**
 * Stream markdown pass (#1432) + emoji strip (#1433) — pure parse layer.
 * Source: docs/cli/design/TUI Visual Language v2.md laws 1–2.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import React from 'react';
import { displayWidth, parseAnsiText, renderStatic, stripAnsi } from 'silvery';

import {
  MarkdownBody,
  parseInline,
  parseMarkdown,
  stripDecorativeEmoji,
} from '../silvery/markdown.tsx';
import { PushThemeProvider } from '../silvery/theme.tsx';

async function renderMarkdownBodyRaw(text, availableWidth, streaming = false, unicode = true) {
  const previousLang = process.env.LANG;
  const previousTermProgram = process.env.TERM_PROGRAM;
  const previousWtSession = process.env.WT_SESSION;
  process.env.LANG = unicode ? 'C.UTF-8' : 'C';
  if (!unicode) {
    delete process.env.TERM_PROGRAM;
    delete process.env.WT_SESSION;
  }
  try {
    return await renderStatic(
      React.createElement(
        PushThemeProvider,
        { themeName: 'default' },
        React.createElement(MarkdownBody, { text, availableWidth, streaming }),
      ),
      { width: 80, height: 12 },
    );
  } finally {
    if (previousLang === undefined) delete process.env.LANG;
    else process.env.LANG = previousLang;
    if (previousTermProgram === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = previousTermProgram;
    if (previousWtSession === undefined) delete process.env.WT_SESSION;
    else process.env.WT_SESSION = previousWtSession;
  }
}

function renderedText(raw) {
  return stripAnsi(raw)
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trimEnd();
}

async function renderMarkdownBody(text, availableWidth, streaming = false) {
  return renderedText(await renderMarkdownBodyRaw(text, availableWidth, streaming));
}

async function renderMarkdownBodyAscii(text, availableWidth, streaming = false) {
  return renderedText(await renderMarkdownBodyRaw(text, availableWidth, streaming, false));
}

async function renderPrefixes(source, unicode = true) {
  const outputs = [];
  for (let end = 1; end <= source.length; end += 1) {
    outputs.push(
      renderedText(await renderMarkdownBodyRaw(source.slice(0, end), 80, true, unicode)),
    );
  }
  return outputs;
}

function assertNoMarkerUnhide(source, outputs, markerPattern) {
  let hiddenMarkers = 0;
  for (let index = 0; index < outputs.length; index += 1) {
    const sourceCount = [...source.slice(0, index + 1)].filter((char) =>
      markerPattern.test(char),
    ).length;
    const outputCount = [...outputs[index]].filter((char) => markerPattern.test(char)).length;
    const nextHiddenMarkers = sourceCount - outputCount;
    assert.ok(nextHiddenMarkers >= hiddenMarkers, `markers reappeared at prefix ${index + 1}`);
    hiddenMarkers = nextHiddenMarkers;
  }
}

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
    for (const chrome of ['▪ ▫ ⬡ ⬢ ░▒▓█', '▪\uFE0E ▫\uFE0E ⬡ ⬢ ░▒▓█']) {
      assert.equal(stripDecorativeEmoji(chrome), chrome);
    }
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

  it('marks GFM strikethrough without changing the text payload', () => {
    assert.deepEqual(parseInline('ship ~~later~~ now'), [
      { text: 'ship ' },
      { text: 'later', strike: true },
      { text: ' now' },
    ]);
  });

  it('keeps a link label as accent and carries the url', () => {
    assert.deepEqual(parseInline('see [PR #1431](https://x/1431) merged'), [
      { text: 'see ' },
      { text: 'PR #1431', link: true, url: 'https://x/1431' },
      { text: ' merged' },
    ]);
  });

  it('recognizes an image before ordinary link syntax and keeps its alt fallback', () => {
    assert.deepEqual(parseInline('see ![architecture](https://x/diagram.png) here'), [
      { text: 'see ' },
      { text: 'architecture', image: true, url: 'https://x/diagram.png' },
      { text: ' here' },
    ]);
  });

  it('keeps balanced and escaped parentheses in link and image destinations', () => {
    assert.deepEqual(parseInline('[wiki](https://x/Function_(mathematics))'), [
      { text: 'wiki', link: true, url: 'https://x/Function_(mathematics)' },
    ]);
    assert.deepEqual(parseInline('[wiki](https://x/Function_\\(mathematics\\))'), [
      { text: 'wiki', link: true, url: 'https://x/Function_(mathematics)' },
    ]);
    assert.deepEqual(parseInline('![](https://x/Figure_(one).png)'), [
      { text: '', image: true, url: 'https://x/Figure_(one).png' },
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

  it('repairs supported half-open inline syntax only for a streaming tail', () => {
    assert.deepEqual(parseInline('This is **bold', { streamingTail: true }), [
      { text: 'This is ' },
      { text: 'bold', bold: true },
    ]);
    assert.deepEqual(parseInline('Run `npm test', { streamingTail: true }), [
      { text: 'Run ' },
      { text: 'npm test', code: true },
    ]);
    assert.deepEqual(parseInline('***both', { streamingTail: true }), [
      { text: 'both', bold: true, italic: true },
    ]);
    assert.deepEqual(parseInline('*italic', { streamingTail: true }), [
      { text: 'italic', italic: true },
    ]);
    assert.deepEqual(parseInline('Ship ~~later', { streamingTail: true }), [
      { text: 'Ship ' },
      { text: 'later', strike: true },
    ]);
  });

  it('preserves the opened style kind while a closing delimiter arrives', () => {
    assert.deepEqual(parseInline('**bold*', { streamingTail: true }), [
      { text: 'bold', bold: true },
    ]);
    assert.deepEqual(parseInline('***both**', { streamingTail: true }), [
      { text: 'both', bold: true, italic: true },
    ]);
    assert.deepEqual(parseInline('*hello ', { streamingTail: true }), [
      { text: 'hello ', italic: true },
    ]);
    assert.deepEqual(parseInline('~~later~', { streamingTail: true }), [
      { text: 'later', strike: true },
    ]);
  });

  it('renders an incomplete link as label text without a partial destination', () => {
    assert.deepEqual(parseInline('See [Push](https://exam', { streamingTail: true }), [
      { text: 'See ' },
      { text: 'Push' },
    ]);
    // Image syntax is not link syntax; leave the partial source lossless.
    assert.deepEqual(parseInline('![alt](https://exam', { streamingTail: true }), [
      { text: '![alt](https://exam' },
    ]);
  });

  it('does not reinterpret ambiguous asterisks as partial emphasis', () => {
    assert.deepEqual(parseInline('2 * 3', { streamingTail: true }), [{ text: '2 * 3' }]);
    assert.deepEqual(parseInline('2*3', { streamingTail: true }), [{ text: '2*3' }]);
    assert.deepEqual(parseInline('src/*', { streamingTail: true }), [{ text: 'src/*' }]);
    assert.deepEqual(parseInline('src/**generated', { streamingTail: true }), [
      { text: 'src/**generated' },
    ]);
  });
});

describe('MarkdownBody — terminal links', () => {
  it('carries a safe destination on both the label and visible URL', async () => {
    const raw = await renderMarkdownBodyRaw('[Push](https://push.local/docs)', 80);
    const linked = parseAnsiText(raw).filter((segment) => segment.hyperlink);
    assert.ok(linked.some((segment) => segment.text.includes('Push')));
    assert.ok(linked.some((segment) => segment.text.includes('https://push.local/docs')));
    assert.ok(linked.every((segment) => segment.hyperlink === 'https://push.local/docs'));
    assert.equal(stripAnsi(raw).trimEnd(), 'Push https://push.local/docs');
  });

  it('links the complete destination when its path contains balanced parentheses', async () => {
    const url = 'https://en.wikipedia.org/wiki/Function_(mathematics)';
    const raw = await renderMarkdownBodyRaw(`[wiki](${url})`, 80);
    const linked = parseAnsiText(raw).filter((segment) => segment.hyperlink);
    assert.ok(linked.some((segment) => segment.text.includes('wiki')));
    assert.ok(linked.some((segment) => segment.text.includes(url)));
    assert.ok(linked.every((segment) => segment.hyperlink === url));
    assert.equal(stripAnsi(raw).trimEnd(), `wiki ${url}`);
  });

  it('renders rejected destinations as inert but readable text', async () => {
    const raw = await renderMarkdownBodyRaw('[unsafe](javascript:alert)', 80);
    assert.equal(parseAnsiText(raw).filter((segment) => segment.hyperlink).length, 0);
    assert.equal(stripAnsi(raw).trimEnd(), 'unsafe javascript:alert');
  });

  it('renders image alt text and destination without a stray image marker', async () => {
    assert.equal(
      await renderMarkdownBody('![diagram](https://push.local/diagram.png)', 80),
      'diagram https://push.local/diagram.png',
    );
  });

  it('renders an empty-alt image as only its linked destination', async () => {
    const url = 'https://push.local/diagram.png';
    const raw = await renderMarkdownBodyRaw(`![](${url})`, 80);
    const linked = parseAnsiText(raw).filter((segment) => segment.hyperlink);
    assert.ok(linked.some((segment) => segment.text.includes(url)));
    assert.ok(linked.every((segment) => segment.hyperlink === url));
    assert.equal(stripAnsi(raw).trimEnd(), url);
  });
});

describe('parseMarkdown (law 1 — line-oriented, count preserved)', () => {
  it('produces exactly one MdLine per source line', () => {
    const text = '# Title\n\nbody line\n- item\n1. step\n> quote\n\n```ts\ncode();\n```';
    const lines = parseMarkdown(text);
    assert.equal(lines.length, text.split('\n').length);
  });

  it('classifies headings, lists, quotes, and rules', () => {
    for (let depth = 1; depth <= 6; depth += 1) {
      assert.deepEqual(parseMarkdown(`${'#'.repeat(depth)} Heading`)[0], {
        kind: 'heading',
        depth,
        spans: [{ text: 'Heading' }],
      });
    }
    assert.equal(parseMarkdown('- a')[0].kind, 'bullet');
    assert.equal(parseMarkdown('3) third')[0].kind, 'ordered');
    assert.equal(parseMarkdown('> quoted')[0].kind, 'quote');
    assert.equal(parseMarkdown('---')[0].kind, 'hr');
    assert.equal(parseMarkdown('')[0].kind, 'blank');
  });

  it('classifies GFM task-list state separately from ordinary bullet text', () => {
    const lines = parseMarkdown('- [ ] open\n- [x] done\n- [X] DONE\n- ordinary');
    assert.deepEqual(lines[0], {
      kind: 'bullet',
      marker: '',
      task: true,
      checked: false,
      spans: [{ text: 'open' }],
    });
    assert.deepEqual(lines[1], {
      kind: 'bullet',
      marker: '',
      task: true,
      checked: true,
      spans: [{ text: 'done' }],
    });
    assert.equal(lines[2].task, true);
    assert.equal(lines[2].checked, true);
    assert.equal(lines[3].task, undefined);
  });

  it('renders fenced blocks verbatim with themed fences', () => {
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

  it('repairs only the final line of a live message', () => {
    const lines = parseMarkdown('settled **open\nlive **tail', { streaming: true });
    assert.deepEqual(lines[0].spans, [{ text: 'settled **open' }]);
    assert.deepEqual(lines[1].spans, [{ text: 'live ' }, { text: 'tail', bold: true }]);
    assert.deepEqual(parseMarkdown('live **tail')[0].spans, [{ text: 'live **tail' }]);
  });

  it('waits for task-marker whitespace on the active final line', () => {
    const lines = parseMarkdown('- [x]\n- [X] ', { streaming: true });
    assert.equal(lines[0].task, undefined);
    assert.deepEqual(lines[0].spans, [{ text: '[x]' }]);
    assert.equal(lines[1].task, true);
    assert.equal(lines[1].checked, true);
    assert.deepEqual(lines[1].spans, [{ text: '' }]);

    const [settled] = parseMarkdown('- [X]');
    assert.equal(settled.task, undefined);
    assert.deepEqual(settled.spans, [{ text: '[X]' }]);
  });

  it('waits for heading whitespace on the active final line', () => {
    assert.deepEqual(parseMarkdown('#', { streaming: true })[0], {
      kind: 'text',
      spans: [{ text: '#' }],
    });
    assert.deepEqual(parseMarkdown('##', { streaming: true })[0], {
      kind: 'text',
      spans: [{ text: '##' }],
    });
    assert.deepEqual(parseMarkdown('## ', { streaming: true })[0], {
      kind: 'heading',
      depth: 2,
      spans: [{ text: '' }],
    });
    assert.deepEqual(parseMarkdown('## T', { streaming: true })[0], {
      kind: 'heading',
      depth: 2,
      spans: [{ text: 'T' }],
    });
    assert.deepEqual(parseMarkdown('#notag', { streaming: true })[0], {
      kind: 'text',
      spans: [{ text: '#notag' }],
    });
  });

  it('never repairs inside an unterminated fenced code block', () => {
    const lines = parseMarkdown('```ts\nconst label = "**open"', { streaming: true });
    assert.equal(lines[1].kind, 'code');
    assert.equal(lines[1].raw, 'const label = "**open"');
  });

  it('repairs the open final cell of a streaming table without changing row count', () => {
    const text = '| A | B |\n| --- | --- |\n| one | **two';
    const lines = parseMarkdown(text, { streaming: true });
    assert.equal(lines.length, text.split('\n').length);
    assert.deepEqual(lines[2].cells[1], [{ text: 'two', bold: true }]);

    const shortRow = parseMarkdown('| A | B | C |\n| --- | --- | --- |\n| one | **two', {
      streaming: true,
    });
    assert.deepEqual(shortRow[2].cells[1], [{ text: 'two', bold: true }]);
    assert.deepEqual(shortRow[2].cells[2], [{ text: '' }]);
  });
});

describe('MarkdownBody — semantic hierarchy', () => {
  it('renders all six heading levels distinctly in Unicode and ASCII', async () => {
    const source = Array.from({ length: 6 }, (_, index) => {
      const depth = index + 1;
      return `${'#'.repeat(depth)} H${depth}`;
    }).join('\n');
    const raw = await renderMarkdownBodyRaw(source, 80);
    assert.equal(
      renderedText(raw),
      '▌ H1\n ▌ H2\n  ▪\uFE0E H3\n   ▪\uFE0E H4\n    · H5\n     · H6',
    );
    assert.equal(await renderMarkdownBodyAscii(source, 80), source);

    const spans = parseAnsiText(raw);
    const headings = Array.from({ length: 6 }, (_, index) =>
      spans.find((span) => span.text.includes(`H${index + 1}`)),
    );
    for (const heading of headings.slice(0, 2)) {
      assert.equal(heading?.bold, true);
      assert.equal(heading?.underline, true);
      assert.notEqual(heading?.italic, true);
    }
    for (const heading of headings.slice(2, 4)) {
      assert.equal(heading?.bold, true);
      assert.notEqual(heading?.underline, true);
      assert.notEqual(heading?.italic, true);
    }
    for (const heading of headings.slice(4)) {
      assert.equal(heading?.italic, true);
      assert.notEqual(heading?.bold, true);
      assert.notEqual(heading?.underline, true);
    }
    assert.equal(headings[0]?.fg, headings[1]?.fg);
    assert.notEqual(headings[1]?.fg, headings[2]?.fg);
    assert.equal(headings[2]?.fg, headings[3]?.fg);
    assert.notEqual(headings[3]?.fg, headings[4]?.fg);
    assert.equal(headings[4]?.fg, headings[5]?.fg);
  });

  it('renders task state with a glyph and strikes completed text', async () => {
    const raw = await renderMarkdownBodyRaw(
      '- [ ] open\n- [x] done\n- [X] DONE\n~~superseded~~',
      80,
    );
    assert.equal(renderedText(raw), '☐\uFE0E open\n☑\uFE0E done\n☑\uFE0E DONE\nsuperseded');
    const spans = parseAnsiText(raw);
    assert.equal(spans.find((span) => span.text.includes('done'))?.strikethrough, true);
    assert.equal(spans.find((span) => span.text.includes('superseded'))?.strikethrough, true);
    assert.notEqual(
      spans.find((span) => span.text.includes('☐'))?.fg,
      spans.find((span) => span.text.includes('☑'))?.fg,
    );
  });

  it('falls back to ASCII task markers through the terminal unicode gate', async () => {
    assert.equal(
      await renderMarkdownBodyAscii('- [ ] open\n- [x] done\n- [X] DONE', 80),
      '[ ] open\n[x] done\n[x] DONE',
    );
  });

  it('uses separate semantic roles for links, code, and quote structure', async () => {
    const raw = await renderMarkdownBodyRaw(
      '[docs](https://push.local/docs) and `pnpm test`\n> quoted',
      80,
    );
    const spans = parseAnsiText(raw);
    const link = spans.find((span) => span.text.includes('docs'));
    const code = spans.find((span) => span.text.includes('pnpm test'));
    const quoteRail = spans.find((span) => span.text.includes('│'));
    const quote = spans.find((span) => span.text.includes('quoted'));
    assert.notEqual(link?.fg, code?.fg);
    assert.notEqual(code?.bg, link?.bg);
    assert.notEqual(quoteRail?.fg, quote?.fg);
  });

  it('never expands heading or task-list width beyond its Markdown source', async () => {
    for (const source of [
      ...Array.from({ length: 6 }, (_, index) => `${'#'.repeat(index + 1)} Heading`),
      '- [ ] open',
      '- [x] done',
    ]) {
      for (const unicode of [true, false]) {
        const rendered = renderedText(await renderMarkdownBodyRaw(source, 80, false, unicode));
        assert.ok(displayWidth(rendered) <= displayWidth(source), source);
      }
    }
  });
});

describe('MarkdownBody — streaming prefix contract', () => {
  it('hides half-open markers live but leaves the same malformed text literal when settled', async () => {
    assert.equal(await renderMarkdownBody('Use **bold', 80, true), 'Use bold');
    assert.equal(await renderMarkdownBody('Use **bold', 80), 'Use **bold');
    assert.equal(await renderMarkdownBody('See [Push](https://exam', 80, true), 'See Push');
    assert.equal(await renderMarkdownBody('Ship ~~later', 80, true), 'Ship later');
    assert.equal(await renderMarkdownBody('Ship ~~later', 80), 'Ship ~~later');
  });

  it('keeps partial closing delimiters hidden without changing style kind', async () => {
    assert.equal(await renderMarkdownBody('**bold*', 80, true), 'bold');
    assert.equal(await renderMarkdownBody('***both**', 80, true), 'both');
    assert.equal(await renderMarkdownBody('*hello ', 80, true), 'hello');
    assert.equal(await renderMarkdownBody('~~later~', 80, true), 'later');
  });

  it('keeps ambiguous strike and task prefixes literal until syntax is confirmed', async () => {
    const tripleTilde = await renderPrefixes('~~~a');
    assert.deepEqual(tripleTilde, ['~', '~~', '~~~', '~a']);
    assertNoMarkerUnhide('~~~a', tripleTilde, /~/);

    const bracketText = await renderPrefixes('- [d');
    assert.deepEqual(bracketText, ['-', '•', '• [', '• [d']);
    assertNoMarkerUnhide('- [d', bracketText, /[\[\]]/);

    const xylophone = await renderPrefixes('- [xylophone');
    assert.deepEqual(xylophone, [
      '-',
      '•',
      '• [',
      '• [x',
      '• [xy',
      '• [xyl',
      '• [xylo',
      '• [xylop',
      '• [xyloph',
      '• [xylopho',
      '• [xylophon',
      '• [xylophone',
    ]);
    assertNoMarkerUnhide('- [xylophone', xylophone, /[\[\]]/);

    const linkSource = '- [x](url)';
    const link = await renderPrefixes(linkSource);
    assert.deepEqual(link, [
      '-',
      '•',
      '• [',
      '• [x',
      '• [x]',
      '• x',
      '• x',
      '• x',
      '• x',
      '• x url',
    ]);
    assertNoMarkerUnhide(linkSource, link, /[\[\]]/);
    for (let end = 1; end <= linkSource.length; end += 1) {
      assert.notEqual(parseMarkdown(linkSource.slice(0, end), { streaming: true })[0].task, true);
    }

    const taskSource = '- [x] done';
    const task = await renderPrefixes(taskSource);
    assert.deepEqual(task, [
      '-',
      '•',
      '• [',
      '• [x',
      '• [x]',
      '☑\uFE0E',
      '☑\uFE0E d',
      '☑\uFE0E do',
      '☑\uFE0E don',
      '☑\uFE0E done',
    ]);
    assertNoMarkerUnhide(taskSource, task, /[\[\]]/);
    for (let end = 1; end <= taskSource.length; end += 1) {
      assert.equal(
        parseMarkdown(taskSource.slice(0, end), { streaming: true })[0].task === true,
        end >= 6,
      );
    }

    const taskAscii = await renderPrefixes(taskSource, false);
    assert.deepEqual(taskAscii, [
      '-',
      '-',
      '- [',
      '- [x',
      '- [x]',
      '[x]',
      '[x] d',
      '[x] do',
      '[x] don',
      '[x] done',
    ]);
    assertNoMarkerUnhide(taskSource, taskAscii, /[\[\]]/);
  });

  it('keeps ambiguous heading prefixes literal until whitespace confirms the block', async () => {
    const headingSource = '## T';
    const heading = await renderPrefixes(headingSource);
    assert.deepEqual(heading, ['#', '##', ' ▌', ' ▌ T']);
    assertNoMarkerUnhide(headingSource, heading, /#/);

    const headingAscii = await renderPrefixes(headingSource, false);
    assert.deepEqual(headingAscii, ['#', '##', '##', '## T']);
    assertNoMarkerUnhide(headingSource, headingAscii, /#/);

    const notHeadingSource = '#notag';
    const notHeading = await renderPrefixes(notHeadingSource);
    assert.deepEqual(notHeading, ['#', '#n', '#no', '#not', '#nota', '#notag']);
    assertNoMarkerUnhide(notHeadingSource, notHeading, /#/);
    for (let end = 1; end <= notHeadingSource.length; end += 1) {
      assert.equal(
        parseMarkdown(notHeadingSource.slice(0, end), { streaming: true })[0].kind,
        'text',
      );
    }
  });

  it('keeps every streamed heading prefix to one non-expanding row', async () => {
    const final = '###### Heading';
    for (let end = 1; end <= final.length; end += 1) {
      const prefix = final.slice(0, end);
      assert.equal(parseMarkdown(prefix, { streaming: true }).length, 1);
      for (const unicode of [true, false]) {
        const rendered = renderedText(await renderMarkdownBodyRaw(prefix, 80, true, unicode));
        assert.ok(
          displayWidth(rendered) <= displayWidth(prefix),
          `${JSON.stringify(prefix)} expanded to ${JSON.stringify(rendered)}`,
        );
      }
    }
  });

  it('keeps every task-list and strikethrough prefix sane without marker churn', async () => {
    for (const final of ['- [ ] task', '- [x] task', '- [X] task']) {
      const unicodeOutputs = [];
      const asciiOutputs = [];
      for (let end = 1; end <= final.length; end += 1) {
        const prefix = final.slice(0, end);
        assert.equal(parseMarkdown(prefix, { streaming: true }).length, 1);
        for (const unicode of [true, false]) {
          const raw = await renderMarkdownBodyRaw(prefix, 80, true, unicode);
          const rendered = renderedText(raw);
          (unicode ? unicodeOutputs : asciiOutputs).push(rendered);
          assert.ok(
            displayWidth(rendered) <= displayWidth(prefix),
            `${JSON.stringify(prefix)} expanded to ${JSON.stringify(rendered)}`,
          );
          if (unicode && end >= 6) {
            assert.doesNotMatch(rendered, /[\[\]]/, `literal task marker at prefix ${end}`);
          } else if (!unicode && end >= 6) {
            const marker = final[3].toLowerCase() === 'x' ? '[x]' : '[ ]';
            assert.ok(rendered.startsWith(marker), `unstable ASCII task marker at prefix ${end}`);
          }
        }
      }
      assertNoMarkerUnhide(final, unicodeOutputs, /[\[\]]/);
      assertNoMarkerUnhide(final, asciiOutputs, /[\[\]]/);
      assert.equal(await renderMarkdownBody(final, 80, true), await renderMarkdownBody(final, 80));
      assert.equal(
        await renderMarkdownBodyAscii(final, 80, true),
        await renderMarkdownBodyAscii(final, 80),
      );
    }

    const strike = '~~deleted~~';
    const strikeOutputs = [];
    for (let end = 1; end <= strike.length; end += 1) {
      const prefix = strike.slice(0, end);
      assert.equal(parseMarkdown(prefix, { streaming: true }).length, 1);
      const raw = await renderMarkdownBodyRaw(prefix, 80, true);
      const rendered = renderedText(raw);
      strikeOutputs.push(rendered);
      assert.ok(displayWidth(rendered) <= displayWidth(prefix), `strike prefix ${end} expanded`);
      if (end >= 3) assert.doesNotMatch(rendered, /~/, `literal strike marker at prefix ${end}`);
    }
    assertNoMarkerUnhide(strike, strikeOutputs, /~/);
    assert.equal(await renderMarkdownBody(strike, 80, true), await renderMarkdownBody(strike, 80));
  });

  it('preserves streaming repair when a table falls back to raw rows', async () => {
    const text = '| A | B |\n| --- | --- |\n| one | **two';
    assert.equal(await renderMarkdownBody(text, 8, true), '| A | B |\n| --- | --- |\n| one | two');
    assert.equal(await renderMarkdownBody(text, 8), text);
  });

  it('preserves source line count and never expands ASCII width for every streamed prefix', async () => {
    const final = 'Use **bold** with `code`, ~~old~~, and [docs](https://example.com).';
    for (let end = 1; end <= final.length; end += 1) {
      const prefix = final.slice(0, end);
      const parsed = parseMarkdown(prefix, { streaming: true });
      assert.equal(parsed.length, prefix.split('\n').length, `line count at prefix ${end}`);
      const rendered = await renderMarkdownBody(prefix, 120, true);
      assert.ok(rendered.length <= prefix.length, `width expanded at prefix ${end}`);
    }
    assert.equal(
      await renderMarkdownBody(final, 120, true),
      await renderMarkdownBody(final, 120, false),
    );
  });
});

describe('parseMarkdown — tables', () => {
  it('recognizes canonical and pipe-less GFM tables without changing line count', () => {
    const text = '| Command | Description |\n| --- | --- |\n| test | Run tests |';
    const lines = parseMarkdown(text);
    assert.equal(lines.length, 3);
    assert.deepEqual(
      lines.map((line) => line.kind),
      ['table', 'table', 'table'],
    );
    assert.deepEqual(
      lines.map((line) => line.role),
      ['header', 'divider', 'body'],
    );
    assert.deepEqual(
      lines[0].cells.map((cell) => cell[0].text),
      ['Command', 'Description'],
    );
    assert.equal(lines[0].table, lines[2].table);

    const bare = parseMarkdown('A | B\n--- | ---\n1 | 2');
    assert.deepEqual(
      bare.map((line) => line.kind),
      ['table', 'table', 'table'],
    );
  });

  it('honors delimiter alignment markers', () => {
    const lines = parseMarkdown('| Left | Center | Right |\n| :--- | :---: | ---: |');
    assert.deepEqual(lines[0].table.alignments, ['left', 'center', 'right']);
  });

  it('keeps escaped pipes and code-span pipes inside cells', () => {
    const lines = parseMarkdown('| Name | Value |\n| --- | --- |\n| a\\|b | `x | y` |');
    assert.equal(lines[2].kind, 'table');
    assert.deepEqual(lines[2].cells[0], [{ text: 'a|b' }]);
    assert.deepEqual(lines[2].cells[1], [{ text: 'x | y', code: true }]);
  });

  it('pads a short body row to the header width', () => {
    const lines = parseMarkdown('| A | B |\n| --- | --- |\n| 1 |');
    assert.equal(lines.length, 3);
    assert.deepEqual(
      lines[2].cells.map((cell) => cell[0].text),
      ['1', ''],
    );
  });

  it('falls back to raw text when a body row is overfull (no cell is dropped)', () => {
    // GFM would ignore the excess `4`; fit-or-raw is lossless, so the whole
    // candidate demotes to raw text instead of silently discarding content.
    assert.deepEqual(
      parseMarkdown('| A | B |\n| --- | --- |\n| 2 | 3 | 4 |').map((line) => line.kind),
      ['text', 'text', 'text'],
    );
  });

  it('lets block syntax outrank table recognition (GFM precedence)', () => {
    // A heading that happens to contain a pipe stays a heading, even when the
    // next line looks like a delimiter — the table must not swallow it.
    assert.deepEqual(
      parseMarkdown('# A | B\n--- | ---').map((line) => line.kind),
      ['heading', 'text'],
    );
    // A block row with a pipe ends the table and is reclassified by the caller,
    // not absorbed as a table body row.
    assert.deepEqual(
      parseMarkdown('| A | B |\n| --- | --- |\n> note | x').map((line) => line.kind),
      ['table', 'table', 'quote'],
    );
    assert.deepEqual(
      parseMarkdown('| A | B |\n| --- | --- |\n- item | x').map((line) => line.kind),
      ['table', 'table', 'bullet'],
    );
    assert.deepEqual(
      parseMarkdown('| A | B |\n| --- | --- |\n1. step | x').map((line) => line.kind),
      ['table', 'table', 'ordered'],
    );
  });

  it('leaves malformed and one-column candidates as ordinary text', () => {
    assert.deepEqual(
      parseMarkdown('| A | B |\n| --- |').map((line) => line.kind),
      ['text', 'text'],
    );
    assert.deepEqual(
      parseMarkdown('| A |\n| --- |').map((line) => line.kind),
      ['text', 'text'],
    );
  });

  it('does not recognize tables inside fenced code', () => {
    const lines = parseMarkdown('```\n| A | B |\n| --- | --- |\n```');
    assert.deepEqual(
      lines.map((line) => line.kind),
      ['fence', 'code', 'code', 'fence'],
    );
  });

  it('uses terminal display widths for table layout', () => {
    const lines = parseMarkdown('| A | 字 |\n| --- | --- |\n| bb | c |');
    assert.deepEqual(lines[0].table.columnWidths, [2, 2]);
    assert.equal(lines[0].table.formattedWidth, 7);
  });
});

describe('MarkdownBody — table rendering', () => {
  it('renders a fitting table as aligned rows with a visual divider', async () => {
    const text = '| Command | Description |\n| --- | --- |\n| test | Run tests |';
    const rendered = await renderMarkdownBody(text, 40);
    assert.equal(rendered, 'Command │ Description\n────────┼────────────\ntest    │ Run tests');
    assert.equal(rendered.includes('| --- |'), false);
  });

  it('falls back to raw source rows when the formatted table is too wide', async () => {
    const text = '| Command | Description |\n| --- | --- |\n| test | Run tests |';
    const rendered = await renderMarkdownBody(text, 10);
    assert.equal(rendered, '| Command | Description |\n| --- | --- |\n| test | Run tests |');
  });

  it('formats at exact fit and falls back one cell narrower', async () => {
    const text = '| A | BB |\n| --- | --- |\n| C | DD |';
    assert.equal(await renderMarkdownBody(text, 6), 'A │ BB\n──┼───\nC │ DD');
    assert.equal(await renderMarkdownBody(text, 5), '| A | BB |\n| --- | --- |\n| C | DD |');
  });

  it('pads center and right aligned cells', async () => {
    const text = '| L | C | R |\n| :--- | :---: | ---: |\n| aa | b | c |';
    assert.equal(await renderMarkdownBody(text, 20), 'L  │ C │ R\n───┼───┼──\naa │ b │ c');
  });
});

describe('parseMarkdown — code fence syntax highlighting', () => {
  it('stamps block-level codeSpans on code lines for a known language', () => {
    const lines = parseMarkdown('intro\n```ts\nconst x = 1\n// note\n```\nafter');
    const code = lines.filter((l) => l.kind === 'code');
    assert.equal(code.length, 2);
    assert.ok(
      code.every((l) => l.codeSpans && l.codeSpans.length > 0),
      'both code lines highlighted',
    );
    // Whitespace/content preserved: concat(spans) === raw.
    for (const l of code) {
      assert.equal(l.codeSpans.map((s) => s.text).join(''), l.raw);
    }
  });

  it('leaves codeSpans unset for an unsupported language (renders flat-muted)', () => {
    const lines = parseMarkdown('```brainfuck\n+++.\n```');
    const code = lines.filter((l) => l.kind === 'code');
    assert.equal(code.length, 1);
    assert.equal(code[0].codeSpans, undefined);
  });

  it('highlights an UNTERMINATED fence (streaming mid-block)', () => {
    // No closing ``` — the collected lines are still valid code and must
    // highlight, or a streaming code block stays gray until the fence lands.
    const lines = parseMarkdown('```python\ndef f():\n    return 1');
    const code = lines.filter((l) => l.kind === 'code');
    assert.equal(code.length, 2);
    assert.ok(code.every((l) => l.codeSpans && l.codeSpans.length > 0));
  });

  it('tokenizes the block as a whole — a line inside a multi-line construct is not mis-lit', () => {
    // Line-by-line tokenizing would treat the middle line of a template
    // literal as its own statement. Block-level keeps it a string.
    const lines = parseMarkdown('```ts\nconst s = `line one\nline two`\n```');
    const code = lines.filter((l) => l.kind === 'code');
    const secondLine = code[1].codeSpans ?? [];
    // The whole second line is part of the string literal → one span, string color.
    assert.equal(secondLine.map((s) => s.text).join(''), 'line two`');
    assert.equal(
      new Set(secondLine.map((s) => s.color)).size,
      1,
      'the closing string line is one color',
    );
  });
});
