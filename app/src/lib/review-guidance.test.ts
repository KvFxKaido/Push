import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockReadFromSandbox, mockFetchReviewGuidance } = vi.hoisted(() => ({
  mockReadFromSandbox: vi.fn(),
  mockFetchReviewGuidance: vi.fn(),
}));

vi.mock('@/lib/sandbox-client', () => ({
  readFromSandbox: (...args: unknown[]) => mockReadFromSandbox(...args),
}));

vi.mock('@/lib/github-tools', () => ({
  fetchReviewGuidance: (...args: unknown[]) => mockFetchReviewGuidance(...args),
}));

import { resolveReviewGuidance } from './review-guidance';

describe('resolveReviewGuidance', () => {
  beforeEach(() => {
    mockReadFromSandbox.mockReset();
    mockFetchReviewGuidance.mockReset();
  });

  it('prefers the sandbox working copy when a sandbox is ready', async () => {
    mockReadFromSandbox.mockResolvedValue({
      content: '# REVIEW.md\nsandbox copy',
      truncated: false,
    });

    const result = await resolveReviewGuidance({
      repoFullName: 'owner/repo',
      ref: 'main',
      sandboxId: 'sb-1',
    });

    expect(result).toBe('# REVIEW.md\nsandbox copy');
    expect(mockReadFromSandbox).toHaveBeenCalledWith('sb-1', '/workspace/REVIEW.md', 1, 600);
    expect(mockFetchReviewGuidance).not.toHaveBeenCalled();
  });

  it('falls back to GitHub when the sandbox read errors', async () => {
    mockReadFromSandbox.mockResolvedValue({ content: '', truncated: false, error: 'not found' });
    mockFetchReviewGuidance.mockResolvedValue('# REVIEW.md\ngithub copy');

    const result = await resolveReviewGuidance({
      repoFullName: 'owner/repo',
      ref: 'main',
      sandboxId: 'sb-1',
    });

    expect(result).toBe('# REVIEW.md\ngithub copy');
    expect(mockFetchReviewGuidance).toHaveBeenCalledWith('owner/repo', 'main');
  });

  it('reads from GitHub on the given ref when no sandbox is available', async () => {
    mockFetchReviewGuidance.mockResolvedValue('# REVIEW.md\ngithub copy');

    const result = await resolveReviewGuidance({ repoFullName: 'owner/repo', ref: 'main' });

    expect(result).toBe('# REVIEW.md\ngithub copy');
    expect(mockReadFromSandbox).not.toHaveBeenCalled();
    expect(mockFetchReviewGuidance).toHaveBeenCalledWith('owner/repo', 'main');
  });

  it('returns null when no REVIEW.md exists anywhere', async () => {
    mockFetchReviewGuidance.mockResolvedValue(null);

    const result = await resolveReviewGuidance({ repoFullName: 'owner/repo', ref: 'main' });

    expect(result).toBeNull();
  });

  it('never throws when both sources fail', async () => {
    mockReadFromSandbox.mockRejectedValue(new Error('sandbox down'));
    mockFetchReviewGuidance.mockRejectedValue(new Error('github down'));

    const result = await resolveReviewGuidance({
      repoFullName: 'owner/repo',
      ref: 'main',
      sandboxId: 'sb-1',
    });

    expect(result).toBeNull();
  });

  it('returns null with no repo and no sandbox', async () => {
    const result = await resolveReviewGuidance({});
    expect(result).toBeNull();
    expect(mockReadFromSandbox).not.toHaveBeenCalled();
    expect(mockFetchReviewGuidance).not.toHaveBeenCalled();
  });
});
