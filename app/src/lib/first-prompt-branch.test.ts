import { beforeEach, describe, expect, it, vi } from 'vitest';

const modelProposerMocks = vi.hoisted(() => ({
  getActiveProvider: vi.fn(() => 'demo'),
  getProviderPushStream: vi.fn((provider: string) => `stream:${provider}`),
  getModelForRole: vi.fn(() => ({ id: 'global-model' })),
  iteratePushStreamText: vi.fn(async () => ({
    error: false,
    text: 'owner-repo/chat-route-name',
  })),
}));

vi.mock('./orchestrator-provider-routing', () => ({
  getActiveProvider: modelProposerMocks.getActiveProvider,
  getProviderPushStream: modelProposerMocks.getProviderPushStream,
}));

vi.mock('./providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./providers')>()),
  getModelForRole: modelProposerMocks.getModelForRole,
}));

vi.mock('@push/lib/stream-utils', () => ({
  iteratePushStreamText: modelProposerMocks.iteratePushStreamText,
}));

import {
  createModelFirstPromptBranchNameProposer,
  type FirstPromptBranchInput,
  maybeBranchOnFirstPrompt,
  shouldBranchOnFirstPrompt,
} from './first-prompt-branch';
import type { BranchForkMigrationContext } from './branch-fork-migration';

const base: FirstPromptBranchInput = {
  enabled: true,
  isFirstMessage: true,
  promptText: 'Add a feature',
  repoFullName: 'owner/repo',
  sandboxId: 'sb-1',
  currentBranch: 'main',
  defaultBranch: 'main',
};

beforeEach(() => {
  modelProposerMocks.getActiveProvider.mockClear();
  modelProposerMocks.getProviderPushStream.mockClear();
  modelProposerMocks.getModelForRole.mockClear();
  modelProposerMocks.iteratePushStreamText.mockClear();
  modelProposerMocks.iteratePushStreamText.mockResolvedValue({
    error: false,
    text: 'owner-repo/chat-route-name',
  });
});

describe('createModelFirstPromptBranchNameProposer', () => {
  it('uses the chat-locked provider and model when they are supplied', async () => {
    const proposeName = createModelFirstPromptBranchNameProposer({
      providerOverride: 'openai',
      modelOverride: 'gpt-5-mini',
    });

    await expect(
      proposeName({
        promptText: 'stop creating draft branches',
        repoFullName: 'owner/repo',
        prefix: 'owner-repo',
      }),
    ).resolves.toBe('owner-repo/chat-route-name');

    expect(modelProposerMocks.getActiveProvider).not.toHaveBeenCalled();
    expect(modelProposerMocks.getProviderPushStream).toHaveBeenCalledWith('openai');
    expect(modelProposerMocks.getModelForRole).not.toHaveBeenCalled();
    expect(modelProposerMocks.iteratePushStreamText).toHaveBeenCalledWith(
      'stream:openai',
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-5-mini',
        hasSandbox: false,
      }),
      2500,
      expect.stringContaining('2.5s'),
      12_000,
      expect.stringContaining('12s'),
      // Reasoning models must not burn the activity window thinking about the
      // name (the post-gateway regression: suggestions silently fell back to
      // the mechanical name), and slow first tokens through the gateway hop
      // need a grace wider than the inter-token window. The wall-clock above
      // is the mandatory backstop for the reasoning opt-in.
      { reasoningResetsActivityTimer: true, firstTokenGraceMs: 8000 },
    );
  });
});

describe('shouldBranchOnFirstPrompt', () => {
  it('is true on the happy path', () => {
    expect(shouldBranchOnFirstPrompt(base)).toBe(true);
  });

  it('is false when disabled, not first, no repo, no sandbox, or off the default branch', () => {
    expect(shouldBranchOnFirstPrompt({ ...base, enabled: false })).toBe(false);
    expect(shouldBranchOnFirstPrompt({ ...base, isFirstMessage: false })).toBe(false);
    expect(shouldBranchOnFirstPrompt({ ...base, repoFullName: null })).toBe(false);
    expect(shouldBranchOnFirstPrompt({ ...base, sandboxId: null })).toBe(false);
    expect(shouldBranchOnFirstPrompt({ ...base, currentBranch: 'feat/x' })).toBe(false);
  });

  it('does not branch when the current branch is unknown', () => {
    // Unknown branch must not be treated as the default branch — a session
    // started on an existing branch (whose metadata hasn't loaded) must not be
    // force-forked off it.
    expect(shouldBranchOnFirstPrompt({ ...base, currentBranch: undefined })).toBe(false);
  });

  it('does not branch when the current branch differs from the default', () => {
    expect(
      shouldBranchOnFirstPrompt({ ...base, currentBranch: 'main', defaultBranch: 'develop' }),
    ).toBe(false);
  });
});

