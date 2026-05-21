/**
 * v2b — buildLinkedLibraryContext tests.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('./chat-library-client', () => ({
  collectionsGet: vi.fn(),
}));

import { collectionsGet } from './chat-library-client';
import { buildLinkedLibraryContext } from './linked-library-context';

const mockedGet = collectionsGet as ReturnType<typeof vi.fn>;

afterEach(() => {
  mockedGet.mockReset();
});

describe('buildLinkedLibraryContext', () => {
  it('returns undefined when libraryIds is empty', async () => {
    const result = await buildLinkedLibraryContext([]);
    expect(result).toBeUndefined();
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
    expect(result).toContain('# Linked libraries');
    expect(result).toContain('## Library: Project ZERO');
    expect(result).toContain('File: timeline.md');
    expect(result).toContain('# Timeline\n\nContent here');
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
    expect(result).toContain('[Instructions]');
    expect(result).toContain('Stay terse. Never invent canon.');
    const instructionsIdx = result?.indexOf('[Instructions]') ?? -1;
    const filesIdx = result?.indexOf('[Files]') ?? -1;
    expect(instructionsIdx).toBeLessThan(filesIdx);
  });

  it('skips stale or failed library fetches silently', async () => {
    // lib-1 missing → ok:false, lib-2 fetch throws, lib-3 succeeds.
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
    expect(result).toBeDefined();
    expect(result).toContain('## Library: Sentinel');
    expect(result).not.toContain('lib-1');
    expect(result).not.toContain('lib-2');
  });

  it('returns undefined when every library fails to fetch', async () => {
    mockedGet.mockResolvedValueOnce({ ok: false, code: 'NOT_FOUND', message: 'gone', status: 404 });
    const result = await buildLinkedLibraryContext(['lib-1']);
    expect(result).toBeUndefined();
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
    expect(result).toContain('## Library: Voice notes');
    expect(result).toContain('[Instructions]');
    expect(result).toContain('Sentences should be short.');
    expect(result).not.toContain('[Files]');
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
    // The mock is shared across calls; just confirm 3 invocations
    // happened (parallelism comes from Promise.all in the helper).
    expect(mockedGet).toHaveBeenCalledTimes(3);
  });

  it('hard-truncates a library that pushes past the 400KB cap and lists later libraries by name', async () => {
    // Library A is huge (well over 400KB), B and C are normal-sized.
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
          collection: {
            id: 'B',
            name: 'Beta',
            itemCount: 0,
            createdAt: 1,
            updatedAt: 1,
          },
          items: [],
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        data: {
          collection: {
            id: 'C',
            name: 'Gamma',
            itemCount: 0,
            createdAt: 1,
            updatedAt: 1,
          },
          items: [],
        },
      });

    const result = await buildLinkedLibraryContext(['A', 'B', 'C']);
    expect(result).toBeDefined();
    // Truncation marker for A appears.
    expect(result).toContain('Truncated: library "A"');
    // Later libraries skipped and announced by name (not silently dropped).
    expect(result).toContain('Skipped due to');
    expect(result).toContain('Beta');
    expect(result).toContain('Gamma');
    // Total rendered length is bounded (cap + framing prose).
    expect(result!.length).toBeLessThan(500 * 1024);
  });
});
