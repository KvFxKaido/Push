import { afterEach, describe, expect, it } from 'vitest';
import { clearRepoMetadataCache, getRepoMetadata, setRepoMetadata } from './repo-metadata';

afterEach(() => {
  clearRepoMetadataCache();
});

describe('repo-metadata cache', () => {
  it('round-trips metadata by full_name', () => {
    setRepoMetadata('KvFxKaido/Push', { topics: ['ai', 'agents'], language: 'TypeScript' });
    expect(getRepoMetadata('KvFxKaido/Push')).toEqual({
      topics: ['ai', 'agents'],
      language: 'TypeScript',
    });
  });

  it('looks up case-insensitively (full_name casing varies across GitHub APIs)', () => {
    setRepoMetadata('KvFxKaido/Push', { topics: ['ai'], language: 'TypeScript' });
    expect(getRepoMetadata('kvfxkaido/push')?.topics).toEqual(['ai']);
  });

  it('returns null for unknown or empty keys', () => {
    expect(getRepoMetadata('nobody/here')).toBeNull();
    expect(getRepoMetadata(null)).toBeNull();
    expect(getRepoMetadata(undefined)).toBeNull();
    expect(getRepoMetadata('')).toBeNull();
  });

  it('ignores empty full_name on write', () => {
    setRepoMetadata('', { topics: ['x'], language: null });
    expect(getRepoMetadata('')).toBeNull();
  });
});