describe('maybeBranchOnFirstPrompt', () => {
  const ctx = {} as BranchForkMigrationContext;

  it('no-ops without forking when ineligible', async () => {
    const fork = vi.fn();
    const apply = vi.fn();
    const result = await maybeBranchOnFirstPrompt({ ...base, enabled: false }, ctx, {
      fork,
      apply,
    });
    expect(result).toEqual({ branched: false });
    expect(fork).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('forks a worker-named branch and migrates the chat on success', async () => {
    const branchSwitch = { name: 'owner-repo/stop-draft-branches', kind: 'forked' as const };
    const fork = vi.fn().mockResolvedValue({ ok: true, branchSwitch });
    const apply = vi.fn();
    const proposeName = vi.fn(async () => 'stop-draft-branches');
    const result = await maybeBranchOnFirstPrompt(
      {
        ...base,
        promptText:
          'could we stop the web app from creating draft branches and just create the branch if it needs one?',
      },
      ctx,
      { fork, apply, proposeName },
    );
    expect(proposeName).toHaveBeenCalledWith({
      promptText:
        'could we stop the web app from creating draft branches and just create the branch if it needs one?',
      repoFullName: 'owner/repo',
      prefix: 'owner-repo',
    });
    expect(fork).toHaveBeenCalledWith('sb-1', 'owner-repo/stop-draft-branches');
    expect(apply).toHaveBeenCalledWith(branchSwitch, ctx);
    expect(result.branched).toBe(true);
    expect(result.name).toBe('owner-repo/stop-draft-branches');
  });

  it('falls back to the deterministic prompt slug when the proposer fails', async () => {
    const branchSwitch = { name: 'owner-repo/add-a-feature', kind: 'forked' as const };
    const fork = vi.fn().mockResolvedValue({ ok: true, branchSwitch });
    const apply = vi.fn();
    const proposeName = vi.fn(async () => {
      throw new Error('provider down');
    });
    const result = await maybeBranchOnFirstPrompt(base, ctx, { fork, apply, proposeName });
    expect(fork).toHaveBeenCalledWith('sb-1', 'owner-repo/add-a-feature');
    expect(result).toMatchObject({ branched: true, name: 'owner-repo/add-a-feature' });
  });

  it('reports the error and does not migrate when the fork fails', async () => {
    const fork = vi.fn().mockResolvedValue({ ok: false, errorMessage: 'no sandbox' });
    const apply = vi.fn();
    const result = await maybeBranchOnFirstPrompt(base, ctx, {
      fork,
      apply,
      proposeName: async () => null,
    });
    expect(apply).not.toHaveBeenCalled();
    expect(result).toMatchObject({ branched: false, error: 'no sandbox' });
    expect(fork).toHaveBeenCalledTimes(1); // non-collision error → no retry
  });

  it('retries with a numeric suffix on a name collision', async () => {
    const branchSwitch = { name: 'owner-repo/fix-login-2', kind: 'forked' as const };
    const fork = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, errorMessage: 'a branch named X already exists' })
      .mockResolvedValueOnce({ ok: true, branchSwitch });
    const apply = vi.fn();
    const result = await maybeBranchOnFirstPrompt({ ...base, promptText: 'Fix login' }, ctx, {
      fork,
      apply,
      proposeName: async () => 'fix-login',
    });
    expect(fork).toHaveBeenCalledTimes(2);
    expect(fork.mock.calls[1][1]).toMatch(/-2$/); // second attempt is suffixed
    expect(apply).toHaveBeenCalledWith(branchSwitch, ctx);
    expect(result.branched).toBe(true);
  });
});
