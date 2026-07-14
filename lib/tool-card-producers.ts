/**
 * Pure builders for the high-traffic tool cards emitted by both CLI and web
 * producers. These helpers consume structured execution outcomes; they never
 * inspect model-facing tool-result prose to decide how a result should render.
 */

import { computeEditDiff, type EditDiff } from './edit-diff.js';
import type {
  CommitListCardData,
  DelegationResultCardData,
  DiffPreviewCardData,
  SandboxStateCardData,
  TestResultsCardData,
  ToolCard,
  TypeCheckCardData,
} from './tool-cards.js';

const MAX_COMMAND_CARD_OUTPUT_CHARS = 24_000;
const MAX_DIFF_CARD_CHARS = 24_000;
const MAX_TYPECHECK_ERRORS = 100;
const MAX_GIT_STATUS_PREVIEW_ITEMS = 12;
const MAX_GIT_STATUS_PREVIEW_CHARS = 240;

function boundedText(value: string, maxChars: number): { text: string; truncated: boolean } {
  if (value.length <= maxChars) return { text: value, truncated: false };
  return { text: `${value.slice(0, maxChars)}\n[output truncated]`, truncated: true };
}

function commandOutput(stdout: string, stderr: string): string {
  return [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n');
}

function inferTestFramework(command: string): TestResultsCardData['framework'] | null {
  const normalized = command.toLowerCase();
  if (/\bpytest\b/.test(normalized)) return 'pytest';
  if (/\bcargo\s+test\b/.test(normalized)) return 'cargo';
  if (/\bgo\s+test\b/.test(normalized)) return 'go';
  if (
    /\b(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+(?:test|test[:\w-]+)\b/.test(normalized) ||
    /\b(?:jest|vitest|mocha)\b/.test(normalized)
  ) {
    return 'npm';
  }
  return null;
}

function inferTypecheckTool(command: string): TypeCheckCardData['tool'] | null {
  const normalized = command.toLowerCase();
  if (/\bpyright\b/.test(normalized)) return 'pyright';
  if (/\bmypy\b/.test(normalized)) return 'mypy';
  if (/\btsc\b/.test(normalized) || /\btypecheck(?::[\w-]+)?\b/.test(normalized)) return 'tsc';
  return null;
}

function parseTestCounts(
  output: string,
): Pick<TestResultsCardData, 'passed' | 'failed' | 'skipped' | 'total'> {
  const lines = output.split('\n');
  const summaryLine =
    lines.find((line) => /^\s*Tests\s*:/i.test(line)) ??
    [...lines]
      .reverse()
      .find(
        (line) =>
          /\d+\s+(?:passed|failed)\b/i.test(line) || /(?:passed|failed)\s*:\s*\d+/i.test(line),
      );
  const count = (line: string | undefined, labels: readonly string[]): number => {
    if (!line) return 0;
    for (const label of labels) {
      const suffix = line.match(new RegExp(`(\\d+)\\s+${label}\\b`, 'i'));
      if (suffix) return Number(suffix[1]) || 0;
      const prefix = line.match(new RegExp(`${label}\\s*:\\s*(\\d+)`, 'i'));
      if (prefix) return Number(prefix[1]) || 0;
    }
    return 0;
  };

  let passed = count(summaryLine, ['passed']);
  let failed = count(summaryLine, ['failed']);
  let skipped = count(summaryLine, ['skipped', 'ignored', 'pending', 'todo']);
  let total = count(summaryLine, ['total']);
  if (skipped === 0) {
    const standaloneSkipped = output.match(/^\s*(\d+)\s+(?:skipped|ignored|pending|todo)\b/im);
    skipped = standaloneSkipped ? Number(standaloneSkipped[1]) || 0 : 0;
  }
  const goPasses = output.match(/^ok\s+/gm);
  const goFailures = output.match(/^FAIL(?:\s+|$)/gm);

  if (!summaryLine && (goPasses || goFailures)) {
    passed = goPasses?.length ?? 0;
    failed = goFailures?.length ?? 0;
    total = passed + failed;
  }

  if (total === 0 && passed + failed + skipped > 0) total = passed + failed + skipped;
  return { passed, failed, skipped, total };
}

interface TypecheckDiagnosticLike {
  file: string;
  line: number;
  col?: number;
  column?: number;
  message: string;
  code?: string;
  severity?: string;
}

function parseTypecheckOutput(output: string): TypecheckDiagnosticLike[] {
  const diagnostics: TypecheckDiagnosticLike[] = [];
  for (const line of output.split('\n')) {
    const tsc = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+([^:]+):\s*(.+)$/i);
    if (tsc) {
      diagnostics.push({
        file: tsc[1],
        line: Number(tsc[2]),
        column: Number(tsc[3]),
        severity: tsc[4].toLowerCase(),
        code: tsc[5],
        message: tsc[6],
      });
      continue;
    }
    const python = line.match(/^(.+?):(\d+):(\d+)\s+-\s+(error|warning):\s*(.+)$/i);
    if (python) {
      diagnostics.push({
        file: python[1],
        line: Number(python[2]),
        column: Number(python[3]),
        severity: python[4].toLowerCase(),
        message: python[5],
      });
    }
  }
  return diagnostics;
}

export function buildTypeCheckToolCard(input: {
  tool?: TypeCheckCardData['tool'];
  diagnostics?: readonly TypecheckDiagnosticLike[];
  exitCode: number;
  errorCount?: number;
  warningCount?: number;
}): ToolCard {
  const diagnostics = input.diagnostics ?? [];
  const errors = diagnostics
    .filter((item) => item.severity !== 'warning')
    .slice(0, MAX_TYPECHECK_ERRORS)
    .map((item) => ({
      file: item.file,
      line: item.line,
      column: item.column ?? item.col ?? 0,
      message: item.message,
      ...(item.code ? { code: item.code } : {}),
    }));
  return {
    type: 'type-check',
    data: {
      tool: input.tool ?? 'unknown',
      errors,
      errorCount:
        input.errorCount ?? diagnostics.filter((item) => item.severity !== 'warning').length,
      warningCount:
        input.warningCount ?? diagnostics.filter((item) => item.severity === 'warning').length,
      exitCode: input.exitCode,
      truncated: diagnostics.length > MAX_TYPECHECK_ERRORS,
    },
  };
}

/** Build the declared card for an `exec` outcome. */
export function buildCommandToolCard(input: {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}): ToolCard {
  const output = commandOutput(input.stdout, input.stderr);
  const bounded = boundedText(output, MAX_COMMAND_CARD_OUTPUT_CHARS);
  const framework = inferTestFramework(input.command);
  if (framework) {
    return {
      type: 'test-results',
      data: {
        framework,
        ...parseTestCounts(output),
        durationMs: input.durationMs,
        exitCode: input.exitCode,
        output: bounded.text,
        truncated: bounded.truncated,
      },
    };
  }

  const typecheckTool = inferTypecheckTool(input.command);
  if (typecheckTool) {
    const diagnostics = parseTypecheckOutput(output);
    return buildTypeCheckToolCard({
      tool: typecheckTool,
      diagnostics,
      exitCode: input.exitCode,
      errorCount: diagnostics.length > 0 ? undefined : input.exitCode === 0 ? 0 : 1,
    });
  }

  return {
    type: 'sandbox',
    data: {
      command: input.command,
      stdout: boundedText(input.stdout, MAX_COMMAND_CARD_OUTPUT_CHARS).text,
      stderr: boundedText(input.stderr, MAX_COMMAND_CARD_OUTPUT_CHARS).text,
      exitCode: input.exitCode,
      truncated:
        input.stdout.length > MAX_COMMAND_CARD_OUTPUT_CHARS ||
        input.stderr.length > MAX_COMMAND_CARD_OUTPUT_CHARS,
      durationMs: input.durationMs,
    },
  };
}

/** Build a bounded diff-preview card from a real or synthetic unified diff. */
export function buildDiffPreviewToolCard(
  diff: string,
  options: {
    filesChanged?: number;
    additions?: number;
    deletions?: number;
    truncated?: boolean;
  } = {},
): ToolCard {
  const bounded = boundedText(diff, MAX_DIFF_CARD_CHARS);
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1;
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1;
  }
  const data: DiffPreviewCardData = {
    diff: bounded.text,
    filesChanged: options.filesChanged ?? (diff.trim() ? 1 : 0),
    additions: options.additions ?? additions,
    deletions: options.deletions ?? deletions,
    truncated: Boolean(options.truncated) || bounded.truncated,
  };
  return { type: 'diff-preview', data };
}

