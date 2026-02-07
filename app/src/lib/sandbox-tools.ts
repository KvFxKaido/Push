/**
 * Sandbox tool definitions, detection, and execution.
 *
 * Mirrors the github-tools.ts pattern exactly:
 * - LLM outputs a JSON block with { tool, args }
 * - We detect, validate, execute, and return text + optional card
 *
 * Sandbox tools operate on a running Modal sandbox (persistent container).
 */

import type { ToolExecutionResult, SandboxCardData, DiffPreviewCardData, CommitReviewCardData, FileListCardData, TestResultsCardData, TypeCheckCardData } from '@/types';
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

// --- Enhanced error messages ---

function formatSandboxError(error: string, context?: string): string {
  // Common error patterns with suggestions
  if (error.toLowerCase().includes('permission denied') || error.includes('EACCES')) {
    return `[Tool Error] Permission denied${context ? ` for ${context}` : ''}. The file or directory may be protected. Try a different path or use sudo if appropriate.`;
  }
  if (error.toLowerCase().includes('no such file') || error.includes('ENOENT')) {
    return `[Tool Error] File not found${context ? `: ${context}` : ''}. Use sandbox_list_dir to see available files, or check the path.`;
  }
  if (error.toLowerCase().includes('is a directory')) {
    return `[Tool Error] ${context || 'Path'} is a directory, not a file. Use sandbox_list_dir to browse directories, then sandbox_read_file on a specific file.`;
  }
  if (error.toLowerCase().includes('command not found') || error.includes('ENOENT')) {
    return `[Tool Error] Command not found${context ? `: ${context}` : ''}. The tool may not be installed in the sandbox. Try installing it first, or use a different command.`;
  }
  if (error.toLowerCase().includes('connection refused') || error.includes('ECONNREFUSED')) {
    return `[Tool Error] Connection refused${context ? ` for ${context}` : ''}. The service may not be running or the port may be incorrect.`;
  }
  return `[Tool Error] ${error}`;
}



// --- Tool types ---

