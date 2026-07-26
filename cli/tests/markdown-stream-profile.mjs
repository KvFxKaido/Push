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
 * Method notes. Each of these changes the answer, so none is incidental:
 *
 *  - `parseMarkdown` runs inside a `useMemo` keyed on `[text, streaming]`, so it
 *    executes exactly once per render of a growing message. Parse:render is 1:1
 *    regardless of frame rate, which makes the per-update ratio the honest
 *    comparison and frees it from any assumption about provider cadence.
 *  - Renders go through a LIVE silvery instance driven by setState, not
 *    `renderStringSync`. The latter mounts a fresh reconciler per call, which
 *    measures a cold mount rather than the incremental update the TUI performs
 *    — and it inflates the render side in exactly the direction that would
 *    flatter a "parse is negligible" conclusion.
 *  - TWO CLOCKS, deliberately. Render work interleaves with frame-throttle
 *    idling, so it must be measured as CPU time (`process.cpuUsage`) to exclude
 *    the idle. But `process.cpuUsage` has ~15.6ms granularity on Windows, which
 *    quantizes anything short: averaged over 20 samples it can only ever return
 *    multiples of 0.78ms, so sub-millisecond parse costs come back as fake
 *    integers. Parsing is pure synchronous work with no idling, so wall time
 *    equals CPU time there and `performance.now()` over many iterations gives
 *    real resolution. Do not "simplify" these to one clock.
 *  - Section B exists because a five-line fence understates fence cost by ~40x.
 *    Highlighting re-runs over the WHOLE accumulated block on every parse
 *    (`if (inFence) closeFence()` in markdown.tsx covers the unterminated case),
 *    so the cost scales with block size and a short-fence corpus hides it.
 */
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';

import React, { useEffect, useState } from 'react';
import * as Silvery from 'silvery';

import { MarkdownBody, parseMarkdown } from '../silvery/markdown.tsx';
import { PushThemeProvider } from '../silvery/theme.tsx';
import { highlightToSpans } from '../tui-highlight.ts';

/**
 * Counts output without retaining it. Keeping every frame's full-screen repaint
 * would grow to megabytes across a run, and the resulting allocation/GC would
 * be charged to render cost by `process.cpuUsage`.
 */