/** Convert the CLI's structured edit outcome into the cross-surface card. */
export function buildEditDiffToolCard(editDiff: EditDiff): ToolCard {
  const lines = [
    `diff --git a/${editDiff.path} b/${editDiff.path}`,
    `--- a/${editDiff.path}`,
    `+++ b/${editDiff.path}`,
    ...editDiff.lines.map((line) => {
      const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
      return `${marker}${line.text}${line.textTruncated ? '…' : ''}`;
    }),
  ];
  return buildDiffPreviewToolCard(lines.join('\n'), {
    filesChanged: 1,
    additions: editDiff.adds,
    deletions: editDiff.dels,
    truncated: editDiff.truncated,
  });
}

/** Build a diff-preview card directly from structured before/after content. */
export function buildTextChangeToolCard(
  path: string,
  before: string,
  after: string,
): ToolCard | undefined {
  const editDiff = computeEditDiff(path, before, after);
  return editDiff ? buildEditDiffToolCard(editDiff) : undefined;
}

export function buildCommitToolCard(input: {
  repo: string;
  sha: string;
  message: string;
  author: string;
  date: string;
}): ToolCard {
  const data: CommitListCardData = {
    repo: input.repo,
    commits: [
      {
        sha: input.sha,
        message: input.message,
        author: input.author,
        date: input.date,
      },
    ],
  };
  return { type: 'commit-list', data };
}

