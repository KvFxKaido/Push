/**
 * Sandbox tool definitions, detection, and execution.
 *
 * Mirrors the github-tools.ts pattern exactly:
 * - LLM outputs a JSON block with { tool, args }
 * - We detect, validate, execute, and return text + optional card
 *
 * Sandbox tools operate on a running Modal sandbox (persistent container).
 */

import type { ToolExecutionResult, SandboxCardData, DiffPreviewCardData, CommitReviewCardData, FileListCardData } from '@/types';
import { extractBareToolJsonObjects } from './tool-dispatch';
import {
  execInSandbox,
  readFromSandbox,
  writeToSandbox,
  getSandboxDiff,
  listDirectory,
  type FileReadResult,
} from './sandbox-client';
import { runAuditor } from './auditor-agent';

// --- Tool types ---

export type SandboxToolCall =
  | { tool: 'sandbox_exec'; args: { command: string; workdir?: string } }
  | { tool: 'sandbox_read_file'; args: { path: string } }
  | { tool: 'sandbox_write_file'; args: { path: string; content: string } }
  | { tool: 'sandbox_list_dir'; args: { path?: string } }
  | { tool: 'sandbox_diff'; args: Record<string, never> }
  | { tool: 'sandbox_prepare_commit'; args: { message: string } }
  | { tool: 'sandbox_push'; args: Record<string, never> };

// --- Validation ---

export function validateSandboxToolCall(parsed: any): SandboxToolCall | null {
  if (parsed.tool === 'sandbox_exec' && parsed.args?.command) {
    return { tool: 'sandbox_exec', args: { command: parsed.args.command, workdir: parsed.args.workdir } };
  }
  if (parsed.tool === 'sandbox_read_file' && parsed.args?.path) {
    return { tool: 'sandbox_read_file', args: { path: parsed.args.path } };
  }
  if (parsed.tool === 'sandbox_write_file' && parsed.args?.path && typeof parsed.args.content === 'string') {
    return { tool: 'sandbox_write_file', args: { path: parsed.args.path, content: parsed.args.content } };
  }
  if (parsed.tool === 'sandbox_list_dir') {
    return { tool: 'sandbox_list_dir', args: { path: parsed.args?.path } };
  }
  if (parsed.tool === 'sandbox_diff') {
    return { tool: 'sandbox_diff', args: {} };
  }
  if ((parsed.tool === 'sandbox_prepare_commit' || parsed.tool === 'sandbox_commit') && parsed.args?.message) {
    return { tool: 'sandbox_prepare_commit', args: { message: parsed.args.message } };
  }
  if (parsed.tool === 'sandbox_push') {
    return { tool: 'sandbox_push', args: {} };
  }
  return null;
}

// --- Detection ---

export function detectSandboxToolCall(text: string): SandboxToolCall | null {
  // Match fenced JSON blocks
  const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g;
  let match;

  while ((match = fenceRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.tool?.startsWith('sandbox_') && parsed.args) {
        const result = validateSandboxToolCall(parsed);
        if (result) return result;
      }
    } catch {
      // Not valid JSON
    }
  }

  // Bare JSON fallback (brace-counting handles nested objects)
  for (const parsed of extractBareToolJsonObjects(text)) {
    if (parsed.tool?.startsWith('sandbox_') && parsed.args) {
      const result = validateSandboxToolCall(parsed);
      if (result) return result;
    }
  }

  return null;
}

// --- Diff parsing helper ---

function parseDiffStats(diff: string): { filesChanged: number; additions: number; deletions: number } {
  const files = new Set<string>();
  let additions = 0;
  let deletions = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      const match = line.match(/b\/(.+)$/);
      if (match) files.add(match[1]);
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      additions++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      deletions++;
    }
  }

  return { filesChanged: files.size, additions, deletions };
}

// --- Execution ---

