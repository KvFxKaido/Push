import { z } from 'zod';
import type { BranchSwitchPayload, ChatMessage } from '@/types';
import { parseDiffStats } from '@/lib/diff-utils';
import { forkBranchInWorkspace } from '@/lib/fork-branch-in-workspace';
import { execInSandbox } from '@/lib/sandbox-client';
import { gitHubAuthCommandPrefix } from '@/lib/git-backend';
import { shellEscape } from '@/lib/sandbox-tool-utils';
import { getActiveProvider, getProviderPushStream, type ActiveProvider } from '@/lib/orchestrator';
import { getModelForRole } from '@/lib/providers';
import { iteratePushStreamText } from '@push/lib/stream-utils';
import { parseStructured } from '@push/lib/structured-output';
import { resolveAutoBranchOnCommitEnabled } from '@push/lib/auto-branch-policy';
import { isInvalidGitRef } from './git-ref-validation';

const MAX_BRANCH_NAME_LENGTH = 80;
const MAX_BRANCH_BASE_LENGTH = 64;
const MODEL_BRANCH_TIMEOUT_MS = 12_000;
const MAX_BRANCH_ATTEMPTS = 20;

const BranchNameResponse = z.object({
  branch: z.string().catch(''),
});

export type CommitBranchNameProposer = (input: {
  commitMessage: string;
  diffSummary: string;
}) => Promise<string | null | undefined>;

/**
 * The fork primitive the seam uses to create+switch the auto-branch. Both
 * implementations return the same `ForkBranchInWorkspaceResult` shape, so the
 * collision-suffix loop is identical regardless of which is injected:
 *   - default (`forkBranchInWorkspace`): bare sandbox fork, returns the
 *     `branchSwitch` payload for the caller to apply — used by the model tool
 *     path (`handlePrepareCommit`), where the payload rides the tool result.
 *   - UI surfaces inject `forkBranchFromUI`: forks AND applies the chat
 *     migration (`applyBranchSwitchPayload`) in one step, so the active
 *     conversation follows onto the new branch.
 */
export type CommitTargetForkFn = (
  branch: string,
) => Promise<{ ok: boolean; branchSwitch?: BranchSwitchPayload; errorMessage?: string }>;

export type EnsureCommitTargetBranchResult =
  | { switched: false }
  | { switched: true; branch: string; branchSwitch: BranchSwitchPayload };

export interface EnsureCommitTargetBranchArgs {
  sandboxId: string | null;
  currentBranch: string | null | undefined;
  defaultBranch: string | null | undefined;
  diff: string;
  commitMessage: string;
  proposeName?: CommitBranchNameProposer;
  /** Fork primitive — see {@link CommitTargetForkFn}. Defaults to the bare
   *  `forkBranchInWorkspace` (model-path semantics: returns the payload, no
   *  chat migration). UI surfaces pass a `forkBranchFromUI` wrapper. */
  fork?: CommitTargetForkFn;
  /** Branch collision check. Defaults to sandbox local + origin refs. */
  branchExists?: (branch: string) => Promise<boolean>;
}

export interface ModelBranchNameProposerOptions {
  providerOverride?: ActiveProvider | null;
  modelOverride?: string | null;
}

export function resolveWebAutoBranchOnCommitEnabled(): boolean {
  const env = (import.meta as { env?: Record<string, unknown> }).env;
  return resolveAutoBranchOnCommitEnabled({
    env: env?.VITE_PUSH_AUTO_BRANCH_ON_COMMIT ?? env?.PUSH_AUTO_BRANCH_ON_COMMIT,
  });
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function formatBranchTimestamp(date = new Date()): string {
  return [
    pad2(date.getFullYear() % 100),
    pad2(date.getMonth() + 1),
    pad2(date.getDate()),
    '-',
    pad2(date.getHours()),
    pad2(date.getMinutes()),
  ].join('');
}

function stripBranchDecorations(raw: string): string {
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json|text)?\s*\n?([\s\S]*?)\n?\s*```/i);
  if (fenceMatch) text = fenceMatch[1].trim();
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find(Boolean)
      ?.replace(/^(branch name|branch)\s*:\s*/i, '')
      .replace(/^refs\/heads\//i, '')
      .replace(/^["'`]+|["'`]+$/g, '')
      .trim() ?? ''
  );
}

export function sanitizeCommitTargetBranchName(raw: string): string {
  return stripBranchDecorations(raw)
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, MAX_BRANCH_NAME_LENGTH)
    .replace(/[^a-z0-9]+$/, '');
}

function slugCommitMessage(message: string): string {
  const cleaned = message
    .trim()
    .replace(/^([a-z]+)(?:\([^)]+\))?!?:\s*/i, '')
    .replace(/\.$/, '');
  const slug = cleaned
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || 'update-workspace';
}

export function deterministicCommitTargetBranchName(
  commitMessage: string,
  date = new Date(),
): string {
  return `push/${slugCommitMessage(commitMessage)}-${formatBranchTimestamp(date)}`;
}

function usableBranchName(
  raw: string | null | undefined,
  currentBranch: string,
  defaultBranch: string,
): string | null {
  if (!raw) return null;
  const branch = sanitizeCommitTargetBranchName(raw);
  if (!branch || branch === currentBranch || branch === defaultBranch || isInvalidGitRef(branch)) {
    return null;
  }
  return branch;
}

function withNumericSuffix(base: string, suffix: number): string {
  const marker = `-${suffix}`;
  const maxBase = MAX_BRANCH_NAME_LENGTH - marker.length;
  return `${base.slice(0, maxBase).replace(/[^a-z0-9]+$/g, '')}${marker}`;
}

