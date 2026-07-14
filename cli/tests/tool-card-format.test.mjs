import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatToolCard } from '../tool-card-format.ts';

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
      type: 'sandbox',
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
      type: 'sandbox',
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
    const display = formatToolCard({ type: 'sandbox', data });
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
    const display = formatToolCard({
      type: 'commit-list',
      data: {
        commits: Array.from({ length: 100_000 }, (_, index) => ({
          sha: `sha${index}`,
          message: 'x'.repeat(1_000),
        })),
      },
    });
    // header + LIST_ITEM_LIMIT items + the "more" line.
    assert.equal(display.bodyLines.length, 14);
    assert.equal(display.bodyLines[0].text, 'Commits (100000)');
    assert.equal(display.bodyLines.at(-1).text, '  … +99988 more');
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
      type: 'sandbox',
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
