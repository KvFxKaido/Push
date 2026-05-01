import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttachmentData } from '@/types';
import {
  getQueuedFollowUpOptions,
  summarizeQueuedInputPreview,
  toPendingSteerRequest,
  toQueuedFollowUp,
} from './queued-follow-up-utils';

function makeAttachment(name: string): AttachmentData {
  return {
    id: `att-${name}`,
    type: 'document',
    filename: name,
    mimeType: 'text/plain',
    sizeBytes: 1,
    content: 'a',
  };
}

describe('getQueuedFollowUpOptions', () => {
  it('returns undefined when nothing is set', () => {
    expect(getQueuedFollowUpOptions()).toBeUndefined();
    expect(getQueuedFollowUpOptions({})).toBeUndefined();
  });

  it('returns undefined when only an empty/whitespace displayText is set', () => {
    expect(getQueuedFollowUpOptions({ displayText: '   ' })).toBeUndefined();
  });

  it('coerces null provider/model to undefined', () => {
    expect(getQueuedFollowUpOptions({ provider: null, model: null })).toBeUndefined();
  });

  it('preserves provider/model and trims displayText when present', () => {
    expect(
      getQueuedFollowUpOptions({
        provider: 'openrouter',
        model: 'anthropic/claude-sonnet-4-6',
        displayText: '  hi  ',
      }),
    ).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4-6',
      displayText: 'hi',
    });
  });

  it('returns a partial object when only some fields are set', () => {
    expect(getQueuedFollowUpOptions({ displayText: 'hi' })).toEqual({
      provider: undefined,
      model: undefined,
      displayText: 'hi',
    });
  });
});

describe('summarizeQueuedInputPreview', () => {
  it('prefers displayText over the raw text', () => {
    expect(summarizeQueuedInputPreview('raw', undefined, 'pretty')).toBe('pretty');
  });

  it('falls back to text when displayText is whitespace', () => {
    expect(summarizeQueuedInputPreview('raw text', undefined, '   ')).toBe('raw text');
  });

  it('uses [no text] when both text and displayText are empty', () => {
    expect(summarizeQueuedInputPreview('', undefined, undefined)).toBe('[no text]');
  });

  it('shows the attachment count alone when there is no candidate text', () => {
    expect(summarizeQueuedInputPreview('', [makeAttachment('a')])).toBe('1 attachment');
    expect(summarizeQueuedInputPreview('', [makeAttachment('a'), makeAttachment('b')])).toBe(
      '2 attachments',
    );
  });

  it('appends an attachment suffix to text when both are present', () => {
    expect(summarizeQueuedInputPreview('hello', [makeAttachment('a')])).toBe(
      'hello (+1 attachment)',
    );
    expect(summarizeQueuedInputPreview('hello', [makeAttachment('a'), makeAttachment('b')])).toBe(
      'hello (+2 attachments)',
    );
  });

  it('truncates long previews with an ellipsis past the configured cap', () => {
    const text = 'a'.repeat(200);
    const result = summarizeQueuedInputPreview(text, undefined, undefined, 10);
    expect(result.endsWith('...')).toBe(true);
    expect(result).toBe(`${'a'.repeat(9)}...`);
  });

  it('drops trailing whitespace before the ellipsis', () => {
    const result = summarizeQueuedInputPreview(`hello  ${'x'.repeat(40)}`, undefined, undefined, 8);
    expect(result.endsWith('...')).toBe(true);
    expect(result).toBe('hello...');
  });

  it('does not truncate when the preview already fits', () => {
    expect(summarizeQueuedInputPreview('short', undefined, undefined, 32)).toBe('short');
  });
});

describe('toQueuedFollowUp / toPendingSteerRequest', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('toQueuedFollowUp captures text, attachments, options, and queuedAt', () => {
    const attachments = [makeAttachment('a')];
    expect(toQueuedFollowUp('hi', attachments, { displayText: 'pretty' })).toEqual({
      text: 'hi',
      attachments,
      options: { provider: undefined, model: undefined, displayText: 'pretty' },
      queuedAt: Date.parse('2026-01-01T00:00:00Z'),
    });
  });

  it('toQueuedFollowUp omits options when none are meaningful', () => {
    expect(toQueuedFollowUp('hi').options).toBeUndefined();
  });

  it('toPendingSteerRequest captures text, attachments, options, and requestedAt', () => {
    expect(toPendingSteerRequest('hi', undefined, { provider: 'openrouter' })).toEqual({
      text: 'hi',
      attachments: undefined,
      options: {
        provider: 'openrouter',
        model: undefined,
        displayText: undefined,
      },
      requestedAt: Date.parse('2026-01-01T00:00:00Z'),
    });
  });

  it('toPendingSteerRequest omits options when none are meaningful', () => {
    expect(toPendingSteerRequest('hi').options).toBeUndefined();
  });
});