export function isBranchExistsMessage(message: string | undefined): boolean {
  return Boolean(message && /already exists|exists already|a branch named/i.test(message));
}

async function branchExists(sandboxId: string, branch: string): Promise<boolean> {
  const escaped = shellEscape(branch);
  // origin is tokenless after clone (#987); ls-remote against a private repo
  // needs transient auth, or the remote-collision check goes blind.
  const authPrefix = gitHubAuthCommandPrefix();
  const result = await execInSandbox(
    sandboxId,
    [
      `if git show-ref --verify --quiet refs/heads/${escaped}; then exit 10; fi`,
      `if git ${authPrefix}ls-remote --exit-code --heads origin ${escaped} >/dev/null 2>&1; then exit 10; fi`,
      'exit 0',
    ].join(' && '),
    '/workspace',
  );
  return result.exitCode === 10;
}

function summarizeDiffForBranchName(diff: string): string {
  const stats = parseDiffStats(diff);
  const fileList = stats.fileNames.slice(0, 16).join(', ');
  const more = stats.fileNames.length > 16 ? ` (+${stats.fileNames.length - 16} more)` : '';
  const excerpt = diff.slice(0, 8_000);
  return [
    `${stats.filesChanged} files changed, +${stats.additions} -${stats.deletions}.`,
    fileList ? `Files: ${fileList}${more}.` : '',
    'Diff excerpt:',
    excerpt,
  ]
    .filter(Boolean)
    .join('\n');
}

export function createModelCommitBranchNameProposer(
  options: ModelBranchNameProposerOptions = {},
): CommitBranchNameProposer {
  return async ({ commitMessage, diffSummary }) => {
    const provider = options.providerOverride || getActiveProvider();
    if (provider === 'demo') return null;
    const model = options.modelOverride?.trim() || getModelForRole(provider, 'orchestrator')?.id;
    if (!model) return null;

    const stream = getProviderPushStream(provider);
    const messages: ChatMessage[] = [
      {
        id: 'auto-branch-name-request',
        role: 'user',
        content: [
          'Propose a short kebab-case git branch name for this change.',
          'Return JSON only: {"branch":"short-name"}',
          '',
          `Commit message: ${commitMessage}`,
          '',
          diffSummary,
        ].join('\n'),
        timestamp: Date.now(),
      },
    ];

    const { error, text } = await iteratePushStreamText(
      stream,
      {
        provider,
        model,
        messages,
        systemPromptOverride:
          'You name git branches. Return only valid JSON with one "branch" string. Prefer concise kebab-case names and no prose.',
        hasSandbox: false,
      },
      MODEL_BRANCH_TIMEOUT_MS,
      `Branch naming timed out after ${MODEL_BRANCH_TIMEOUT_MS / 1000}s.`,
    );
    if (error) return null;
    const parsed = parseStructured(text, BranchNameResponse);
    return parsed.ok ? parsed.data.branch : null;
  };
}

export async function ensureCommitTargetBranch({
  sandboxId,
  currentBranch,
  defaultBranch,
  diff,
  commitMessage,
  proposeName = createModelCommitBranchNameProposer(),
  fork,
  branchExists: branchExistsOverride,
}: EnsureCommitTargetBranchArgs): Promise<EnsureCommitTargetBranchResult> {
  const current = currentBranch?.trim();
  const fallbackDefault = defaultBranch?.trim();
  if (!sandboxId || !current || !fallbackDefault || current !== fallbackDefault) {
    return { switched: false };
  }
  if (!resolveWebAutoBranchOnCommitEnabled()) {
    return { switched: false };
  }
  const forkBranch: CommitTargetForkFn =
    fork ?? ((branch) => forkBranchInWorkspace(sandboxId, branch));
  const checkBranchExists =
    branchExistsOverride ?? ((branch: string) => branchExists(sandboxId, branch));

  const diffSummary = summarizeDiffForBranchName(diff);
  let proposed: string | null;
  try {
    proposed = usableBranchName(
      await proposeName({ commitMessage, diffSummary }),
      current,
      fallbackDefault,
    );
  } catch {
    proposed = null;
  }

  const deterministic = (
    usableBranchName(
      deterministicCommitTargetBranchName(commitMessage),
      current,
      fallbackDefault,
    ) ?? 'push/update-workspace'
  ).slice(0, MAX_BRANCH_BASE_LENGTH);

  // Try the model-proposed name first, then the always-git-valid deterministic
  // name. A base git rejects but our regex validator accepts — `isInvalidGitRef`
  // can't fully replicate `git check-ref-format` (e.g. `foo.lock`,
  // `feature/.env`) — falls through to the next candidate instead of failing
  // the whole commit. Naming never blocks. (Review: Codex P2.)
  const bases =
    proposed && proposed !== deterministic
      ? [proposed.slice(0, MAX_BRANCH_BASE_LENGTH), deterministic]
      : [deterministic];

  let lastError: string | undefined;
  for (const base of bases) {
    for (let i = 0; i < MAX_BRANCH_ATTEMPTS; i++) {
      const branch = i === 0 ? base : withNumericSuffix(base, i + 1);
      if (!branch || isInvalidGitRef(branch)) break; // bad base — next candidate
      if (await checkBranchExists(branch)) continue;

      const forked = await forkBranch(branch);
      if (forked.ok && forked.branchSwitch) {
        return { switched: true, branch, branchSwitch: forked.branchSwitch };
      }
      if (isBranchExistsMessage(forked.errorMessage)) continue;
      // Non-collision failure (git rejected the ref, transport, etc.): abandon
      // this base and try the next candidate rather than blocking the commit.
      lastError = forked.errorMessage;
      break;
    }
  }

  throw new Error(lastError || `Failed to create a unique branch from "${bases[0]}".`);
}