export type SandboxToolCall =
  | { tool: 'sandbox_exec'; args: { command: string; workdir?: string } }
  | { tool: 'sandbox_read_file'; args: { path: string } }
  | { tool: 'sandbox_write_file'; args: { path: string; content: string } }
  | { tool: 'sandbox_list_dir'; args: { path?: string } }
  | { tool: 'sandbox_diff'; args: Record<string, never> }
  | { tool: 'sandbox_prepare_commit'; args: { message: string } }
  | { tool: 'sandbox_push'; args: Record<string, never> }
  | { tool: 'sandbox_run_tests'; args: { framework?: string } }
  | { tool: 'sandbox_check_types'; args: Record<string, never> };

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
  if (parsed.tool === 'sandbox_run_tests') {
    return { tool: 'sandbox_run_tests', args: { framework: parsed.args?.framework } };
  }
  if (parsed.tool === 'sandbox_check_types') {
    return { tool: 'sandbox_check_types', args: {} };
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
          return { text: formatSandboxError(result.error, call.args.path) };
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
          const detail = result.error || 'Unknown error';
          return { text: formatSandboxError(detail, call.args.path) };
        }

        // Post-write verification: check that git sees the change
        const verifyResult = await execInSandbox(
          sandboxId,
          `cd /workspace && git status --porcelain -- '${call.args.path.replace(/'/g, "'\\''")}'`,
        );
        const gitSees = verifyResult.stdout.trim();

        const lines: string[] = [
          `[Tool Result — sandbox_write_file]`,
          `Wrote ${call.args.path} (${result.bytes_written ?? call.args.content.length} bytes)`,
        ];

        if (!gitSees && call.args.path.startsWith('/workspace/')) {
          lines.push(`⚠ Warning: git reports no changes for this file. The content may be identical to the original.`);
        } else if (!call.args.path.startsWith('/workspace')) {
          lines.push(`⚠ Note: File is outside /workspace — git will not track this file.`);
        }

        return { text: lines.join('\n') };
      }

      case 'sandbox_diff': {
        const result = await getSandboxDiff(sandboxId);

        if (result.error) {
          return { text: `[Tool Error — sandbox_diff]\n${result.error}` };
        }

        if (!result.diff) {
          const diagnosticLines = [
            `[Tool Result — sandbox_diff]`,
            `No changes detected.`,
          ];
          if (result.git_status) {
            diagnosticLines.push(`\ngit status output:\n${result.git_status}`);
          } else {
            diagnosticLines.push(`\nThe working tree is clean. If you expected changes, verify that sandbox_write_file succeeded and the file is inside /workspace.`);
          }
          return { text: diagnosticLines.join('\n') };
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

        if (diffResult.error) {
          return { text: `[Tool Error — sandbox_prepare_commit]\n${diffResult.error}` };
        }

        if (!diffResult.diff) {
          const lines = [`[Tool Result — sandbox_prepare_commit]\nNo changes to commit.`];
          if (diffResult.git_status) {
            lines.push(`git status shows: ${diffResult.git_status}`);
          } else {
            lines.push(`Working tree is clean. Verify files were written inside /workspace and content differs from the original.`);
          }
          return { text: lines.join('\n') };
        }

        // Step 2: Run Auditor
        const auditResult = await runAuditor(
          diffResult.diff,
          (phase) => console.log(`[Push] Auditor: ${phase}`),
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

      case 'sandbox_run_tests': {
        const start = Date.now();

        // Auto-detect test framework if not specified
        let command = '';
        let framework: TestResultsCardData['framework'] = 'unknown';

        if (call.args.framework) {
          // User specified framework
          switch (call.args.framework.toLowerCase()) {
            case 'npm':
            case 'jest':
            case 'vitest':
            case 'mocha':
              command = 'npm test';
              framework = 'npm';
              break;
            case 'pytest':
            case 'python':
              command = 'pytest -v';
              framework = 'pytest';
              break;
            case 'cargo':
            case 'rust':
              command = 'cargo test';
              framework = 'cargo';
              break;
            case 'go':
              command = 'go test ./...';
              framework = 'go';
              break;
            default:
              command = call.args.framework;
              framework = 'unknown';
          }
        } else {
          // Auto-detect by checking for config files
          const detectResult = await execInSandbox(
            sandboxId,
            'cd /workspace && ls -1 package.json Cargo.toml go.mod pytest.ini pyproject.toml setup.py 2>/dev/null | head -1',
          );
          const detected = detectResult.stdout.trim();

          if (detected === 'package.json') {
            command = 'npm test';
            framework = 'npm';
          } else if (detected === 'Cargo.toml') {
            command = 'cargo test';
            framework = 'cargo';
          } else if (detected === 'go.mod') {
            command = 'go test ./...';
            framework = 'go';
          } else if (['pytest.ini', 'pyproject.toml', 'setup.py'].includes(detected)) {
            command = 'pytest -v';
            framework = 'pytest';
          } else {
            // Fallback: try npm test
            command = 'npm test';
            framework = 'npm';
          }
        }

        const result = await execInSandbox(sandboxId, `cd /workspace && ${command}`);
        const durationMs = Date.now() - start;

        // Parse test results from output
        const output = result.stdout + '\n' + result.stderr;
        let passed = 0, failed = 0, skipped = 0, total = 0;

        // npm/jest/vitest patterns
        const jestMatch = output.match(/Tests:\s*(\d+)\s*passed.*?(\d+)\s*failed.*?(\d+)\s*total/i) ||
                          output.match(/(\d+)\s*passing.*?(\d+)\s*failing/i);
        // pytest patterns
        const pytestMatch = output.match(/(\d+)\s*passed.*?(\d+)\s*failed/i) ||
                            output.match(/passed:\s*(\d+).*?failed:\s*(\d+)/i);
        // cargo patterns
        const cargoMatch = output.match(/test result:.*?(\d+)\s*passed.*?(\d+)\s*failed/i);
        // go patterns — count both passing and failing packages
        const goPassMatch = output.match(/ok\s+.*?\s+(\d+\.\d+)s/g);
        const goFailMatch = output.match(/FAIL\s+.*?\s+(\d+\.\d+)s/g);

        if (jestMatch) {
          passed = parseInt(jestMatch[1]) || 0;
          failed = parseInt(jestMatch[2]) || 0;
          total = jestMatch[3] ? (parseInt(jestMatch[3]) || 0) : (passed + failed);
        } else if (pytestMatch) {
          passed = parseInt(pytestMatch[1]) || 0;
          failed = parseInt(pytestMatch[2]) || 0;
          total = passed + failed;
        } else if (cargoMatch) {
          passed = parseInt(cargoMatch[1]) || 0;
          failed = parseInt(cargoMatch[2]) || 0;
          total = passed + failed;
        } else if (goPassMatch || goFailMatch) {
          passed = goPassMatch ? goPassMatch.length : 0;
          failed = goFailMatch ? goFailMatch.length : 0;
          total = passed + failed;
        }

        // Check for skipped tests
        const skipMatch = output.match(/(\d+)\s*skipped/i);
        if (skipMatch) {
          skipped = parseInt(skipMatch[1]) || 0;
          total += skipped;
        }

        const truncated = output.length > 8000;
        const truncatedOutput = truncated ? output.slice(0, 8000) + '\n\n[...output truncated]' : output;

        const statusIcon = result.exitCode === 0 ? '✓' : '✗';
        const lines: string[] = [
          `[Tool Result — sandbox_run_tests]`,
          `${statusIcon} Tests ${result.exitCode === 0 ? 'PASSED' : 'FAILED'} (${framework})`,
          `Command: ${command}`,
          `Duration: ${(durationMs / 1000).toFixed(1)}s`,
          total > 0 ? `Results: ${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ''}` : '',
          `\nOutput:\n${truncatedOutput}`,
        ].filter(Boolean);

        const cardData: TestResultsCardData = {
          framework,
          passed,
          failed,
          skipped,
          total,
          durationMs,
          exitCode: result.exitCode,
          output: truncatedOutput,
          truncated,
        };

        return { text: lines.join('\n'), card: { type: 'test-results', data: cardData } };
      }

      case 'sandbox_check_types': {
        const start = Date.now();

        // Auto-detect type checker
        let command = '';
        let tool: TypeCheckCardData['tool'] = 'unknown';

        // Check for TypeScript first (most common)
        const detectResult = await execInSandbox(
          sandboxId,
          'cd /workspace && ls -1 tsconfig.json pyrightconfig.json mypy.ini 2>/dev/null | head -1',
        );
        const detected = detectResult.stdout.trim();

        if (detected === 'tsconfig.json' || detected === 'tsconfig.app.json' || detected === 'tsconfig.node.json') {
          // Check if node_modules exists, install if missing
          const nodeModulesCheck = await execInSandbox(sandboxId, 'cd /workspace && ls -d node_modules 2>/dev/null');
          if (nodeModulesCheck.exitCode !== 0) {
            const installResult = await execInSandbox(sandboxId, 'cd /workspace && npm install');
            if (installResult.exitCode !== 0) {
              return { text: `[Tool Result — sandbox_check_types]\nFailed to install dependencies:\n${installResult.stderr}` };
            }
          }

          // Check if tsc is available and run type check
          const tscCheck = await execInSandbox(sandboxId, 'cd /workspace && npx tsc --version 2>/dev/null');
          if (tscCheck.exitCode === 0) {
            command = 'npx tsc --noEmit';
            tool = 'tsc';
          }
        } else if (detected === 'pyrightconfig.json') {
          // Check if pyright is available
          const pyrightCheck = await execInSandbox(sandboxId, 'cd /workspace && pyright --version 2>/dev/null');
          if (pyrightCheck.exitCode === 0) {
            command = 'pyright';
            tool = 'pyright';
          }
        } else if (detected === 'mypy.ini') {
          // Check if mypy is available
          const mypyCheck = await execInSandbox(sandboxId, 'cd /workspace && mypy --version 2>/dev/null');
          if (mypyCheck.exitCode === 0) {
            // Use 'mypy' without args to respect mypy.ini config paths
            command = 'mypy';
            tool = 'mypy';
          }
        }

        if (!command) {
          // Fallback: try tsc if package.json exists
          const pkgCheck = await execInSandbox(sandboxId, 'cd /workspace && cat package.json 2>/dev/null');
          if (pkgCheck.stdout.includes('typescript')) {
            command = 'npx tsc --noEmit';
            tool = 'tsc';
          } else {
            return { text: '[Tool Result — sandbox_check_types]\nNo type checker detected. Supported: TypeScript (tsc), Pyright, mypy.' };
          }
        }

        const result = await execInSandbox(sandboxId, `cd /workspace && ${command}`);
        const durationMs = Date.now() - start;

        const output = result.stdout + '\n' + result.stderr;
        const errors: TypeCheckCardData['errors'] = [];
        let errorCount = 0;
        let warningCount = 0;

        // Parse TypeScript errors: file.ts(line,col): error TS1234: message
        if (tool === 'tsc') {
          const tsErrorRegex = /(.+?)\((\d+),(\d+)\):\s*(error|warning)\s*(TS\d+):\s*(.+)/g;
          let match;
          while ((match = tsErrorRegex.exec(output)) !== null && errors.length < 50) {
            const isError = match[4] === 'error';
            if (isError) errorCount++;
            else warningCount++;
            errors.push({
              file: match[1],
              line: parseInt(match[2]),
              column: parseInt(match[3]),
              message: match[6],
              code: match[5],
            });
          }
          // Also check for "Found N errors" summary
          const summaryMatch = output.match(/Found (\d+) errors?/);
          if (summaryMatch) {
            errorCount = Math.max(errorCount, parseInt(summaryMatch[1]));
          }
        }

        // Parse Pyright errors: file.py:line:col - error: message
        if (tool === 'pyright') {
          const pyrightRegex = /(.+?):(\d+):(\d+)\s*-\s*(error|warning):\s*(.+)/g;
          let match;
          while ((match = pyrightRegex.exec(output)) !== null && errors.length < 50) {
            const isError = match[4] === 'error';
            if (isError) errorCount++;
            else warningCount++;
            errors.push({
              file: match[1],
              line: parseInt(match[2]),
              column: parseInt(match[3]),
              message: match[5],
            });
          }
        }

        // Parse mypy errors: file.py:line: error: message
        if (tool === 'mypy') {
          const mypyRegex = /(.+?):(\d+):\s*(error|warning):\s*(.+)/g;
          let match;
          while ((match = mypyRegex.exec(output)) !== null && errors.length < 50) {
            const isError = match[3] === 'error';
            if (isError) errorCount++;
            else warningCount++;
            errors.push({
              file: match[1],
              line: parseInt(match[2]),
              column: 0,
              message: match[4],
            });
          }
        }

        const truncated = output.length > 8000;
        const statusIcon = result.exitCode === 0 ? '✓' : '✗';
        const lines: string[] = [
          `[Tool Result — sandbox_check_types]`,
          `${statusIcon} Type check ${result.exitCode === 0 ? 'PASSED' : 'FAILED'} (${tool})`,
          `Command: ${command}`,
          `Duration: ${(durationMs / 1000).toFixed(1)}s`,
          errorCount > 0 || warningCount > 0 ? `Found: ${errorCount} error${errorCount !== 1 ? 's' : ''}${warningCount > 0 ? `, ${warningCount} warning${warningCount !== 1 ? 's' : ''}` : ''}` : '',
        ].filter(Boolean);

        if (errors.length > 0) {
          lines.push('\nErrors:');
          for (const err of errors.slice(0, 10)) {
            lines.push(`  ${err.file}:${err.line}${err.column ? `:${err.column}` : ''} — ${err.message}`);
          }
          if (errors.length > 10) {
            lines.push(`  ...and ${errors.length - 10} more`);
          }
        }

        const cardData: TypeCheckCardData = {
          tool,
          errors,
          errorCount,
          warningCount,
          exitCode: result.exitCode,
          truncated,
        };

        return { text: lines.join('\n'), card: { type: 'type-check', data: cardData } };
      }

      default:
        return { text: `[Tool Error] Unknown sandbox tool: ${(call as any).tool}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Push] Sandbox tool error:', msg);
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
- sandbox_run_tests(framework?) — Run the test suite. Auto-detects npm/pytest/cargo/go if framework not specified. Returns pass/fail counts and output.
- sandbox_check_types() — Run type checker (tsc for TypeScript, pyright/mypy for Python). Auto-detects from config files. Returns errors with file:line locations.

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
- IMPORTANT: sandbox_read_file only works on files, not directories. To explore the project structure, use sandbox_list_dir first, then read specific files.
- Use sandbox_run_tests BEFORE committing to catch regressions early. It's faster than sandbox_exec("npm test") and gives structured results.
- Use sandbox_check_types to validate TypeScript/Python code before committing. Catches type errors that tests might miss.`;
