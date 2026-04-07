import { buildRetrievedMemoryKnownContext } from '@/lib/context-memory';
import type { MemoryQuery, MemoryScope } from '@/types';
import { parseDiffStats } from './diff-utils';
import {
  buildAuditorContextBlock,
  buildReviewerContextBlock,
  type AuditorPromptContext,
  type ReviewerPromptContext,
} from './role-context';

const MAX_RETRIEVED_MEMORY_RECORDS = 5;
const ROLE_MEMORY_SECTION_BUDGETS = {
  facts: 600,
  taskMemory: 700,
  verification: 500,
  stale: 250,
} as const;

function formatMemoryError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

function logRoleMemoryWarning(role: string, error: unknown): void {
  console.warn(
    `[context-memory] retrieving ${role} prompt context failed; continuing without retrieved memory.`,
    formatMemoryError(error),
  );
}

function appendRetrievedMemoryBlock(baseContext: string, block: string | null): string {
  if (!block) return baseContext;
  if (!baseContext.trim()) return block;
  return `${baseContext}\n\n${block}`;
}

function buildFileHintsFromDiff(diff: string | null | undefined): string[] | undefined {
  if (!diff?.trim()) return undefined;
  const fileNames = parseDiffStats(diff).fileNames.slice(0, 8);
  return fileNames.length > 0 ? fileNames : undefined;
}

async function buildRoleRetrievedMemoryBlock(query: MemoryQuery): Promise<string | null> {
  try {
    const { line } = await buildRetrievedMemoryKnownContext(query, {
      sectionBudgets: ROLE_MEMORY_SECTION_BUDGETS,
    });
    return line;
  } catch (error) {
    logRoleMemoryWarning(query.role, error);
    return null;
  }
}

function buildTaskText(prefix: string, primary: string, fileHints?: string[]): string {
  return [prefix, primary, ...(fileHints ?? []).slice(0, 4)].filter(Boolean).join(' ').trim();
}

function toScopedQuery(
  scope: Pick<MemoryScope, 'repoFullName' | 'branch' | 'chatId' | 'taskGraphId' | 'taskId'>,
  role: MemoryQuery['role'],
  taskText: string,
  fileHints?: string[],
): MemoryQuery {
  return {
    repoFullName: scope.repoFullName,
    branch: scope.branch,
    chatId: scope.chatId,
    taskGraphId: scope.taskGraphId,
    taskId: scope.taskId,
    role,
    taskText,
    fileHints,
    maxRecords: MAX_RETRIEVED_MEMORY_RECORDS,
  };
}

export async function buildReviewerRuntimeContext(
  diff: string,
  context?: ReviewerPromptContext,
): Promise<string> {
  const baseContext = buildReviewerContextBlock(context);
  if (!context?.repoFullName) return baseContext;

  const fileHints = buildFileHintsFromDiff(diff);
  const block = await buildRoleRetrievedMemoryBlock(
    toScopedQuery(
      {
        repoFullName: context.repoFullName,
        branch: context.activeBranch,
      },
      'reviewer',
      buildTaskText('review', context.sourceLabel ?? 'diff review', fileHints),
      fileHints,
    ),
  );

  return appendRetrievedMemoryBlock(baseContext, block);
}

export async function buildAuditorRuntimeContext(
  diff: string,
  context?: AuditorPromptContext,
): Promise<string> {
  const baseContext = buildAuditorContextBlock(context);
  if (!context?.repoFullName) return baseContext;

  const fileHints = buildFileHintsFromDiff(diff);
  const block = await buildRoleRetrievedMemoryBlock(
    toScopedQuery(
      {
        repoFullName: context.repoFullName,
        branch: context.activeBranch,
      },
      'auditor',
      buildTaskText('audit', context.sourceLabel ?? 'diff audit', fileHints),
      fileHints,
    ),
  );

  return appendRetrievedMemoryBlock(baseContext, block);
}

export async function buildAuditorEvaluationMemoryBlock(
  task: string,
  diff: string | null,
  scope?: Pick<MemoryScope, 'repoFullName' | 'branch' | 'chatId' | 'taskGraphId' | 'taskId'> | null,
): Promise<string | null> {
  if (!scope?.repoFullName) return null;

  const fileHints = buildFileHintsFromDiff(diff);
  return buildRoleRetrievedMemoryBlock(
    toScopedQuery(
      scope,
      'auditor',
      buildTaskText('evaluate completion', task, fileHints),
      fileHints,
    ),
  );
}
