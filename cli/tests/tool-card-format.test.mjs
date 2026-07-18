import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatToolCard } from '../tool-card-format.ts';

/**
 * Trips BOTH caps: >BODY_CHAR_LIMIT (24k) chars, and the surviving prefix still
 * holds >BODY_LINE_LIMIT (240) lines. 5k lines (~45KB) is the smallest fixture
 * that does — the earlier 50k version bought no coverage and just added memory
 * churn to every CI run. Built once and shared; two tests need the same input.
 */
const OVERSIZED_LOG = Array.from({ length: 5_000 }, (_, i) => `line ${i}`).join('\n');

describe('generic CLI tool-card fallback', () => {
  it('renders a known card as a title plus bounded key/value rows', () => {
    assert.deepEqual(
      formatToolCard({
        type: 'ci-status',
        data: { repo: 'KvFxKaido/Push', checkCount: 3, checks: ['lint', 'test'] },
      }),
      {
        title: 'CI Status',
        known: true,
        rows: [
          { label: 'Repo', value: 'KvFxKaido/Push' },
          { label: 'Check Count', value: '3' },
          { label: 'Checks', value: 'lint, test' },
        ],
      },
    );
  });

  it('renders an unknown future type as an inert tombstone', () => {
    assert.deepEqual(formatToolCard({ type: 'future-card', data: { secretShape: 'ignored' } }), {
      title: 'Unsupported tool card · future-card',
      known: false,
      rows: [],
    });
  });

  it('bounds nested and long payloads instead of dumping the card', () => {
    const display = formatToolCard({
      type: 'ci-status',
      data: Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [
          `field_${index}`,
          index === 0 ? { output: 'x'.repeat(400) } : index,
        ]),
      ),
    });
    assert.equal(display.rows.length, 9);
    assert.equal(display.rows.at(-1).value, 'Additional fields');
    assert.equal(display.rows[0].value, '[structured data]');
    assert.ok(display.rows[0].value.length <= 180);
  });

  it('bounds type names, labels, strings, and arrays before rendering', () => {
    const display = formatToolCard({
      type: 'future-'.repeat(100_000),
      data: {},
    });
    assert.ok(display.title.length <= 80);

    const known = formatToolCard({
      type: 'ci-status',
      data: {
        ['very_long_key_'.repeat(100_000)]: 'x'.repeat(1_000_000),
        hugeArray: Array.from({ length: 100_000 }, () => 'not joined'),
      },
    });
    assert.ok(known.rows[0].label.length <= 48);
    assert.ok(known.rows[0].value.length <= 180);
    assert.equal(known.rows[1].value, '100000 items');
  });

  it('caps field traversal even when early values are omitted', () => {
    const data = Object.fromEntries(
      Array.from({ length: 100_000 }, (_, index) => [`omitted_${index}`, undefined]),
    );
    const display = formatToolCard({ type: 'ci-status', data });
    assert.deepEqual(display.rows, [{ label: 'More', value: 'Additional fields' }]);
  });

  it('renders diff-preview cards as multiline diffs instead of a collapsed row', () => {
    const display = formatToolCard({
      type: 'diff-preview',
      data: {
        diff: '--- a/file.ts\n+++ b/file.ts\n-old\n+new',
        filesChanged: 1,
        additions: 1,
        deletions: 1,
        truncated: false,
      },
    });

    assert.deepEqual(display.rows, [
      { label: 'Files Changed', value: '1' },
      { label: 'Additions', value: '1' },
      { label: 'Deletions', value: '1' },
    ]);
    assert.deepEqual(display.bodyLines, [
      { text: '--- a/file.ts', tone: 'context' },
      { text: '+++ b/file.ts', tone: 'context' },
      { text: '-old', tone: 'delete' },
      { text: '+new', tone: 'add' },
    ]);
  });

  it('renders an object list as a section instead of collapsing it to a count', () => {
    // The regression this guards: "Checks: 3 items" hid *which* check failed —
    // the entire reason the tool was called. An object list is the shape of every
    // high-traffic inspection card (pr-list, ci-status, commit-list, ...).
    const display = formatToolCard({
      type: 'ci-status',
      data: {
        repo: 'KvFxKaido/Push',
        checks: [
          { name: 'typecheck', status: 'completed', conclusion: 'success' },
          { name: 'app-build', status: 'completed', conclusion: 'failure' },
        ],
      },
    });

    assert.deepEqual(display.rows, [{ label: 'Repo', value: 'KvFxKaido/Push' }]);
    assert.deepEqual(display.bodyLines, [
      { text: 'Checks (2)', tone: 'context' },
      { text: '  typecheck · completed · success', tone: 'context' },
      { text: '  app-build · completed · failure', tone: 'context' },
    ]);
  });

  it('renders acronym plurals in section headers as acronyms', () => {
    const display = formatToolCard({
      type: 'pr-list',
      data: { prs: [{ number: 1463, title: 'delete render sniffing', author: 'ishaw' }] },
    });
    assert.deepEqual(display.bodyLines, [
      { text: 'PRs (1)', tone: 'context' },
      { text: '  1463 · delete render sniffing · ishaw', tone: 'context' },
    ]);
  });

  it('keeps an empty list on the row path so it reads as "none"', () => {
    const display = formatToolCard({ type: 'ci-status', data: { checks: [] } });
    assert.deepEqual(display.rows, [{ label: 'Checks', value: 'none' }]);
    assert.equal(display.bodyLines, undefined);
  });

  it('bounds a pathological object list without summarizing every item', () => {
    // 5k items, not 100k. The assertions are on output *shape* — slice-before-map
    // is exercised by any N over LIST_ITEM_LIMIT — so a bigger N buys no coverage
    // and costs real memory. The 100k × 1KB version of this allocated ~100MB per
    // run and was plausibly raising the flake rate of timing-sensitive daemon
    // tests sharing the CI runner.
    const display = formatToolCard({
      type: 'commit-list',
      data: {
        commits: Array.from({ length: 5_000 }, (_, index) => ({
          sha: `sha${index}`,
          message: 'x'.repeat(200),
        })),
      },
    });
    // header + LIST_ITEM_LIMIT items + the "more" line.
    assert.equal(display.bodyLines.length, 14);
    assert.equal(display.bodyLines[0].text, 'Commits (5000)');
    assert.equal(display.bodyLines.at(-1).text, '  … +4988 more');
    for (const line of display.bodyLines) {
      assert.ok(line.text.length <= 180 + 2, `line must stay bounded: ${line.text.length}`);
    }
  });

  it('skips nested structure inside a list item rather than expanding it', () => {
    const display = formatToolCard({
      type: 'file-list',
      data: {
        files: [
          { path: 'src/app.ts', nested: { deep: 'ignored' }, tags: ['a'], size: 12 },
          { onlyNested: { deep: 'ignored' } },
        ],
      },
    });
    assert.deepEqual(display.bodyLines, [
      { text: 'Files (2)', tone: 'context' },
      { text: '  src/app.ts · 12', tone: 'context' },
      { text: '  [structured data]', tone: 'context' },
    ]);
  });

  it('leaves scalar arrays and mixed arrays on the existing count path', () => {
    const display = formatToolCard({
      type: 'ci-status',
      data: {
        scalars: Array.from({ length: 100 }, () => 'x'),
        mixed: [{ a: 1 }, 'not-an-object'],
      },
    });
    assert.deepEqual(display.rows, [
      { label: 'Scalars', value: '100 items' },
      { label: 'Mixed', value: '2 items' },
    ]);
    assert.equal(display.bodyLines, undefined);
  });

  it('renders a multi-line string as a text section instead of a truncated row', () => {
    // get_job_logs / get_issue carry prose or log bodies. As a row they became a
    // 180-char stump — the row budget is right for a branch name and destroys a log.
    const display = formatToolCard({
      type: 'workflow-logs',
      data: {
        job: 'test (cli)',
        logs: 'Run pnpm test\n  3310 passing\n  0 failing\nDone in 22s',
      },
    });

    assert.deepEqual(display.rows, [{ label: 'Job', value: 'test (cli)' }]);
    assert.deepEqual(display.bodyLines, [
      { text: 'Logs (4 lines)', tone: 'context' },
      { text: '  Run pnpm test', tone: 'context' },
      { text: '    3310 passing', tone: 'context' },
      { text: '    0 failing', tone: 'context' },
      { text: '  Done in 22s', tone: 'context' },
    ]);
  });

  it('does not tone a generic text body as a diff', () => {
    // boundedBodyLines colors +/- prefixes for diff-preview, which DECLARED itself
    // a diff. An arbitrary log declared nothing: a stack-trace line starting with
    // "-" is not a deletion, and tinting it red is the text-sniffing we deleted.
    const display = formatToolCard({
      type: 'workflow-logs',
      data: { logs: '- npm ERR! failed\n+ retrying\n  ok' },
    });
    assert.deepEqual(
      display.bodyLines.map((l) => l.tone),
      ['context', 'context', 'context', 'context'],
    );
  });

  it('treats a trailing newline as a scalar, not a document', () => {
    // "main\n" is a branch name. Only a newline inside the trimmed content promotes.
    // `empty: ''` renders no row now — an empty string is nothing to show
    // (isEmptyCardValue), so it is dropped rather than printed as `Empty:`.
    const display = formatToolCard({
      type: 'ci-status',
      data: { branch: 'main\n', blank: '\n\n\n', empty: '' },
    });
    assert.deepEqual(display.rows, [
      { label: 'Branch', value: 'main' },
      { label: 'Blank', value: '' },
    ]);
    assert.equal(display.bodyLines, undefined);
  });

  it('bounds a pathological text body without splitting the whole string', () => {
    const display = formatToolCard({
      type: 'workflow-logs',
      data: { logs: OVERSIZED_LOG },
    });
    // header + BODY_LINE_LIMIT lines + the "dropped" line.
    assert.equal(display.bodyLines.length, 242);
    for (const line of display.bodyLines) {
      assert.ok(line.text.length <= 180 + 2, `line must stay bounded: ${line.text.length}`);
    }
  });

  it('never reports a prefix-scoped line count as if it were the total', () => {
    // Codex P2 on #1470. BOTH caps bite here: the value exceeds BODY_CHAR_LIMIT
    // *and* the surviving prefix still exceeds BODY_LINE_LIMIT. `hidden` counts
    // only lines inside the prefix, so emitting "+N more" alone would state a
    // number that is not the number of dropped lines, and the reader could not
    // tell. Both signals must survive, and the count must be marked as a floor.
    const display = formatToolCard({
      type: 'workflow-logs',
      data: { logs: OVERSIZED_LOG },
    });
    assert.match(display.bodyLines[0].text, /^Logs \(\d+\+ lines\)$/, 'count must be marked "+"');
    const last = display.bodyLines.at(-1).text;
    assert.match(last, /\+\d+ more/, 'must still say how many lines were held back');
    assert.match(last, /payload truncated/, 'must ALSO say the source itself was cut');
  });

  it('marks a char-truncated body even when no lines are held back', () => {
    // One long line over BODY_CHAR_LIMIT, plus a second: hidden === 0, but the
    // source was still cut. The truncation marker must not vanish.
    const display = formatToolCard({
      type: 'workflow-logs',
      data: { logs: `${'x'.repeat(30_000)}\nsecond line` },
    });
    assert.equal(display.bodyLines.at(-1).text, '  … payload truncated');
  });

  it('does not mark a body that fits within both caps', () => {
    const display = formatToolCard({ type: 'workflow-logs', data: { logs: 'one\ntwo' } });
    assert.deepEqual(
      display.bodyLines.map((l) => l.text),
      ['Logs (2 lines)', '  one', '  two'],
    );
  });

  it('renders a card carrying both a list and a text body', () => {
    const display = formatToolCard({
      type: 'ci-status',
      data: {
        checks: [{ name: 'build', conclusion: 'failure' }],
        logs: 'error: exit 1\n  at build.ts:3',
      },
    });
    assert.deepEqual(display.rows, []);
    assert.deepEqual(
      display.bodyLines.map((l) => l.text),
      ['Checks (1)', '  build · failure', 'Logs (2 lines)', '  error: exit 1', '    at build.ts:3'],
    );
  });

  it('keeps workspace status paths visible outside the generic row budget', () => {
    const display = formatToolCard({
      type: 'sandbox-state',
      data: {
        sandboxId: 'local-daemon',
        repoPath: '/repo',
        branch: 'feat/cards',
        statusLine: 'Branch: feat/cards',
        changedFiles: 2,
        stagedFiles: 0,
        unstagedFiles: 1,
        untrackedFiles: 1,
        preview: ['M src/app.ts', '?? notes.txt'],
        fetchedAt: '2026-07-14T00:00:00.000Z',
      },
    });

    assert.equal(display.title, 'Workspace Status');
    assert.deepEqual(display.bodyLines, [
      { text: 'M src/app.ts', tone: 'context' },
      { text: '?? notes.txt', tone: 'context' },
    ]);
  });
});

