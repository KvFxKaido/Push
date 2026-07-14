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
});
