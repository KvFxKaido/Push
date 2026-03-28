import type { BranchListCardData, ToolExecutionResult } from '@/types';
import { getGitHubAuthHeaders } from './github-auth';

export type GitHubToolBackend = 'legacy' | 'worker';
export type WorkerGitHubToolName = 'fetch_pr' | 'list_branches' | 'search_files';

export type WorkerGitHubToolCall =
  | { tool: 'fetch_pr'; args: { repo: string; pr: number } }
  | { tool: 'list_branches'; args: { repo: string; maxBranches?: number } }
  | { tool: 'search_files'; args: { repo: string; query: string; path?: string; branch?: string } };

interface WorkerGitHubToolResponse {
  result?: ToolExecutionResult;
  error?: string;
  details?: string;
}

function normalizeGitHubToolBackend(value: string | undefined): GitHubToolBackend {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'worker' || normalized === 'mcp' ? 'worker' : 'legacy';
}

export function getGitHubToolBackend(): GitHubToolBackend {
  return normalizeGitHubToolBackend(import.meta.env.VITE_GITHUB_TOOL_BACKEND);
}

export function supportsWorkerGitHubTool(name: string): name is WorkerGitHubToolName {
  return name === 'fetch_pr' || name === 'list_branches' || name === 'search_files';
}

async function postGitHubToolRequest(
  payload: WorkerGitHubToolCall & { allowedRepo: string },
): Promise<WorkerGitHubToolResponse> {
  const response = await fetch('/api/github/tools', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...getGitHubAuthHeaders(),
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json().catch(() => null) as WorkerGitHubToolResponse | null;
  if (!response.ok) {
    const message = data?.error || data?.details || `GitHub tool worker returned ${response.status}`;
    throw new Error(message);
  }

  if (!data) {
    throw new Error('GitHub tool worker returned an empty response');
  }

  return data;
}

export async function executeGitHubToolViaWorker(
  call: WorkerGitHubToolCall,
  allowedRepo: string,
): Promise<ToolExecutionResult> {
  const data = await postGitHubToolRequest({ ...call, allowedRepo });
  if (!data.result || typeof data.result.text !== 'string') {
    throw new Error('GitHub tool worker returned an invalid result payload');
  }
  return data.result;
}

export async function fetchRepoBranchesViaWorker(
  repo: string,
  maxBranches: number = 500,
): Promise<{ defaultBranch: string; branches: BranchListCardData['branches'] }> {
  const result = await executeGitHubToolViaWorker(
    { tool: 'list_branches', args: { repo, maxBranches } },
    repo,
  );

  if (result.card?.type !== 'branch-list') {
    throw new Error('GitHub tool worker returned list_branches without a branch-list card');
  }

  return {
    defaultBranch: result.card.data.defaultBranch,
    branches: result.card.data.branches,
  };
}