describe('command (exec) card', () => {
  const command = (data) => formatToolCard({ type: 'sandbox', data });
  const isEmpty = (d) => !(d.title || d.rows.length || (d.bodyLines?.length ?? 0));

  it('reduces a clean silent command to nothing — the header row is the whole story', () => {
    // The screenshot: `rm` succeeded, printed nothing. Before this, the generic
    // dumper rendered a "Sandbox" title, a Command: row duplicating the header,
    // empty Stdout:/Stderr:, and Exit Code: 0 / Truncated: false / Duration Ms.
    const d = command({
      command: 'rm shot.png',
      stdout: '',
      stderr: '',
      exitCode: 0,
      durationMs: 57,
    });
    assert.ok(isEmpty(d), `expected an empty card, got ${JSON.stringify(d)}`);
    // No Command row (the header names it), no Duration/Truncated telemetry.
    assert.equal(d.title, '');
    assert.deepEqual(d.rows, []);
    assert.equal(d.bodyLines, undefined);
  });

  it('shows stdout bare, like a read preview, with no Command/Exit/duration chrome', () => {
    const d = command({
      command: 'ls',
      stdout: 'a.ts\nb.ts',
      stderr: '',
      exitCode: 0,
      durationMs: 12,
    });
    assert.equal(d.title, '');
    assert.deepEqual(d.rows, []);
    assert.deepEqual(d.bodyLines, [
      { text: 'a.ts', tone: 'context' },
      { text: 'b.ts', tone: 'context' },
    ]);
  });

  it('surfaces the exit code and stderr on failure, stderr labelled', () => {
    const d = command({
      command: 'cat x',
      stdout: '',
      stderr: 'cat: x: No such file',
      exitCode: 1,
      durationMs: 3,
    });
    assert.deepEqual(d.rows, [{ label: 'Exit', value: '1' }]);
    assert.deepEqual(d.bodyLines, [
      { text: 'stderr:', tone: 'context' },
      { text: '  cat: x: No such file', tone: 'context' },
    ]);
  });

  it('labels both streams when both are present, stderr first', () => {
    const d = command({
      command: 'build',
      stdout: 'done',
      stderr: 'warn: deprecated',
      exitCode: 0,
    });
    assert.deepEqual(d.bodyLines, [
      { text: 'stderr:', tone: 'context' },
      { text: '  warn: deprecated', tone: 'context' },
      { text: 'stdout:', tone: 'context' },
      { text: '  done', tone: 'context' },
    ]);
  });

  it('a command-less sandbox card is not an exec card — it falls through to the dumper', () => {
    // formatCommandCard requires a `command` string; without one the payload is
    // some other sandbox-shaped struct and must not be mistaken for a run.
    const d = formatToolCard({ type: 'sandbox', data: { note: 'not a command' } });
    assert.equal(d.title, 'Sandbox');
    assert.deepEqual(d.rows, [{ label: 'Note', value: 'not a command' }]);
  });
});

describe('generic dumper — drops noise, keeps signal', () => {
  it('omits empty strings, telemetry keys, and truncated:false', () => {
    const d = formatToolCard({
      type: 'ci-status',
      data: { ref: 'main', empty: '', durationMs: 42, startedAt: 1, truncated: false },
    });
    assert.deepEqual(d.rows, [{ label: 'Ref', value: 'main' }]);
  });

  it('KEEPS a meaningful false — a dropped negative reads as a clean pass', () => {
    // The one thing this must never do: hide `passed: false`. A generic dumper
    // has no way to know a false is signal, so it keeps them; only a formatter
    // with semantics may hide one.
    const d = formatToolCard({ type: 'ci-status', data: { passed: false, mergeable: false } });
    assert.deepEqual(d.rows, [
      { label: 'Passed', value: 'false' },
      { label: 'Mergeable', value: 'false' },
    ]);
  });

  it('keeps truncated:true — a cut payload is a fact the reader must see', () => {
    const d = formatToolCard({ type: 'ci-status', data: { ref: 'main', truncated: true } });
    assert.deepEqual(d.rows, [
      { label: 'Ref', value: 'main' },
      { label: 'Truncated', value: 'true' },
    ]);
  });
});
