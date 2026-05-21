/**
 * v2b/v2c — buildLinkedLibraryContext tests.
 *
 * Covers both payload channels: `systemText` (system-message block)
 * and `imageAttachments` (routed through the user-message attachment
 * path so vision-capable models can see image pixels).
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('./chat-library-client', () => ({
  collectionsGet: vi.fn(),
}));

import { collectionsGet } from './chat-library-client';
import {
  __test,
  buildLinkedLibraryContext,
  spliceLinkedImagesIntoLastUser,
} from './linked-library-context';
import type { AttachmentData, ChatMessage } from '@/types';

const mockedGet = collectionsGet as ReturnType<typeof vi.fn>;

afterEach(() => {
  mockedGet.mockReset();
});

describe('buildLinkedLibraryContext', () => {
  it('returns empty payload when libraryIds is empty', async () => {
    const result = await buildLinkedLibraryContext([]);
    expect(result.systemText).toBeUndefined();
    expect(result.imageAttachments).toEqual([]);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it('renders a single library with files into a labelled block', async () => {
    mockedGet.mockResolvedValueOnce({
      ok: true,
      data: {
        collection: {
          id: 'lib-1',
          name: 'Project ZERO',
          itemCount: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        items: [
          {
            id: 'item-1',
            libraryId: 'lib-1',
            type: 'document',
            filename: 'timeline.md',
            mimeType: 'text/markdown',
            sizeBytes: 100,
            content: '# Timeline\n\nContent here',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    });

    const result = await buildLinkedLibraryContext(['lib-1']);
    expect(result.systemText).toContain('# Linked libraries');
    expect(result.systemText).toContain('## Library: Project ZERO');
    expect(result.systemText).toContain('File: timeline.md');
    expect(result.systemText).toContain('# Timeline\n\nContent here');
    expect(result.imageAttachments).toEqual([]);
  });

  it('emits instructions block before files when present', async () => {
    mockedGet.mockResolvedValueOnce({
      ok: true,
      data: {
        collection: {
          id: 'lib-1',
          name: 'Project ZERO',
          itemCount: 1,
          instructions: 'Stay terse. Never invent canon.',
          createdAt: 1,
          updatedAt: 1,
        },
        items: [
          {
            id: 'item-1',
            libraryId: 'lib-1',
            type: 'document',
            filename: 'x.md',
            mimeType: 'text/markdown',
            sizeBytes: 10,
            content: 'x',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    });

    const result = await buildLinkedLibraryContext(['lib-1']);
    expect(result.systemText).toContain('[Instructions]');
    expect(result.systemText).toContain('Stay terse. Never invent canon.');
    const instructionsIdx = result.systemText?.indexOf('[Instructions]') ?? -1;
    const filesIdx = result.systemText?.indexOf('[Files]') ?? -1;
    expect(instructionsIdx).toBeLessThan(filesIdx);
  });

  it('skips stale or failed library fetches silently', async () => {
    mockedGet
      .mockResolvedValueOnce({ ok: false, code: 'NOT_FOUND', message: 'gone', status: 404 })
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({
        ok: true,
        data: {
          collection: {
            id: 'lib-3',
            name: 'Sentinel',
            itemCount: 0,
            createdAt: 1,
            updatedAt: 1,
          },
          items: [],
        },
      });

    const result = await buildLinkedLibraryContext(['lib-1', 'lib-2', 'lib-3']);
    expect(result.systemText).toBeDefined();
    expect(result.systemText).toContain('## Library: Sentinel');
    expect(result.systemText).not.toContain('lib-1');
    expect(result.systemText).not.toContain('lib-2');
    expect(result.imageAttachments).toEqual([]);
  });

  it('returns empty payload when every library fails to fetch', async () => {
    mockedGet.mockResolvedValueOnce({ ok: false, code: 'NOT_FOUND', message: 'gone', status: 404 });
    const result = await buildLinkedLibraryContext(['lib-1']);
    expect(result.systemText).toBeUndefined();
    expect(result.imageAttachments).toEqual([]);
  });

  it('renders an instructions-only library (no items) when instructions are set', async () => {
    mockedGet.mockResolvedValueOnce({
      ok: true,
      data: {
        collection: {
          id: 'lib-1',
          name: 'Voice notes',
          itemCount: 0,
          instructions: 'Sentences should be short.',
          createdAt: 1,
          updatedAt: 1,
        },
        items: [],
      },
    });

    const result = await buildLinkedLibraryContext(['lib-1']);
    expect(result.systemText).toContain('## Library: Voice notes');
    expect(result.systemText).toContain('[Instructions]');
    expect(result.systemText).toContain('Sentences should be short.');
    expect(result.systemText).not.toContain('[Files]');
  });

  it('uses Promise.all for parallel fetches', async () => {
    mockedGet.mockResolvedValue({
      ok: true,
      data: {
        collection: {
          id: 'lib-x',
          name: 'X',
          itemCount: 0,
          createdAt: 1,
          updatedAt: 1,
        },
        items: [],
      },
    });
    await buildLinkedLibraryContext(['lib-1', 'lib-2', 'lib-3']);
    expect(mockedGet).toHaveBeenCalledTimes(3);
  });

  it('hard-truncates a library that pushes past the 400KB cap and lists later libraries by name', async () => {
    const huge = 'x'.repeat(500 * 1024);
    mockedGet
      .mockResolvedValueOnce({
        ok: true,
        data: {
          collection: {
            id: 'A',
            name: 'A',
            itemCount: 1,
            createdAt: 1,
            updatedAt: 1,
          },
          items: [
            {
              id: 'i-1',
              libraryId: 'A',
              type: 'document',
              filename: 'big.md',
              mimeType: 'text/markdown',
              sizeBytes: huge.length,
              content: huge,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          collection: { id: 'B', name: 'Beta', itemCount: 0, createdAt: 1, updatedAt: 1 },
          items: [],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          collection: { id: 'C', name: 'Gamma', itemCount: 0, createdAt: 1, updatedAt: 1 },
          items: [],
        },
      });

    const result = await buildLinkedLibraryContext(['A', 'B', 'C']);
    expect(result.systemText).toBeDefined();
    expect(result.systemText).toContain('Truncated: library "A"');
    expect(result.systemText).toContain('Skipped due to');
    expect(result.systemText).toContain('Beta');
    expect(result.systemText).toContain('Gamma');
    expect(result.systemText!.length).toBeLessThan(500 * 1024);
  });

  it('escapes triple-backtick content so a markdown library cannot prematurely close the fence', async () => {
    const trickyContent =
      'Here is a code block in the library:\n\n```\nsome code\n```\n\nAnd after.';
    mockedGet.mockResolvedValueOnce({
      ok: true,
      data: {
        collection: {
          id: 'lib-1',
          name: 'Tricky',
          itemCount: 1,
          createdAt: 1,
          updatedAt: 1,
        },
        items: [
          {
            id: 'i-1',
            libraryId: 'lib-1',
            type: 'document',
            filename: 'has-fences.md',
            mimeType: 'text/markdown',
            sizeBytes: trickyContent.length,
            content: trickyContent,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    });
    const result = await buildLinkedLibraryContext(['lib-1']);
    expect(result.systemText).toBeDefined();
    expect(result.systemText).toContain('````');
    expect(result.systemText).toContain('```\nsome code\n```');
  });

  // -------------------------------------------------------------------------
  // v2c — image routing
  // -------------------------------------------------------------------------

  it('routes image items through the imageAttachments channel and surfaces a system-text reference', async () => {
    const imageDataUrl = 'data:image/png;base64,iVBORw0K/example/';
    mockedGet.mockResolvedValueOnce({
      ok: true,
      data: {
        collection: {
          id: 'lib-1',
          name: 'Visuals',
          itemCount: 2,
          createdAt: 1,
          updatedAt: 1,
        },
        items: [
          {
            id: 'i-img',
            libraryId: 'lib-1',
            type: 'image',
            filename: 'diagram.png',
            mimeType: 'image/png',
            sizeBytes: 12345,
            content: imageDataUrl,
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: 'i-doc',
            libraryId: 'lib-1',
            type: 'document',
            filename: 'notes.md',
            mimeType: 'text/markdown',
            sizeBytes: 10,
            content: 'notes',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    });
    const result = await buildLinkedLibraryContext(['lib-1']);
    // System text gets the metadata reference so the model can
    // correlate the inbound image_url block with the library.
    expect(result.systemText).toContain('[Image: diagram.png');
    expect(result.systemText).toContain('pixels delivered via user-message attachment');
    // Image pixels travel via imageAttachments, not the system text.
    expect(result.systemText).not.toContain('iVBORw0K');
    expect(result.imageAttachments).toHaveLength(1);
    const att = result.imageAttachments[0];
    expect(att.type).toBe('image');
    expect(att.filename).toBe('diagram.png');
    expect(att.mimeType).toBe('image/png');
    expect(att.content).toBe(imageDataUrl);
    // Re-stamped id namespaced under the library so multiple turns
    // can re-inject without collisions.
    expect(att.id.startsWith('linked-lib-1-i-img-')).toBe(true);
  });

  it('forwards multiple images across multiple libraries', async () => {
    mockedGet
      .mockResolvedValueOnce({
        ok: true,
        data: {
          collection: { id: 'L1', name: 'L1', itemCount: 1, createdAt: 1, updatedAt: 1 },
          items: [
            {
              id: 'a',
              libraryId: 'L1',
              type: 'image',
              filename: 'a.png',
              mimeType: 'image/png',
              sizeBytes: 10,
              content: 'data:image/png;base64,a',
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          collection: { id: 'L2', name: 'L2', itemCount: 1, createdAt: 1, updatedAt: 1 },
          items: [
            {
              id: 'b',
              libraryId: 'L2',
              type: 'image',
              filename: 'b.jpg',
              mimeType: 'image/jpeg',
              sizeBytes: 20,
              content: 'data:image/jpeg;base64,b',
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
      });
    const result = await buildLinkedLibraryContext(['L1', 'L2']);
    expect(result.imageAttachments).toHaveLength(2);
    expect(result.imageAttachments.map((a) => a.filename).sort()).toEqual(['a.png', 'b.jpg']);
  });

  it('drops images from libraries whose text content was fully skipped by the byte cap', async () => {
    // Library A is huge — its text fills the cap. Library B is small
    // but gets pushed entirely into the skipped tail; its image must
    // NOT show up as an orphan attachment.
    const huge = 'x'.repeat(500 * 1024);
    mockedGet
      .mockResolvedValueOnce({
        ok: true,
        data: {
          collection: { id: 'A', name: 'A', itemCount: 1, createdAt: 1, updatedAt: 1 },
          items: [
            {
              id: 'a',
              libraryId: 'A',
              type: 'document',
              filename: 'big.md',
              mimeType: 'text/markdown',
              sizeBytes: huge.length,
              content: huge,
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          collection: { id: 'B', name: 'B', itemCount: 1, createdAt: 1, updatedAt: 1 },
          items: [
            {
              id: 'orphan',
              libraryId: 'B',
              type: 'image',
              filename: 'orphan.png',
              mimeType: 'image/png',
              sizeBytes: 10,
              content: 'data:image/png;base64,orphan',
              createdAt: 1,
              updatedAt: 1,
            },
          ],
        },
      });
    const result = await buildLinkedLibraryContext(['A', 'B']);
    // B is in the "skipped" tail of the system text...
    expect(result.systemText).toContain('Skipped due to');
    expect(result.systemText).toContain(': B');
    // ...so its image should not be forwarded as an orphan attachment.
    expect(result.imageAttachments).toEqual([]);
  });

  it('drops images from a boundary-truncated library whose text was sliced', async () => {
    // Library A is just over the cap so it gets partial-text inclusion
    // (boundary truncated, remaining > 0). Its image must NOT be
    // forwarded because the [Image: …] reference line may have been
    // cut off by the slice, which would orphan the image_url block on
    // the model side.
    const huge = 'x'.repeat(500 * 1024);
    mockedGet.mockResolvedValueOnce({
      ok: true,
      data: {
        collection: { id: 'A', name: 'Heavy', itemCount: 2, createdAt: 1, updatedAt: 1 },
        items: [
          {
            id: 'doc',
            libraryId: 'A',
            type: 'document',
            filename: 'big.md',
            mimeType: 'text/markdown',
            sizeBytes: huge.length,
            content: huge,
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: 'pic',
            libraryId: 'A',
            type: 'image',
            filename: 'orphan.png',
            mimeType: 'image/png',
            sizeBytes: 10,
            content: 'data:image/png;base64,orphan',
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    });
    const result = await buildLinkedLibraryContext(['A']);
    // System text shows the truncation marker AND mentions the
    // dropped-images behavior so the model isn't confused.
    expect(result.systemText).toContain('Truncated: library "Heavy"');
    expect(result.systemText).toContain('Image attachments from this library were also dropped');
    // No image attachments forwarded -- orphan pixels avoided.
    expect(result.imageAttachments).toEqual([]);
  });

  it('caps total image bytes per turn and lists skipped image names in the tail', async () => {
    // Three 800KB images = 2.4MB total. The 1.5MB image cap admits
    // the first one (800KB), rejects the rest. Skipped image names
    // appear in the system text tail so the model knows not to
    // reference them.
    const bigImage = (label: string) => `data:image/png;base64,${'A'.repeat(800 * 1024)}-${label}`;
    mockedGet.mockResolvedValueOnce({
      ok: true,
      data: {
        collection: { id: 'A', name: 'Visuals', itemCount: 3, createdAt: 1, updatedAt: 1 },
        items: [
          {
            id: 'i1',
            libraryId: 'A',
            type: 'image',
            filename: 'first.png',
            mimeType: 'image/png',
            sizeBytes: 800 * 1024,
            content: bigImage('first'),
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: 'i2',
            libraryId: 'A',
            type: 'image',
            filename: 'second.png',
            mimeType: 'image/png',
            sizeBytes: 800 * 1024,
            content: bigImage('second'),
            createdAt: 1,
            updatedAt: 1,
          },
          {
            id: 'i3',
            libraryId: 'A',
            type: 'image',
            filename: 'third.png',
            mimeType: 'image/png',
            sizeBytes: 800 * 1024,
            content: bigImage('third'),
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    });
    const result = await buildLinkedLibraryContext(['A']);
    // Only the first image fits in the 1.5MB budget.
    expect(result.imageAttachments).toHaveLength(1);
    expect(result.imageAttachments[0].filename).toBe('first.png');
    // Skipped images are explicit in the system text so the model
    // doesn't try to reference invisible images.
    expect(result.systemText).toContain('Skipped image attachments');
    expect(result.systemText).toContain('second.png');
    expect(result.systemText).toContain('third.png');
  });
});

// ---------------------------------------------------------------------------
// v2c — spliceLinkedImagesIntoLastUser
// ---------------------------------------------------------------------------

describe('spliceLinkedImagesIntoLastUser', () => {
  function userMsg(id: string, content: string, attachments?: AttachmentData[]): ChatMessage {
    return {
      id,
      role: 'user',
      content,
      timestamp: 0,
      ...(attachments ? { attachments } : {}),
    } as ChatMessage;
  }
  function assistantMsg(id: string, content: string): ChatMessage {
    return { id, role: 'assistant', content, timestamp: 0 } as ChatMessage;
  }
  function image(id: string, name: string): AttachmentData {
    return {
      id,
      type: 'image',
      filename: name,
      mimeType: 'image/png',
      sizeBytes: 10,
      content: `data:image/png;base64,${name}`,
    };
  }

  it('returns the same array reference when imageAttachments is empty', () => {
    const messages: ChatMessage[] = [userMsg('u1', 'hi')];
    const out = spliceLinkedImagesIntoLastUser(messages, []);
    expect(out).toBe(messages);
  });

  it('returns the same array reference when no user message exists', () => {
    const messages: ChatMessage[] = [assistantMsg('a1', 'hello')];
    const out = spliceLinkedImagesIntoLastUser(messages, [image('img1', 'a.png')]);
    expect(out).toBe(messages);
  });

  it('appends image attachments onto a clone of the latest user message', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'first'),
      assistantMsg('a1', 'reply'),
      userMsg('u2', 'second'),
    ];
    const att = image('img1', 'pic.png');
    const out = spliceLinkedImagesIntoLastUser(messages, [att]);

    // New top-level array reference.
    expect(out).not.toBe(messages);
    // Earlier messages keep reference identity (cache-warm).
    expect(out[0]).toBe(messages[0]);
    expect(out[1]).toBe(messages[1]);
    // Last user message is cloned, not mutated.
    expect(out[2]).not.toBe(messages[2]);
    expect(messages[2].attachments).toBeUndefined();
    // Clone carries the new attachment + same content.
    expect(out[2].content).toBe('second');
    expect(out[2].attachments).toEqual([att]);
  });

  it('preserves existing user attachments and appends new ones after them', () => {
    const existing = image('existing', 'a.png');
    const linked = image('linked', 'b.png');
    const messages: ChatMessage[] = [userMsg('u1', 'hi', [existing])];
    const out = spliceLinkedImagesIntoLastUser(messages, [linked]);

    expect(out[0].attachments).toEqual([existing, linked]);
    // Original message still has only its original attachments.
    expect(messages[0].attachments).toEqual([existing]);
    // Cloned message's attachments array is a fresh array.
    expect(out[0].attachments).not.toBe(messages[0].attachments);
  });

  it('appends to the LAST user message when multiple exist', () => {
    const messages: ChatMessage[] = [
      userMsg('u1', 'first'),
      assistantMsg('a1', 'reply'),
      userMsg('u2', 'second'),
      assistantMsg('a2', 'reply'),
      userMsg('u3', 'third'),
    ];
    const att = image('img', 'p.png');
    const out = spliceLinkedImagesIntoLastUser(messages, [att]);
    expect(out[4].id).toBe('u3');
    expect(out[4].attachments).toEqual([att]);
    expect(out[0].attachments).toBeUndefined();
    expect(out[2].attachments).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// shortRandomSuffix — crypto.randomUUID fallback
// ---------------------------------------------------------------------------

describe('shortRandomSuffix', () => {
  it('returns an 8-char id when crypto.randomUUID succeeds', () => {
    const id = __test.shortRandomSuffix();
    expect(id).toHaveLength(8);
  });

  it('falls back to Math.random when crypto.randomUUID throws (non-secure context simulation)', () => {
    const original = crypto.randomUUID;
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw new Error('randomUUID requires a secure context');
    });
    try {
      const id = __test.shortRandomSuffix();
      expect(id).toHaveLength(8);
      // Math.random fallback emits base36 chars — should not throw and
      // should not return the literal "undefined" string from a swallowed
      // error path.
      expect(id).not.toContain('undefined');
    } finally {
      vi.spyOn(crypto, 'randomUUID').mockImplementation(original);
    }
  });
});
