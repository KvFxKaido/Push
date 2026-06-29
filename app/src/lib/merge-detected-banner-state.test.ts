import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dismissMergeDetectedBanner,
  mergeDetectedCandidate,
  visibleMergeDetectedBannerForChat,
  type MergeDetectedBannerState,
} from './merge-detected-banner-state';
import type { MergedPRForBranch } from './github-tools';

function createStorageMock() {
  const data = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
    }),
  };
}

const mergedPR: MergedPRForBranch = {
  number: 42,
  title: 'Ship it',
  url: 'https://github.test/pr/42',
  mergedAt: '2026-06-12T00:00:00Z',
  baseBranch: 'main',
  headSha: 'sha-merged',
};

const candidate: MergeDetectedBannerState = {
  branch: 'feature/merged',
  defaultBranch: 'main',
  baseBranch: 'main',
  pr: mergedPR,
};

beforeEach(() => {
  vi.stubGlobal('window', { localStorage: createStorageMock() });
});

describe('merge detected banner dismissal state', () => {
  it('persists dismissal for one chat without suppressing another chat', () => {
    expect(visibleMergeDetectedBannerForChat('chat-1', candidate)).toBe(candidate);

    dismissMergeDetectedBanner('chat-1');

    expect(visibleMergeDetectedBannerForChat('chat-1', candidate)).toBeNull();
    expect(visibleMergeDetectedBannerForChat('chat-2', candidate)).toBe(candidate);
  });
});

describe('mergeDetectedCandidate', () => {
  it('builds a candidate when the PR merged into the default branch', () => {
    expect(mergeDetectedCandidate('feature/merged', 'main', mergedPR)).toEqual(candidate);
  });

  it('builds a candidate when the PR merged into a non-default base', () => {
    const stacked: MergedPRForBranch = { ...mergedPR, baseBranch: 'develop' };
    expect(mergeDetectedCandidate('feature/merged', 'main', stacked)).toEqual({
      branch: 'feature/merged',
      defaultBranch: 'main',
      baseBranch: 'develop',
      pr: stacked,
    });
  });

  it('returns null when the current branch already matches the PR base', () => {
    expect(mergeDetectedCandidate('main', 'main', mergedPR)).toBeNull();
  });

  it('returns null when there is no merged PR', () => {
    expect(mergeDetectedCandidate('feature/merged', 'main', null)).toBeNull();
  });
});