export async function executeSandboxToolCall(
  call: SandboxToolCall,
  sandboxId: string,
): Promise<ToolExecutionResult> {
  if (!sandboxId) {
    return { text: '[Tool Error] No active sandbox — start one first.' };
  }

  try {
    switch (call.tool) {
      case 'sandbox_exec': {
        const start = Date.now();
        const result = await execInSandbox(sandboxId, call.args.command, call.args.workdir);
        const durationMs = Date.now() - start;

        const lines: string[] = [
          `[Tool Result — sandbox_exec]`,
          `Command: ${call.args.command}`,
          `Exit code: ${result.exitCode}`,
        ];
        if (result.stdout) lines.push(`\nStdout:\n${result.stdout}`);
        if (result.stderr) lines.push(`\nStderr:\n${result.stderr}`);
        if (result.truncated) lines.push(`\n[Output truncated]`);

        const cardData: SandboxCardData = {
          command: call.args.command,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          truncated: result.truncated,
          durationMs,
        };

        return { text: lines.join('\n'), card: { type: 'sandbox', data: cardData } };
      }

      case 'sandbox_read_file': {
        const result = await readFromSandbox(sandboxId, call.args.path) as FileReadResult & { error?: string };

        // Handle directory or read errors (e.g. "cat: /path: Is a directory")
        if (result.error) {
          const isDir = result.error.toLowerCase().includes('is a directory');
          if (isDir) {
            return {
              text: `[Tool Error] "${call.args.path}" is a directory, not a file. Use sandbox_list_dir to browse directories, then sandbox_read_file on a specific file.`,
            };
          }
          return { text: `[Tool Error] ${result.error}` };
        }

        const lines: string[] = [
          `[Tool Result — sandbox_read_file]`,
          `File: ${call.args.path}`,
          result.truncated ? `(truncated)\n` : '',
          result.content,
        ];

        // Guess language from extension
        const ext = call.args.path.split('.').pop()?.toLowerCase() || '';
        const sandboxLangMap: Record<string, string> = {
          ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
          py: 'python', rs: 'rust', go: 'go', rb: 'ruby', java: 'java',
          md: 'markdown', json: 'json', yaml: 'yaml', yml: 'yaml',
          css: 'css', html: 'html', sh: 'shell', bash: 'shell',
          toml: 'toml', sql: 'sql', c: 'c', cpp: 'cpp', h: 'c',
        };
        const language = sandboxLangMap[ext] || ext;

        return {
          text: lines.join('\n'),
          card: {
            type: 'editor',
            data: {
              path: call.args.path,
              content: result.content,
              language,
              truncated: result.truncated,
              source: 'sandbox' as const,
              sandboxId,
            },
          },
        };
      }

      case 'sandbox_list_dir': {
        const dirPath = call.args.path || '/workspace';
        const entries = await listDirectory(sandboxId, dirPath);

        const dirs = entries.filter((e) => e.type === 'directory');
        const files = entries.filter((e) => e.type === 'file');

        const lines: string[] = [
          `[Tool Result — sandbox_list_dir]`,
          `Directory: ${dirPath}`,
          `${dirs.length} directories, ${files.length} files\n`,
        ];

        for (const d of dirs) {
          lines.push(`  📁 ${d.name}/`);
        }
        for (const f of files) {
          const size = f.size ? ` (${f.size} bytes)` : '';
          lines.push(`  📄 ${f.name}${size}`);
        }

        const cardData: FileListCardData = {
          path: dirPath,
          entries: [
            ...dirs.map((d) => ({ name: d.name, type: 'directory' as const })),
            ...files.map((f) => ({ name: f.name, type: 'file' as const, size: f.size || undefined })),
          ],
        };

        return { text: lines.join('\n'), card: { type: 'file-list', data: cardData } };
      }

      case 'sandbox_write_file': {
        const result = await writeToSandbox(sandboxId, call.args.path, call.args.content);

        if (!result.ok) {
          return { text: `[Tool Error] Failed to write ${call.args.path}` };
        }

        return { text: `[Tool Result — sandbox_write_file]\nWrote ${call.args.path} (${call.args.content.length} bytes)` };
      }

      case 'sandbox_diff': {
        const result = await getSandboxDiff(sandboxId);

        if (!result.diff) {
          return { text: `[Tool Result — sandbox_diff]\nNo changes detected.` };
        }

        const stats = parseDiffStats(result.diff);
        const lines: string[] = [
          `[Tool Result — sandbox_diff]`,
          `${stats.filesChanged} file${stats.filesChanged !== 1 ? 's' : ''} changed, +${stats.additions} -${stats.deletions}`,
          result.truncated ? `(truncated)\n` : '',
          result.diff,
        ];

        const cardData: DiffPreviewCardData = {
          diff: result.diff,
          filesChanged: stats.filesChanged,
          additions: stats.additions,
          deletions: stats.deletions,
          truncated: result.truncated,
        };

        return { text: lines.join('\n'), card: { type: 'diff-preview', data: cardData } };
      }

      case 'sandbox_prepare_commit': {
        // Step 1: Get the diff
        const diffResult = await getSandboxDiff(sandboxId);
        if (!diffResult.diff) {
          return { text: `[Tool Result — sandbox_prepare_commit]\nNo changes to commit.` };
        }

        // Step 2: Run Auditor
        const auditResult = await runAuditor(
          diffResult.diff,
          (phase) => console.log(`[Diff] Auditor: ${phase}`),
        );

        if (auditResult.verdict === 'unsafe') {
          // Blocked — return verdict card only, no review card
          return {
            text: `[Tool Result — sandbox_prepare_commit]\nCommit BLOCKED by Auditor: ${auditResult.card.summary}`,
            card: { type: 'audit-verdict', data: auditResult.card },
          };
        }

        // Step 3: SAFE — return a review card for user approval (do NOT commit)
        const stats = parseDiffStats(diffResult.diff);
        const reviewData: CommitReviewCardData = {
          diff: {
            diff: diffResult.diff,
            filesChanged: stats.filesChanged,
            additions: stats.additions,
            deletions: stats.deletions,
            truncated: diffResult.truncated,
          },
          auditVerdict: auditResult.card,
          commitMessage: call.args.message,
          status: 'pending',
        };

        return {
          text: `[Tool Result — sandbox_prepare_commit]\nReady for review: "${call.args.message}" (${stats.filesChanged} file${stats.filesChanged !== 1 ? 's' : ''}, +${stats.additions} -${stats.deletions}). Waiting for user approval.`,
          card: { type: 'commit-review', data: reviewData },
        };
      }

      case 'sandbox_push': {
        const pushResult = await execInSandbox(sandboxId, 'cd /workspace && git push origin HEAD');

        if (pushResult.exitCode !== 0) {
          return { text: `[Tool Result — sandbox_push]\nPush failed: ${pushResult.stderr}` };
        }

        return { text: `[Tool Result — sandbox_push]\nPushed successfully.` };
      }

      default:
        return { text: `[Tool Error] Unknown sandbox tool: ${(call as any).tool}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Diff] Sandbox tool error:', msg);
    return { text: `[Tool Error] ${msg}` };
  }
}

// --- System prompt extension ---

export const SANDBOX_TOOL_PROTOCOL = `
SANDBOX TOOLS — You have access to a code sandbox (persistent container with the repo cloned).

Additional tools available when sandbox is active:
- sandbox_exec(command, workdir?) — Run a shell command in the sandbox (default workdir: /workspace)
- sandbox_read_file(path) — Read a single file from the sandbox filesystem. Only works on files — fails on directories.
- sandbox_list_dir(path?) — List files and folders in a sandbox directory (default: /workspace). Use this to explore the project structure before reading specific files.
- sandbox_write_file(path, content) — Write or overwrite a file in the sandbox
- sandbox_diff() — Get the git diff of all uncommitted changes
- sandbox_prepare_commit(message) — Prepare a commit for review. Gets diff, runs Auditor. If SAFE, returns a review card for user approval. Does NOT commit — user must approve via the UI.
- sandbox_push() — Retry a failed push. Use this only if a push failed after approval. No Auditor needed (commit was already audited).

Usage: Output a fenced JSON block just like GitHub tools:
\`\`\`json
{"tool": "sandbox_exec", "args": {"command": "npm test"}}
\`\`\`

Commit message guidelines for sandbox_prepare_commit:
- Use conventional commit format (feat:, fix:, refactor:, docs:, etc.)
- Keep under 72 characters
- Describe what changed and why, not how

Sandbox rules:
- The repo is cloned to /workspace — use that as the working directory
- You can install packages, run tests, build, lint — anything you'd do in a terminal
- For multi-step tasks (edit + test), use multiple tool calls in sequence
- sandbox_diff shows what you've changed — review before committing
- sandbox_prepare_commit triggers the Auditor for safety review, then presents a review card. The user approves or rejects via the UI.
- If the push fails after a successful commit, use sandbox_push() to retry
- Keep commands focused — avoid long-running servers or background processes
- IMPORTANT: sandbox_read_file only works on files, not directories. To explore the project structure, use sandbox_list_dir first, then read specific files.`;
