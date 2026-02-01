/**
 * Sandbox tool definitions, detection, and execution.
 *
 * Mirrors the github-tools.ts pattern exactly:
 * - LLM outputs a JSON block with { tool, args }
 * - We detect, validate, execute, and return text + optional card
 *
 * Sandbox tools operate on a running Modal sandbox (persistent container).
 */

import type { ToolExecutionResult, SandboxCardData, DiffPreviewCardData } from '@/types';
import {
  execInSandbox,
  readFromSandbox,
  writeToSandbox,
  getSandboxDiff,
} from './sandbox-client';
import { runAuditor } from './auditor-agent';

// --- Tool types ---

export type SandboxToolCall =
  | { tool: 'sandbox_exec'; args: { command: string; workdir?: string } }
  | { tool: 'sandbox_read_file'; args: { path: string } }
  | { tool: 'sandbox_write_file'; args: { path: string; content: string } }
  | { tool: 'sandbox_diff'; args: Record<string, never> }
  | { tool: 'sandbox_commit'; args: { message: string } }
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
  if (parsed.tool === 'sandbox_diff') {
    return { tool: 'sandbox_diff', args: {} };
  }
  if (parsed.tool === 'sandbox_commit' && parsed.args?.message) {
    return { tool: 'sandbox_commit', args: { message: parsed.args.message } };
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

  // Bare JSON fallback
  const bareRegex = /\{[\s\S]*?"tool"\s*:\s*"sandbox_[^"]+?"[\s\S]*?\}/g;
  while ((match = bareRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed.tool?.startsWith('sandbox_') && parsed.args) {
        const result = validateSandboxToolCall(parsed);
        if (result) return result;
      }
    } catch {
      // Not valid JSON
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
        const result = await readFromSandbox(sandboxId, call.args.path);

        const lines: string[] = [
          `[Tool Result — sandbox_read_file]`,
          `File: ${call.args.path}`,
          result.truncated ? `(truncated)\n` : '',
          result.content,
        ];

        return { text: lines.join('\n') };
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

      case 'sandbox_commit': {
        // Step 1: Get the diff
        const diffResult = await getSandboxDiff(sandboxId);
        if (!diffResult.diff) {
          return { text: `[Tool Result — sandbox_commit]\nNo changes to commit.` };
        }

        // Step 2: Run Auditor
        const auditResult = await runAuditor(
          diffResult.diff,
          (phase) => console.log(`[Diff] Auditor: ${phase}`),
        );

        if (auditResult.verdict === 'unsafe') {
          // Blocked — return verdict card
          return {
            text: `[Tool Result — sandbox_commit]\nCommit BLOCKED by Auditor: ${auditResult.card.summary}`,
            card: { type: 'audit-verdict', data: auditResult.card },
          };
        }

        // Step 3: SAFE — commit in sandbox
        const commitResult = await execInSandbox(
          sandboxId,
          `cd /workspace && git add -A && git commit -m "${call.args.message.replace(/"/g, '\\"')}"`,
        );

        if (commitResult.exitCode !== 0) {
          return { text: `[Tool Result — sandbox_commit]\nCommit failed: ${commitResult.stderr}` };
        }

        // Step 4: Push to remote
        const pushResult = await execInSandbox(sandboxId, 'cd /workspace && git push origin HEAD');

        const stats = parseDiffStats(diffResult.diff);

        if (pushResult.exitCode !== 0) {
          return {
            text: `[Tool Result — sandbox_commit]\nCommitted "${call.args.message}" (${stats.filesChanged} file${stats.filesChanged !== 1 ? 's' : ''}, +${stats.additions} -${stats.deletions}) but PUSH FAILED: ${pushResult.stderr}\nUse sandbox_push() to retry the push.`,
            card: { type: 'audit-verdict', data: auditResult.card },
          };
        }

        return {
          text: `[Tool Result — sandbox_commit]\nCommitted and pushed: "${call.args.message}" (${stats.filesChanged} file${stats.filesChanged !== 1 ? 's' : ''}, +${stats.additions} -${stats.deletions})`,
          card: { type: 'audit-verdict', data: auditResult.card },
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
- sandbox_read_file(path) — Read a file from the sandbox filesystem
- sandbox_write_file(path, content) — Write or overwrite a file in the sandbox
- sandbox_diff() — Get the git diff of all uncommitted changes
- sandbox_commit(message) — Commit AND push changes (requires Auditor approval). Automatically pushes after commit.
- sandbox_push() — Retry a failed push. Use this only if sandbox_commit reported a push failure. No Auditor needed (commit was already audited).

Usage: Output a fenced JSON block just like GitHub tools:
\`\`\`json
{"tool": "sandbox_exec", "args": {"command": "npm test"}}
\`\`\`

Sandbox rules:
- The repo is cloned to /workspace — use that as the working directory
- You can install packages, run tests, build, lint — anything you'd do in a terminal
- For multi-step tasks (edit + test), use multiple tool calls in sequence
- sandbox_diff shows what you've changed — review before committing
- sandbox_commit triggers the Auditor for safety review, then commits and pushes to the remote
- If the push fails after a successful commit, use sandbox_push() to retry
- Keep commands focused — avoid long-running servers or background processes`;
