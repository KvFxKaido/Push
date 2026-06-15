import { describe, expect, it, vi } from 'vitest';
import type { AttachmentData } from '@/types';
import {
  buildAttachmentContentParts,
  buildLeadTurnContentParts,
  MAX_PRIOR_ATTACHMENT_TURNS,
} from './attachment-content-parts';

function attachment(overrides: Partial<AttachmentData>): AttachmentData {
  return {
    id: 'att-1',
    type: 'document',
    filename: 'notes.md',
    mimeType: 'text/markdown',
    sizeBytes: 12,
    content: 'hello',
    ...overrides,
  };
}

describe('buildAttachmentContentParts', () => {
  it('returns undefined when there are no attachments', () => {
    expect(buildAttachmentContentParts('Task: inspect this', undefined)).toBeUndefined();
    expect(buildAttachmentContentParts('Task: inspect this', [])).toBeUndefined();
  });

  it('puts the text part first and maps image attachments to image_url parts', () => {
    const parts = buildAttachmentContentParts('Task: inspect this', [
      attachment({
        type: 'image',
        filename: 'screen.png',
        mimeType: 'image/png',
        content: 'data:image/png;base64,abc123',
      }),
    ]);

    expect(parts).toEqual([
      { type: 'text', text: 'Task: inspect this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
    ]);
  });

  it('embeds code and document attachments as labeled text blocks', () => {
    const parts = buildAttachmentContentParts('Task: read these', [
      attachment({
        id: 'code-1',
        type: 'code',
        filename: 'index.ts',
        mimeType: 'text/typescript',
        content: 'export const x = 1;',
      }),
      attachment({
        id: 'doc-1',
        type: 'document',
        filename: 'brief.md',
        mimeType: 'text/markdown',
        content: '# Brief',
      }),
    ]);

    expect(parts).toEqual([
      { type: 'text', text: 'Task: read these' },
      {
        type: 'text',
        text: '[Attached file: index.ts]\n```\nexport const x = 1;\n```',
      },
      {
        type: 'text',
        text: '[Attached file: brief.md]\n```\n# Brief\n```',
      },
    ]);
  });
});

describe('buildLeadTurnContentParts (#938)', () => {
  const img = (url: string, filename = 'shot.png') =>
    attachment({ type: 'image', filename, mimeType: 'image/png', content: url });

  it('returns undefined when no turn carries attachments', () => {
    expect(
      buildLeadTurnContentParts('Task: hi', [{ role: 'user' }, { role: 'assistant' }], undefined),
    ).toBeUndefined();
  });

  it('carries only current attachments when there is no attachment history', () => {
    const parts = buildLeadTurnContentParts(
      'Task: look',
      [{ role: 'assistant' }],
      [img('data:image/png;base64,CUR')],
    );
    expect(parts).toEqual([
      { type: 'text', text: 'Task: look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,CUR' } },
    ]);
  });

  it('carries a prior-turn image (labeled) ahead of the current one', () => {
    const parts = buildLeadTurnContentParts(
      'Task: compare with the earlier shot',
      [{ role: 'user', attachments: [img('data:image/png;base64,PRIOR')] }, { role: 'assistant' }],
      [img('data:image/png;base64,CUR')],
    );
    expect(parts).toEqual([
      { type: 'text', text: 'Task: compare with the earlier shot' },
      { type: 'text', text: '[Attachment(s) from an earlier user turn]' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,PRIOR' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,CUR' } },
    ]);
  });

  it('bounds prior-attachment turns and reports the overflow (no silent cap)', () => {
    const onTruncate = vi.fn();
    const priorTurns = Array.from({ length: MAX_PRIOR_ATTACHMENT_TURNS + 2 }, (_, i) => ({
      role: 'user',
      attachments: [img(`data:image/png;base64,P${i}`, `p${i}.png`)],
    }));
    const parts = buildLeadTurnContentParts('Task: x', priorTurns, undefined, onTruncate);
    expect(onTruncate).toHaveBeenCalledWith(2);
    // Only the most recent MAX_PRIOR_ATTACHMENT_TURNS images ride; the two
    // oldest (P0, P1) are dropped.
    const urls = (parts ?? [])
      .filter((p): p is { type: 'image_url'; image_url: { url: string } } => p.type === 'image_url')
      .map((p) => p.image_url.url);
    expect(urls).toHaveLength(MAX_PRIOR_ATTACHMENT_TURNS);
    expect(urls).not.toContain('data:image/png;base64,P0');
    expect(urls).toContain(`data:image/png;base64,P${MAX_PRIOR_ATTACHMENT_TURNS + 1}`);
  });
});
