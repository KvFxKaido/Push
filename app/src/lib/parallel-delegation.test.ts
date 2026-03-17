import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockExecInSandbox,
  mockBatchWriteToSandbox,
  mockCreateSandbox,
  mockCleanupSandbox,
  mockDownloadFromSandbox,
  mockDownloadFileFromSandbox,
  mockHydrateSnapshotInSandbox,
  mockDeleteFromSandbox,
  mockRunCoderAgent,
  mockGenerateCheckpointAnswer,
} = vi.hoisted(() => ({
  mockExecInSandbox: vi.fn(),
  mockBatchWriteToSandbox: vi.fn(),
  mockCreateSandbox: vi.fn(),
  mockCleanupSandbox: vi.fn(),
  mockDownloadFromSandbox: vi.fn(),
  mockDownloadFileFromSandbox: vi.fn(),
  mockHydrateSnapshotInSandbox: vi.fn(),
  mockDeleteFromSandbox: vi.fn(),
  mockRunCoderAgent: vi.fn(),
  mockGenerateCheckpointAnswer: vi.fn(),
}));

vi.mock('./sandbox-client', () => ({
  execInSandbox: (...args: unknown[]) => mockExecInSandbox(...args),
  batchWriteToSandbox: (...args: unknown[]) => mockBatchWriteToSandbox(...args),
  createSandbox: (...args: unknown[]) => mockCreateSandbox(...args),
  cleanupSandbox: (...args: unknown[]) => mockCleanupSandbox(...args),
  downloadFromSandbox: (...args: unknown[]) => mockDownloadFromSandbox(...args),
  downloadFileFromSandbox: (...args: unknown[]) => mockDownloadFileFromSandbox(...args),
  hydrateSnapshotInSandbox: (...args: unknown[]) => mockHydrateSnapshotInSandbox(...args),
  deleteFromSandbox: (...args: unknown[]) => mockDeleteFromSandbox(...args),
}));

vi.mock('./coder-agent', () => ({
  runCoderAgent: (...args: unknown[]) => mockRunCoderAgent(...args),
  generateCheckpointAnswer: (...args: unknown[]) => mockGenerateCheckpointAnswer(...args),
}));

import { runParallelDelegation } from './parallel-delegation';

describe('runParallelDelegation', () => {
  beforeEach(() => {
    mockExecInSandbox.mockReset();
    mockBatchWriteToSandbox.mockReset();
    mockCreateSandbox.mockReset();
    mockCleanupSandbox.mockReset();
    mockDownloadFromSandbox.mockReset();
    mockDownloadFileFromSandbox.mockReset();
    mockHydrateSnapshotInSandbox.mockReset();
    mockDeleteFromSandbox.mockReset();
    mockRunCoderAgent.mockReset();
    mockGenerateCheckpointAnswer.mockReset();

    mockExecInSandbox.mockResolvedValue({
      stdout: '---HEAD---\nabc123\n---STATUS---\n',
      stderr: '',
      exitCode: 0,
      truncated: false,
      workspaceRevision: 7,
    });
    mockDownloadFromSandbox.mockResolvedValue({
      ok: true,
      archiveBase64: 'ZmFrZS1hcmNoaXZl',
    });
    mockCreateSandbox.mockResolvedValue({
      sandboxId: 'worker-1',
      ownerToken: 'owner-token',
      status: 'ready',
    });
    mockHydrateSnapshotInSandbox.mockResolvedValue({ ok: true });
    mockCleanupSandbox.mockResolvedValue(undefined);
    mockGenerateCheckpointAnswer.mockResolvedValue('continue');
  });

  it('rethrows AbortError instead of downgrading cancellation to partial failure', async () => {
    mockRunCoderAgent.mockRejectedValue(new DOMException('Coder cancelled by user.', 'AbortError'));

    await expect(runParallelDelegation(
      {
        tasks: ['Refactor the shared helper'],
        files: [],
        provider: 'openrouter',
        activeSandboxId: 'active-sandbox',
        sourceRepo: 'KvFxKaido/Push',
        sourceBranch: 'main',
        authToken: 'gh-token',
        recentChatHistory: [],
      },
      {
        onStatus: () => {},
      },
    )).rejects.toMatchObject({ name: 'AbortError' });

    expect(mockCleanupSandbox).toHaveBeenCalledWith('worker-1');
  });
});