/** Build the local-daemon workspace-state card for a `git_status` outcome. */
export function buildGitStatusToolCard(input: {
  repoPath: string;
  branch: string;
  statusLine?: string;
  changedFiles: number;
  stagedFiles: number;
  unstagedFiles: number;
  untrackedFiles: number;
  preview?: readonly string[];
  fetchedAt?: string;
}): ToolCard {
  const preview = (input.preview ?? []).slice(0, MAX_GIT_STATUS_PREVIEW_ITEMS).map((line) => {
    const singleLine = line.replace(/[\r\n]+/g, ' ');
    return singleLine.length > MAX_GIT_STATUS_PREVIEW_CHARS
      ? `${singleLine.slice(0, MAX_GIT_STATUS_PREVIEW_CHARS - 1)}…`
      : singleLine;
  });
  const data: SandboxStateCardData = {
    sandboxId: 'local-daemon',
    repoPath: input.repoPath,
    branch: input.branch,
    ...(input.statusLine ? { statusLine: input.statusLine } : {}),
    changedFiles: input.changedFiles,
    stagedFiles: input.stagedFiles,
    unstagedFiles: input.unstagedFiles,
    untrackedFiles: input.untrackedFiles,
    preview,
    fetchedAt: input.fetchedAt ?? new Date().toISOString(),
  };
  return { type: 'sandbox-state', data };
}

export function buildDelegationResultToolCard(
  input: Omit<DelegationResultCardData, 'agent'> & {
    agent?: DelegationResultCardData['agent'];
  },
): ToolCard {
  const { agent = 'explorer', ...data } = input;
  return { type: 'delegation-result', data: { agent, ...data } };
}
