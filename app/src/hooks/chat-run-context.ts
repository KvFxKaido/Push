import {
  buildRuntimeMemoryScope,
  createRuntimeContext,
  type PushRuntimeContext,
} from '@push/lib/runtime-context';

interface CreateWebRunRuntimeContextInput {
  chatId: string;
  runId: string;
  repoFullName: string | null | undefined;
  branchInfo?: { currentBranch?: string; defaultBranch?: string } | null;
}

export function createWebRunRuntimeContext({
  chatId,
  runId,
  repoFullName,
  branchInfo,
}: CreateWebRunRuntimeContextInput): PushRuntimeContext {
  const branch = branchInfo?.currentBranch ?? branchInfo?.defaultBranch ?? null;
  return createRuntimeContext({
    // runId rides correlation only; the durable memory scope stays run-agnostic
    // (matches the prior buildMemoryScope(chatId, repo, branch) shape).
    correlation: { surface: 'web', chatId, runId },
    memory: {
      scope: buildRuntimeMemoryScope({
        repoFullName,
        branch,
        chatId,
      }),
    },
  });
}
