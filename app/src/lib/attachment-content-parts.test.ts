import { describe, expect, it } from 'vitest';
import type { AttachmentData } from '@/types';
import { buildAttachmentContentParts } from './attachment-content-parts';

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
