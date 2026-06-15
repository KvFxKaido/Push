import { describe, expect, it } from 'vitest';
import type { AttachmentData } from '@/types';
import {
  buildAttachmentContentParts,
  buildPriorTurnAttachmentParts,
  mergeInitialUserContentParts,
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

describe('buildPriorTurnAttachmentParts', () => {
  it('returns an empty array for no attachments', () => {
    expect(buildPriorTurnAttachmentParts([])).toEqual([]);
  });

  it('labels each prior image with an attribution part before the image_url', () => {
    const parts = buildPriorTurnAttachmentParts([
      attachment({
        type: 'image',
        filename: 'before.png',
        content: 'data:image/png;base64,one',
      }),
      attachment({
        type: 'image',
        filename: 'after.png',
        content: 'data:image/png;base64,two',
      }),
    ]);

    // The label parts disambiguate "compare the first screenshot vs the second".
    expect(parts).toEqual([
      { type: 'text', text: '[Image from prior turn: before.png]' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,one' } },
      { type: 'text', text: '[Image from prior turn: after.png]' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,two' } },
    ]);
  });

  it('embeds prior files as labeled text blocks', () => {
    const parts = buildPriorTurnAttachmentParts([
      attachment({ type: 'code', filename: 'a.ts', content: 'const a = 1;' }),
    ]);
    expect(parts).toEqual([
      { type: 'text', text: '[Attached file from prior turn: a.ts]\n```\nconst a = 1;\n```' },
    ]);
  });
});

describe('mergeInitialUserContentParts', () => {
  const img = (url: string): AttachmentData =>
    attachment({ type: 'image', filename: 'x.png', mimeType: 'image/png', content: url });

  it('returns undefined when there is no multimodal content at all', () => {
    expect(mergeInitialUserContentParts('Task: hi', [], undefined)).toBeUndefined();
    expect(mergeInitialUserContentParts('Task: hi', [], [])).toBeUndefined();
  });

  it('emits preamble text first, then current attachments, when there are no prior parts', () => {
    const parts = mergeInitialUserContentParts(
      'Task: look',
      [],
      [img('data:image/png;base64,cur')],
    );
    expect(parts).toEqual([
      { type: 'text', text: 'Task: look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,cur' } },
    ]);
  });

  it('orders parts as preamble → prior → current', () => {
    const priorParts = buildPriorTurnAttachmentParts([
      attachment({ type: 'image', filename: 'prior.png', content: 'data:image/png;base64,prior' }),
    ]);
    const parts = mergeInitialUserContentParts('Task: compare', priorParts, [
      img('data:image/png;base64,cur'),
    ]);

    expect(parts).toEqual([
      { type: 'text', text: 'Task: compare' },
      { type: 'text', text: '[Image from prior turn: prior.png]' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,prior' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,cur' } },
    ]);
  });

  it('handles prior parts with no current attachments', () => {
    const priorParts = buildPriorTurnAttachmentParts([
      attachment({ type: 'image', filename: 'prior.png', content: 'data:image/png;base64,prior' }),
    ]);
    const parts = mergeInitialUserContentParts('Task: recall', priorParts, undefined);
    expect(parts).toEqual([
      { type: 'text', text: 'Task: recall' },
      { type: 'text', text: '[Image from prior turn: prior.png]' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,prior' } },
    ]);
  });
});
