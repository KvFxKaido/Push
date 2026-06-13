import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  dismissMergeDetectedBanner,
  visibleMergeDetectedBannerForChat,
  type MergeDetectedBannerState,
} from './merge-detected-banner-state';

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

const candidate: MergeDetectedBannerState = {
  branch: 'feature/merged',
  defaultBranch: 'main',
  pr: {
    number: 42,
    title: 'Ship it',
    url: 'https://github.test/pr/42',
    mergedAt: '2026-06-12T00:00:00Z',
  },
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