class FakeStdout extends EventEmitter {
  constructor(columns, rows) {
    super();
    this.isTTY = true;
    this.columns = columns;
    this.rows = rows;
    this.bytesWritten = 0;
    this.writes = 0;
  }
  write(chunk) {
    this.bytesWritten += String(chunk).length;
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
/** Streamed characters per update — roughly six tokens. */
const CHUNK = 24;
const SAMPLES = 20;

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

/** A single long code block — the case a short-fence corpus hides. */
const CODE_UNIT = `export function listDepthFromLeading(leading: string): number {
  const cells = listIndentCells(leading);
  return Math.min(MAX_LIST_DEPTH, Math.floor(cells / LIST_INDENT_STEP));
}

// A comment mentioning "a string" and 'another' for the lexer to chew on.
const references = new Map<string, string>();
for (const raw of rawLines) {
  const def = parseReferenceDefinition(raw);
  if (def) references.set(normalizeReferenceLabel(def.label), def.url);
}
`;
const CODE_CORPUS = Array.from({ length: 60 }, () => CODE_UNIT).join('\n');

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

/** Mean message length actually sampled by a run based at `base`. */
const meanSampledSize = (base) => Math.round(base + (CHUNK * (SAMPLES + 1)) / 2);

/**
 * CPU per streamed update once the message already holds ~`base` chars. Grows
 * to `base` unmeasured first so the sample is steady-state. Reported per
 * UPDATE, not per painted frame: silvery throttles paints, so an update can
 * reconcile without producing its own frame. `paints` reports the difference.
 */
async function updateCostAt(mode, base, samples = SAMPLES) {
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

  pushFrame(CORPUS.slice(0, base));
  await sleep(200);
  const paintsBefore = stdout.writes;

  const before = process.cpuUsage();
  for (let i = 1; i <= samples; i += 1) {
    pushFrame(CORPUS.slice(0, base + i * CHUNK));
    await sleep(10);
  }
  await sleep(80);
  const cpu = cpuMs(process.cpuUsage(before));
  const paints = stdout.writes - paintsBefore;

  instance.unmount();
  await lifecycle;
  return { perUpdate: cpu / samples, paints };
}

/**
 * Parse cost for the same one-more-chunk question. `performance.now` over many
 * iterations, not `cpuUsage` — see the two-clocks note at the top.
 */
function parseCostAt(build, base, iters = 200) {
  for (let i = 0; i < 50; i += 1) parseMarkdown(build(base), { streaming: true });
  const t0 = performance.now();
  for (let i = 0; i < iters; i += 1) {
    parseMarkdown(build(base + (i % SAMPLES) * CHUNK), { streaming: true });
  }
  return (performance.now() - t0) / iters;
}

const SIZES = [500, 2000, 4000, 8000, 12000];

console.log(`node ${process.version}  platform=${process.platform}`);
console.log(`width=${WIDTH}  viewport=${VIEWPORT_HEIGHT} rows  chunk=${CHUNK} chars/update\n`);

// Warm both paths before the measured runs.
await updateCostAt('markdown', 500, 6);
await updateCostAt('plain', 500, 6);
parseCostAt((n) => CORPUS.slice(0, n), 500, 20);

console.log('A. Cost of one more streamed update, by current message size');
console.log('   (msg chars = MEAN length sampled, not the base, since the message grows)\n');
console.log('  msg chars  lines   markdown    parse   parse%   plain-Text   paints/20');
for (const base of SIZES) {
  if (base > CORPUS.length) break;
  const md = await updateCostAt('markdown', base);
  const plain = await updateCostAt('plain', base);
  const parse = parseCostAt((n) => CORPUS.slice(0, n), base);
  const mean = meanSampledSize(base);
  const lines = CORPUS.slice(0, mean).split('\n').length;
  console.log(
    `  ${String(mean).padStart(9)}  ${String(lines).padStart(5)}   ${md.perUpdate.toFixed(2).padStart(6)}ms  ${parse.toFixed(3).padStart(6)}ms  ${((parse / md.perUpdate) * 100).toFixed(1).padStart(5)}%   ${plain.perUpdate.toFixed(2).padStart(7)}ms   ${String(md.paints).padStart(9)}`,
  );
}
console.log('\n  markdown   = full renderer, the shipped path (CPU per update)');
console.log('  parse      = parseMarkdown alone, including fence highlighting');
console.log('  plain-Text = same row count as bare <Text> nodes: the structural floor');

console.log('\nB. Fence parse cost by BLOCK size — open vs closed vs equivalent prose\n');
console.log('  block chars  lines   open fence   closed fence   as prose   highlight alone');
for (const base of [500, 2000, 4000, 8000, 12000, 24000]) {
  if (base > CODE_CORPUS.length) break;
  const open = parseCostAt((n) => '```ts\n' + CODE_CORPUS.slice(0, n), base);
  const closed = parseCostAt((n) => '```ts\n' + CODE_CORPUS.slice(0, n) + '\n```', base);
  const prose = parseCostAt((n) => CODE_CORPUS.slice(0, n).replace(/`/g, "'"), base);
  const code = CODE_CORPUS.slice(0, meanSampledSize(base));
  for (let i = 0; i < 50; i += 1) highlightToSpans(code, 'ts');
  const t0 = performance.now();
  for (let i = 0; i < 200; i += 1) highlightToSpans(code, 'ts');
  const hl = (performance.now() - t0) / 200;
  console.log(
    `  ${String(meanSampledSize(base)).padStart(11)}  ${String(code.split('\n').length).padStart(5)}   ${open.toFixed(3).padStart(7)}ms   ${closed.toFixed(3).padStart(10)}ms   ${prose.toFixed(3).padStart(6)}ms   ${hl.toFixed(3).padStart(12)}ms`,
  );
}
console.log('\n  An unterminated fence is re-highlighted whole on every parse, so "open"');
console.log('  is the live-streaming case. It tracks "closed" — both redo the whole block —');
console.log('  and both come in UNDER the same volume rendered as prose, because fence');
console.log('  lines skip parseInline entirely.');
