import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CheckpointHistoryList } from './CheckpointHistoryList';
import { formatCheckpointAge } from '@/lib/checkpoint/checkpoint-format';
import type { CheckpointRecord } from '@/lib/checkpoint/checkpoint-store';

const NOW = 1_000_000_000_000;
const RECORDS: CheckpointRecord[] = [
  { checkpointId: 'c2', message: 'checkpoint b', timestampMs: NOW - 2 * 60_000 }, // 2m ago, latest
  { checkpointId: 'c1', message: 'checkpoint a', timestampMs: NOW - 3 * 3_600_000 }, // 3h ago
];

function html(props: Partial<Parameters<typeof CheckpointHistoryList>[0]>): string {
  return renderToStaticMarkup(
    <CheckpointHistoryList
      checkpoints={[]}
      loading={false}
      error={null}
      restoringId={null}
      onRestore={() => {}}
      nowMs={NOW}
      {...props}
    />,
  );
}

describe('formatCheckpointAge', () => {
  it('buckets just-now / minutes / hours / days', () => {
    expect(formatCheckpointAge(NOW, NOW - 30_000)).toBe('just now');
    expect(formatCheckpointAge(NOW, NOW - 5 * 60_000)).toBe('5m ago');
    expect(formatCheckpointAge(NOW, NOW - 2 * 3_600_000)).toBe('2h ago');
    expect(formatCheckpointAge(NOW, NOW - 3 * 86_400_000)).toBe('3d ago');
  });
});

describe('CheckpointHistoryList', () => {
  it('renders the empty state', () => {
    expect(html({})).toContain('No checkpoints yet');
  });

  it('renders the loading state', () => {
    expect(html({ loading: true })).toContain('Loading');
  });

  it('renders the error', () => {
    expect(html({ error: 'list failed' })).toContain('list failed');
  });

  it('renders rows newest-first with age, latest marker, and restore', () => {
    const out = html({ checkpoints: RECORDS });
    expect(out).toContain('2m ago');
    expect(out).toContain('latest');
    expect(out).toContain('3h ago');
    expect(out).toContain('Restore');
    // newest row appears before the older one
    expect(out.indexOf('2m ago')).toBeLessThan(out.indexOf('3h ago'));
  });

  it('shows Restoring… and disables the buttons during a restore', () => {
    const out = html({ checkpoints: RECORDS, restoringId: 'c2' });
    expect(out).toContain('Restoring');
    expect(out).toMatch(/disabled/);
  });
});
