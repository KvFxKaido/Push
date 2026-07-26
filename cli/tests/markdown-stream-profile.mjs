/**
 * Streaming-markdown profiler — the measurement `TUI Visual Language v2.md`
 * gates completed-block caching on ("introduce block caching only if profiling
 * a long live response shows full-tail parsing or repeated fence highlighting
 * is material").
 *
 * Not a test: named without `.test.` so `pnpm run test:cli` skips it. Run it by
 * hand when the deferral is revisited:
 *
 *   node --import tsx cli/tests/markdown-stream-profile.mjs
 *
 * Method notes, because two of these are load-bearing:
 *
 *  - `parseMarkdown` runs inside a `useMemo` keyed on `[text, streaming]`, so it
 *    executes exactly once per render of a growing message. Parse:render is 1:1
 *    regardless of frame rate, which makes the per-frame ratio the honest
 *    comparison and frees it from any assumption about provider cadence.
 *  - Cost is measured as CPU time, not wall time. Wall time during a stream is
 *    dominated by frame-throttle idling, which would flatter whichever side of
 *    the comparison happens to sit behind the throttle.
 *  - Renders go through a LIVE silvery instance driven by setState, not
 *    `renderStringSync`. The latter mounts a fresh reconciler per call, which
 *    measures a cold mount rather than the incremental update the TUI performs
 *    — and it inflates the render side in exactly the direction that would
 *    flatter a "parse is negligible" conclusion.
 */
import { EventEmitter } from 'node:events';

import React, { useEffect, useState } from 'react';
import * as Silvery from 'silvery';

import { MarkdownBody, parseMarkdown } from '../silvery/markdown.tsx';
import { PushThemeProvider } from '../silvery/theme.tsx';
import { highlightToSpans } from '../tui-highlight.ts';

class FakeStdout extends EventEmitter {
  constructor(columns, rows) {
    super();
    this.isTTY = true;
    this.columns = columns;
    this.rows = rows;
    this.bytes = '';
    this.writes = 0;
  }
  write(chunk) {
    this.bytes += String(chunk);
    this.writes += 1;
    return true;
  }
  get writableHighWaterMark() {
    return 16_384;
  }
}

