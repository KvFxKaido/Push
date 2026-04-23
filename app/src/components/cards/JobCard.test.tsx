import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { CoderJobCardData } from '@/types';
import { JobCard } from './JobCard';

function baseData(overrides: Partial<CoderJobCardData> = {}): CoderJobCardData {
  return {
    jobId: 'job-card-test-1',
    chatId: 'chat-1',
    status: 'running',
    startedAt: Date.now(),
    lastEventAt: Date.now(),
    taskPreview: 'demo task',
    latestStatusLine: 'Running',
    ...overrides,
  };
}

describe('JobCard', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the header with the status badge and elapsed counter', () => {
    const html = renderToStaticMarkup(<JobCard data={baseData()} />);
    expect(html).toContain('Background Coder');
    expect(html).toContain('Running');
    expect(html).toContain('demo task');
  });

  it('does not surface the stall banner for a fresh running job', () => {
    // lastEventAt is "now"; nothing silent yet.
    const now = 1_000_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const html = renderToStaticMarkup(
      <JobCard data={baseData({ startedAt: now, lastEventAt: now })} />,
    );
    expect(html).not.toContain('Looks stalled');
    expect(html).not.toContain('Cancel');
  });

  it('surfaces the stall banner and cancel button when status=running and silent past threshold', () => {
    // The JobCard threshold is 3 minutes; set lastEventAt 5 minutes ago
    // to comfortably clear it without depending on the exact constant.
    const now = 1_000_000_000_000;
    const fiveMinAgo = now - 5 * 60 * 1000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const html = renderToStaticMarkup(
      <JobCard
        data={baseData({
          status: 'running',
          startedAt: fiveMinAgo,
          lastEventAt: fiveMinAgo,
        })}
      />,
    );
    expect(html).toContain('Looks stalled');
    expect(html).toContain('No activity for');
    expect(html).toContain('Cancel');
  });

  it('does not surface the stall banner after the job has reached a terminal state', () => {
    const now = 1_000_000_000_000;
    const fiveMinAgo = now - 5 * 60 * 1000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    // Even though lastEventAt is ancient, a terminal run shouldn't nag
    // the user to cancel — it's already over.
    const html = renderToStaticMarkup(
      <JobCard
        data={baseData({
          status: 'failed',
          startedAt: fiveMinAgo,
          lastEventAt: fiveMinAgo,
          finishedAt: now,
          error: 'something blew up',
        })}
      />,
    );
    expect(html).not.toContain('Looks stalled');
    expect(html).toContain('something blew up');
  });

  it('falls back to startedAt when lastEventAt is undefined', () => {
    // Covers the pre-existing-state path (e.g. a card persisted before
    // this field was introduced). Old cards without lastEventAt should
    // still correctly detect stalls based on startedAt.
    const now = 1_000_000_000_000;
    const fiveMinAgo = now - 5 * 60 * 1000;
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const html = renderToStaticMarkup(
      <JobCard
        data={{
          jobId: 'job-no-last-event',
          chatId: 'chat-1',
          status: 'running',
          startedAt: fiveMinAgo,
        }}
      />,
    );
    expect(html).toContain('Looks stalled');
  });
});