class FakeStdin extends EventEmitter {
  constructor() {
    super();
    this.isTTY = true;
  }
  setRawMode() {
    return this;
  }
  resume() {
    return this;
  }
  pause() {
    return this;
  }
  setEncoding() {
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
  destroy() {
    return this;
  }
  read() {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cpuMs = (delta) => (delta.user + delta.system) / 1000;

const WIDTH = 100;
const VIEWPORT_HEIGHT = 20;
/** Streamed characters per frame — roughly six tokens. */
const CHUNK = 24;

const PROSE = `The renderer keeps a **single pass** over source lines, so every construct
is decided from the line itself plus whatever definitions came *before* it.
That is a deliberate divergence from CommonMark: resolving a forward reference
would restyle an already-settled row, and settled rows must never reflow. See
\`cli/silvery/markdown.tsx\` for the parser — width non-expansion binds them.`;

const LIST = `- First item with some \`inline code\` and **bold** text in it
- Second item, long enough to wrap and exercise the hanging indent path
  - A nested child at depth one
- [x] A completed task item
- [ ] An open one with ~~struck~~ text`;

const CODE = `\`\`\`ts
const references = new Map<string, string>();
for (const raw of rawLines) {
  const def = parseReferenceDefinition(raw);
  if (def) references.set(normalizeReferenceLabel(def.label), def.url);
}
\`\`\``;

const TABLE = `| Rank | Enhancement | Impact | Effort |
|---|---|---|---|
| 1 | GFM task lists + strikethrough | High | Small |
| 4 | Reference links and autolinks | Medium | Medium |`;

/** One realistic answer's worth of prose, list, fence, table, definition. */
const UNIT = [PROSE, '', LIST, '', CODE, '', TABLE, '', '[doc]: https://example.com/v2', ''].join(
  '\n',
);
const CORPUS = Array.from({ length: 24 }, () => UNIT).join('\n');

let pushFrame = null;

function PlainBody({ text }) {
  return React.createElement(
    Silvery.Box,
    { flexDirection: 'column' },
    text.split('\n').map((row, i) => React.createElement(Silvery.Text, { key: i }, row || ' ')),
  );
}

/** One settled short row plus the growing message — the real transcript shape. */
function Bench({ mode }) {
  const [text, setText] = useState('');
  useEffect(() => {
    pushFrame = setText;
    return () => {
      pushFrame = null;
    };
  }, []);
  const items = [
    { id: 'u0', body: 'the user ask that started this turn' },
    { id: 'a0', body: text },
  ];
  return React.createElement(
    PushThemeProvider,
    null,
    React.createElement(Silvery.ListView, {
      items,
      height: VIEWPORT_HEIGHT,
      width: WIDTH,
      gap: 1,
      follow: 'end',
      virtualization: 'measured',
      scrollbarVisibility: 'always',
      getKey: (item) => item.id,
      renderItem: (item) =>
        React.createElement(
          Silvery.Box,
          { flexDirection: 'column', width: WIDTH },
          mode === 'plain'
            ? React.createElement(PlainBody, { text: item.body })
            : React.createElement(MarkdownBody, {
                text: item.body,
                availableWidth: WIDTH - 4,
                streaming: item.id === 'a0',
              }),
        ),
    }),
  );
}

/**
 * CPU cost of ONE more streamed chunk when the message already holds `size`
 * chars. Grows to `size` unmeasured first, so the sample is steady-state.
 */
async function frameCostAt(mode, size, samples = 20) {
  const stdout = new FakeStdout(WIDTH, VIEWPORT_HEIGHT + 4);
  const handle = Silvery.render(
    React.createElement(Bench, { mode }),
    { stdout, stdin: new FakeStdin() },
    { exitOnCtrlC: false, alternateScreen: false, mode: 'fullscreen' },
  );
  const lifecycle = handle.run();
  const instance = await handle;
  await sleep(150);
  if (typeof pushFrame !== 'function') throw new Error('bench never mounted');

  pushFrame(CORPUS.slice(0, size));
  await sleep(200);

  const before = process.cpuUsage();
  for (let i = 1; i <= samples; i += 1) {
    pushFrame(CORPUS.slice(0, size + i * CHUNK));
    await sleep(10);
  }
  await sleep(80);
  const cpu = cpuMs(process.cpuUsage(before));

  instance.unmount();
  await lifecycle;
  return cpu / samples;
}

/** Parse cost for the same one-more-chunk question, same sizes. */
function parseCostAt(size, samples = 20) {
  for (let i = 0; i < 50; i += 1) parseMarkdown(CORPUS.slice(0, size), { streaming: true });
  const before = process.cpuUsage();
  for (let i = 1; i <= samples; i += 1) {
    parseMarkdown(CORPUS.slice(0, size + i * CHUNK), { streaming: true });
  }
  return cpuMs(process.cpuUsage(before)) / samples;
}

const SIZES = [500, 2000, 4000, 8000, 12000];

console.log(`node ${process.version}  platform=${process.platform}`);
console.log(`width=${WIDTH}  viewport=${VIEWPORT_HEIGHT} rows  chunk=${CHUNK} chars/frame\n`);

// Warm both paths before the measured runs.
await frameCostAt('markdown', 500, 6);
await frameCostAt('plain', 500, 6);
parseCostAt(500, 6);

console.log('Cost of one more streamed chunk, by current message size:\n');
console.log('   size  lines   markdown   parse     parse%   plain-Text   markdown-only');
for (const size of SIZES) {
  if (size > CORPUS.length) break;
  const md = await frameCostAt('markdown', size);
  const plain = await frameCostAt('plain', size);
  const parse = parseCostAt(size);
  const lines = CORPUS.slice(0, size).split('\n').length;
  console.log(
    `  ${String(size).padStart(5)}  ${String(lines).padStart(5)}   ${md.toFixed(2).padStart(6)}ms  ${parse.toFixed(3).padStart(6)}ms  ${((parse / md) * 100).toFixed(1).padStart(5)}%   ${plain.toFixed(2).padStart(7)}ms   ${(md - plain).toFixed(2).padStart(10)}ms`,
  );
}

console.log('\n  markdown     = full renderer, the shipped path');
console.log('  parse        = parseMarkdown alone (includes fence highlighting)');
console.log('  plain-Text   = same row count as bare <Text> nodes: structural floor');
console.log('  markdown-only = markdown minus structural floor');

console.log('\nhighlightToSpans in isolation:');
for (const [lang, code] of [
  ['ts', CODE.split('\n').slice(1, -1).join('\n')],
  ['bash', 'pnpm run test:cli\ngit log --oneline -5\ncd app && pnpm run build'],
]) {
  for (let i = 0; i < 200; i += 1) highlightToSpans(code, lang);
  const before = process.cpuUsage();
  for (let i = 0; i < 500; i += 1) highlightToSpans(code, lang);
  const per = cpuMs(process.cpuUsage(before)) / 500;
  console.log(
    `  ${lang.padEnd(5)} ${String(code.split('\n').length).padStart(2)} lines  ${per.toFixed(4)}ms per call`,
  );
}
