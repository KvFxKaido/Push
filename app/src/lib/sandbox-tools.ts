/**
 * Sandbox tool definitions, detection, and execution.
 *
 * Mirrors the github-tools.ts pattern exactly:
 * - LLM outputs a JSON block with { tool, args }
 * - We detect, validate, execute, and return text + optional card
 *
 * Sandbox tools operate on a running Modal sandbox (persistent container).
 */

import type {
  ToolExecutionResult,
  ActiveRepo,
  SandboxCardData,
  DiffPreviewCardData,
  CommitReviewCardData,
  FileListCardData,
  TestResultsCardData,
  TypeCheckCardData,
  BrowserScreenshotCardData,
  BrowserExtractCardData,
  BrowserToolError,
} from '@/types';
import { extractBareToolJsonObjects } from './tool-dispatch';
import {
  execInSandbox,
  readFromSandbox,
  writeToSandbox,
  getSandboxDiff,
  listDirectory,
  browserScreenshotInSandbox,
  browserExtractInSandbox,
  downloadFromSandbox,
  type FileReadResult,
} from './sandbox-client';
import { runAuditor } from './auditor-agent';
import { browserToolEnabled } from './feature-flags';
import { recordBrowserMetric } from './browser-metrics';
import { safeStorageGet } from './safe-storage';

const OAUTH_STORAGE_KEY = 'github_access_token';
const APP_TOKEN_STORAGE_KEY = 'github_app_token';
const GITHUB_TOKEN = import.meta.env.VITE_GITHUB_TOKEN || '';

// --- Browser tool error taxonomy ---

const BROWSER_ERROR_MESSAGES: Record<string, string> = {
  NAVIGATION_TIMEOUT: 'The page took too long to load',
  INVALID_URL: "The URL couldn't be reached",
  BLOCKED_TARGET: "This URL points to a private or local network and can't be accessed",
  IMAGE_TOO_LARGE: 'The screenshot was too large to capture',
  SESSION_CREATE_FAILED: "Couldn't start a browser session — try again",
  BROWSERBASE_NOT_CONFIGURED: "Browser service isn't configured — contact your admin",
  BROWSER_CONNECT_URL_MISSING: "Couldn't start a browser session — try again",
  BROWSERBASE_HTTP_ERROR: "The browser service returned an error — try again",
  BROWSERBASE_EXECUTION_ERROR: 'Something went wrong while loading the page — try again',
  EMPTY_EXTRACTION: 'No readable text was found on the page',
};

function toBrowserToolError(code: string, fallbackDetails?: string): BrowserToolError {
  const message = BROWSER_ERROR_MESSAGES[code] || 'Something went wrong — try again';
  return { code, message: fallbackDetails && !BROWSER_ERROR_MESSAGES[code] ? `${message} (${fallbackDetails})` : message };
}

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

function getGitHubAuthToken(): string {
  return safeStorageGet(OAUTH_STORAGE_KEY) || safeStorageGet(APP_TOKEN_STORAGE_KEY) || GITHUB_TOKEN;
}

function getGitHubHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/vnd.github+json',
    Authorization: `token ${token}`,
  };
}

function sanitizeGitOutput(value: string, token: string): string {
  if (!value) return value;
  return value
    .replaceAll(token, '***')
    .replace(/x-access-token:[^@]+@/gi, 'x-access-token:***@');
}

interface CreatedRepoResponse {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url?: string;
  clone_url?: string;
  owner?: {
    login?: string;
  };
}

async function createGitHubRepo(
  repoName: string,
  description: string | undefined,
  isPrivate: boolean,
): Promise<CreatedRepoResponse> {
  const token = getGitHubAuthToken();
  if (!token) {
    throw new Error('GitHub auth required to promote. Connect a GitHub account in Settings.');
  }

  const response = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers: getGitHubHeaders(token),
    body: JSON.stringify({
      name: repoName,
      description: description || '',
      private: isPrivate,
      auto_init: false,
    }),
  });

  if (!response.ok) {
    let details = '';
    try {
      const body = await response.json() as { message?: string; errors?: Array<{ message?: string }> };
      details = body.message || body.errors?.[0]?.message || '';
    } catch {
      details = await response.text().catch(() => '');
    }
    if (response.status === 422) {
      throw new Error(`Repository creation failed: name likely already exists (${details || 'validation error'}).`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Repository creation failed: GitHub auth error (${details || response.status}).`);
    }
    throw new Error(`Repository creation failed (${response.status}): ${details || 'unknown error'}`);
  }

  return response.json() as Promise<CreatedRepoResponse>;
}



// --- Tool types ---

export type SandboxToolCall =
  | { tool: 'sandbox_exec'; args: { command: string; workdir?: string } }
  | { tool: 'sandbox_read_file'; args: { path: string } }
  | { tool: 'sandbox_search'; args: { query: string; path?: string } }
  | { tool: 'sandbox_write_file'; args: { path: string; content: string } }
  | { tool: 'sandbox_list_dir'; args: { path?: string } }
  | { tool: 'sandbox_diff'; args: Record<string, never> }
  | { tool: 'sandbox_prepare_commit'; args: { message: string } }
  | { tool: 'sandbox_push'; args: Record<string, never> }
  | { tool: 'sandbox_run_tests'; args: { framework?: string } }
  | { tool: 'sandbox_check_types'; args: Record<string, never> }
  | { tool: 'sandbox_browser_screenshot'; args: { url: string; fullPage?: boolean } }
  | { tool: 'sandbox_browser_extract'; args: { url: string; instruction?: string } }
  | { tool: 'sandbox_download'; args: { path?: string } }
  | { tool: 'sandbox_save_draft'; args: { message?: string; branch_name?: string } }
  | { tool: 'promote_to_github'; args: { repo_name: string; description?: string; private?: boolean } };

// --- Validation ---

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null ? (value as JsonRecord) : null;
}

function getToolName(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function getNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function validateSandboxToolCall(parsed: unknown): SandboxToolCall | null {
  const parsedObj = asRecord(parsed);
  if (!parsedObj) return null;
  const tool = getToolName(parsedObj.tool);
  const args = asRecord(parsedObj.args) || {};

  if (tool === 'sandbox_exec' && typeof args.command === 'string') {
    return { tool: 'sandbox_exec', args: { command: args.command, workdir: typeof args.workdir === 'string' ? args.workdir : undefined } };
  }
  if ((tool === 'sandbox_read_file' || tool === 'read_sandbox_file') && typeof args.path === 'string') {
    return { tool: 'sandbox_read_file', args: { path: args.path } };
  }
  if ((tool === 'sandbox_search' || tool === 'search_sandbox') && typeof args.query === 'string') {
    return { tool: 'sandbox_search', args: { query: args.query, path: typeof args.path === 'string' ? args.path : undefined } };
  }
  if (tool === 'sandbox_write_file' && typeof args.path === 'string' && typeof args.content === 'string') {
    return { tool: 'sandbox_write_file', args: { path: args.path, content: args.content } };
  }
  if (tool === 'sandbox_list_dir' || tool === 'list_sandbox_dir') {
    return { tool: 'sandbox_list_dir', args: { path: typeof args.path === 'string' ? args.path : undefined } };
  }
  if (tool === 'sandbox_diff') {
    return { tool: 'sandbox_diff', args: {} };
  }
  if ((tool === 'sandbox_prepare_commit' || tool === 'sandbox_commit') && typeof args.message === 'string') {
    return { tool: 'sandbox_prepare_commit', args: { message: args.message } };
  }
  if (tool === 'sandbox_push') {
    return { tool: 'sandbox_push', args: {} };
  }
  if (tool === 'sandbox_run_tests') {
    return { tool: 'sandbox_run_tests', args: { framework: typeof args.framework === 'string' ? args.framework : undefined } };
  }
  if (tool === 'sandbox_check_types') {
    return { tool: 'sandbox_check_types', args: {} };
  }
  const browserUrl = getNonEmptyString(args.url);
  if (tool === 'sandbox_browser_screenshot' && browserUrl && browserToolEnabled) {
    return { tool: 'sandbox_browser_screenshot', args: { url: browserUrl, fullPage: Boolean(args.fullPage) } };
  }
  if (tool === 'sandbox_browser_extract' && browserUrl && browserToolEnabled) {
    return { tool: 'sandbox_browser_extract', args: { url: browserUrl, instruction: typeof args.instruction === 'string' ? args.instruction : undefined } };
  }
  if (tool === 'sandbox_download') {
    return { tool: 'sandbox_download', args: { path: typeof args.path === 'string' ? args.path : undefined } };
  }
  if (tool === 'sandbox_save_draft') {
    return {
      tool: 'sandbox_save_draft',
      args: {
        message: typeof args.message === 'string' ? args.message : undefined,
        branch_name: typeof args.branch_name === 'string' ? args.branch_name : undefined,
      },
    };
  }
  if (tool === 'promote_to_github' && typeof args.repo_name === 'string') {
    const repoName = args.repo_name.trim();
    if (!repoName) return null;
    return {
      tool: 'promote_to_github',
      args: {
        repo_name: repoName,
        description: typeof args.description === 'string' ? args.description : undefined,
        private: typeof args.private === 'boolean' ? args.private : undefined,
      },
    };
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
      const toolName = getToolName(asRecord(parsed)?.tool);
      if (toolName.startsWith('sandbox_') || ['read_sandbox_file', 'search_sandbox', 'list_sandbox_dir', 'promote_to_github'].includes(toolName)) {
        const result = validateSandboxToolCall(parsed);
        if (result) return result;
      }
    } catch {
      // Not valid JSON
    }
  }

  // Bare JSON fallback (brace-counting handles nested objects)
  for (const parsed of extractBareToolJsonObjects(text)) {
    const toolName = getToolName(asRecord(parsed)?.tool);
    if (toolName.startsWith('sandbox_') || ['read_sandbox_file', 'search_sandbox', 'list_sandbox_dir', 'promote_to_github'].includes(toolName)) {
      const result = validateSandboxToolCall(parsed);
      if (result) return result;
    }
  }

  return null;
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
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

      case 'sandbox_search': {
        const query = call.args.query.trim();
        const searchPath = (call.args.path || '/workspace').trim() || '/workspace';

        if (!query) {
          return { text: '[Tool Error] sandbox_search requires a non-empty query.' };
        }

        const escapedQuery = shellEscape(query);
        const escapedPath = shellEscape(searchPath);
        const command = [
          'if command -v rg >/dev/null 2>&1; then',
          `  rg -n --hidden --glob '!.git' --color never --max-count 200 -- ${escapedQuery} ${escapedPath};`,
          'else',
          `  grep -RIn --exclude-dir=.git -- ${escapedQuery} ${escapedPath} | head -n 200;`,
          'fi',
        ].join(' ');

        const result = await execInSandbox(sandboxId, command);
        if (result.exitCode !== 0 && !result.stdout.trim()) {
          // rg returns exit code 1 when no matches; treat as a normal "no results" case.
          if (result.exitCode === 1) {
            return {
              text: `[Tool Result — sandbox_search]\nNo matches for "${query}" in ${searchPath}.`,
            };
          }
          return {
            text: formatSandboxError(result.stderr || 'Search failed', `sandbox_search (${searchPath})`),
          };
        }

        const output = result.stdout.trim();
        if (!output) {
          return {
            text: `[Tool Result — sandbox_search]\nNo matches for "${query}" in ${searchPath}.`,
          };
        }

        const lines = output
          .split('\n')
          .slice(0, 120)
          .map((line) => line.length > 320 ? `${line.slice(0, 320)}...` : line);

        const matchCount = lines.length;
        const truncated = output.split('\n').length > lines.length || result.truncated;

        return {
          text: [
            '[Tool Result — sandbox_search]',
            `Query: ${query}`,
            `Path: ${searchPath}`,
            `Matches: ${matchCount}${truncated ? ' (truncated)' : ''}`,
            '',
            ...lines,
          ].join('\n'),
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

      case 'sandbox_browser_screenshot': {
        if (!browserToolEnabled) {
          return { text: '[Tool Error] Browser tools are disabled. Set VITE_BROWSER_TOOL_ENABLED=true to enable.' };
        }

        const targetUrl = call.args.url.trim();
        if (!/^https?:\/\//i.test(targetUrl)) {
          return { text: '[Tool Error] sandbox_browser_screenshot requires an absolute http(s) URL.' };
        }

        const ssStart = Date.now();
        let ssRetries = 0;
        let ssResult: Awaited<ReturnType<typeof browserScreenshotInSandbox>>;
        try {
          ssResult = await browserScreenshotInSandbox(
            sandboxId, targetUrl, Boolean(call.args.fullPage),
            (r) => { ssRetries = r; },
          );
        } catch (screenshotErr) {
          const ssDuration = Date.now() - ssStart;
          const errMsg = screenshotErr instanceof Error ? screenshotErr.message : String(screenshotErr);
          const errCode = errMsg.match(/\(([A-Z_]+)\)/)?.[1] || 'FETCH_ERROR';
          recordBrowserMetric('screenshot', { durationMs: ssDuration, success: false, errorCode: errCode, retries: ssRetries });
          throw screenshotErr;
        }
        const ssDuration = Date.now() - ssStart;

        if (!ssResult.ok) {
          const errorCode = ssResult.error || 'UNKNOWN';
          recordBrowserMetric('screenshot', { durationMs: ssDuration, success: false, errorCode, retries: ssRetries });
          const error = toBrowserToolError(errorCode, ssResult.details);
          const cardData: BrowserScreenshotCardData = {
            url: targetUrl,
            finalUrl: targetUrl,
            title: '',
            statusCode: null,
            mimeType: '',
            imageBase64: '',
            truncated: false,
            error,
          };
          return {
            text: `[Tool Error] ${error.message}`,
            card: { type: 'browser-screenshot', data: cardData },
          };
        }

        if (!ssResult.image_base64 || !ssResult.mime_type) {
          recordBrowserMetric('screenshot', { durationMs: ssDuration, success: false, errorCode: 'MISSING_IMAGE_DATA', retries: ssRetries });
          return { text: '[Tool Error] Browser screenshot response was missing image data.' };
        }

        recordBrowserMetric('screenshot', { durationMs: ssDuration, success: true, retries: ssRetries });

        const cardData: BrowserScreenshotCardData = {
          url: targetUrl,
          finalUrl: ssResult.final_url || targetUrl,
          title: ssResult.title || 'Browser Screenshot',
          statusCode: typeof ssResult.status_code === 'number' ? ssResult.status_code : null,
          mimeType: ssResult.mime_type,
          imageBase64: ssResult.image_base64,
          truncated: Boolean(ssResult.truncated),
        };

        const lines = [
          '[Tool Result — sandbox_browser_screenshot]',
          `URL: ${cardData.url}`,
          `Final URL: ${cardData.finalUrl}`,
          `Title: ${cardData.title}`,
          `Status: ${cardData.statusCode === null ? 'n/a' : cardData.statusCode}`,
          cardData.truncated ? 'Image truncated: yes' : 'Image truncated: no',
        ];

        return { text: lines.join('\n'), card: { type: 'browser-screenshot', data: cardData } };
      }

      case 'sandbox_browser_extract': {
        if (!browserToolEnabled) {
          return { text: '[Tool Error] Browser tools are disabled. Set VITE_BROWSER_TOOL_ENABLED=true to enable.' };
        }

        const targetUrl = call.args.url.trim();
        if (!/^https?:\/\//i.test(targetUrl)) {
          return { text: '[Tool Error] sandbox_browser_extract requires an absolute http(s) URL.' };
        }

        const instruction = (call.args.instruction || '').trim();
        const exStart = Date.now();
        let exRetries = 0;
        let exResult: Awaited<ReturnType<typeof browserExtractInSandbox>>;
        try {
          exResult = await browserExtractInSandbox(
            sandboxId, targetUrl, instruction,
            (r) => { exRetries = r; },
          );
        } catch (extractErr) {
          const exDuration = Date.now() - exStart;
          const errMsg = extractErr instanceof Error ? extractErr.message : String(extractErr);
          const errCode = errMsg.match(/\(([A-Z_]+)\)/)?.[1] || 'FETCH_ERROR';
          recordBrowserMetric('extract', { durationMs: exDuration, success: false, errorCode: errCode, retries: exRetries });
          throw extractErr;
        }
        const exDuration = Date.now() - exStart;

        if (!exResult.ok) {
          const errorCode = exResult.error || 'UNKNOWN';
          recordBrowserMetric('extract', { durationMs: exDuration, success: false, errorCode, retries: exRetries });
          const error = toBrowserToolError(errorCode, exResult.details);
          const cardData: BrowserExtractCardData = {
            url: targetUrl,
            finalUrl: targetUrl,
            title: '',
            statusCode: null,
            instruction: instruction || undefined,
            content: '',
            truncated: false,
            error,
          };
          return {
            text: `[Tool Error] ${error.message}`,
            card: { type: 'browser-extract', data: cardData },
          };
        }

        const content = (exResult.content || '').trim();
        if (!content) {
          recordBrowserMetric('extract', { durationMs: exDuration, success: false, errorCode: 'EMPTY_CONTENT', retries: exRetries });
          return { text: '[Tool Error] Browser extract returned no content.' };
        }

        recordBrowserMetric('extract', { durationMs: exDuration, success: true, retries: exRetries });

        const cardData: BrowserExtractCardData = {
          url: targetUrl,
          finalUrl: exResult.final_url || targetUrl,
          title: exResult.title || 'Browser Extract',
          statusCode: typeof exResult.status_code === 'number' ? exResult.status_code : null,
          instruction: instruction || undefined,
          content,
          truncated: Boolean(exResult.truncated),
        };

        const lines = [
          '[Tool Result — sandbox_browser_extract]',
          `URL: ${cardData.url}`,
          `Final URL: ${cardData.finalUrl}`,
          `Title: ${cardData.title}`,
          `Status: ${cardData.statusCode === null ? 'n/a' : cardData.statusCode}`,
          cardData.truncated ? 'Content truncated: yes' : 'Content truncated: no',
          '',
          cardData.content,
        ];

        return { text: lines.join('\n'), card: { type: 'browser-extract', data: cardData } };
      }

      case 'sandbox_download': {
        const archivePath = call.args.path || '/workspace';
        const result = await downloadFromSandbox(sandboxId, archivePath);

        if (!result.ok || !result.archiveBase64) {
          return { text: `[Tool Error] Download failed: ${result.error || 'Unknown error'}` };
        }

        const sizeKB = Math.round((result.sizeBytes || 0) / 1024);
        return {
          text: `[Tool Result — sandbox_download]\nArchive ready: ${result.format} (${sizeKB} KB)`,
          card: {
            type: 'sandbox-download',
            data: {
              path: archivePath,
              format: result.format || 'tar.gz',
              sizeBytes: result.sizeBytes || 0,
              archiveBase64: result.archiveBase64,
            },
          },
        };
      }

      case 'sandbox_save_draft': {
        // Step 1: Check for uncommitted changes
        const draftDiffResult = await getSandboxDiff(sandboxId);

        if (draftDiffResult.error) {
          return { text: `[Tool Error — sandbox_save_draft]\n${draftDiffResult.error}` };
        }

        if (!draftDiffResult.diff) {
          return { text: '[Tool Result — sandbox_save_draft]\nNo changes to save. Working tree is clean.' };
        }

        // Step 2: Get current branch
        const currentBranchResult = await execInSandbox(sandboxId, 'cd /workspace && git branch --show-current');
        const currentBranch = currentBranchResult.exitCode === 0 ? currentBranchResult.stdout.trim() : '';

        // Step 3: Determine draft branch name — must start with draft/ (unaudited path)
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        if (call.args.branch_name && !call.args.branch_name.startsWith('draft/')) {
          return { text: '[Tool Error — sandbox_save_draft]\nbranch_name must start with "draft/". This tool skips Auditor review and is restricted to draft branches. Use sandbox_prepare_commit for non-draft branches.' };
        }
        const draftBranchName = call.args.branch_name || `draft/${currentBranch || 'main'}-${timestamp}`;

        // Step 4: Create draft branch if not already on one
        const needsNewBranch = !currentBranch.startsWith('draft/');
        if (needsNewBranch) {
          const checkoutResult = await execInSandbox(
            sandboxId,
            `cd /workspace && git checkout -b ${shellEscape(draftBranchName)}`,
          );
          if (checkoutResult.exitCode !== 0) {
            return { text: `[Tool Error — sandbox_save_draft]\nFailed to create draft branch: ${checkoutResult.stderr}` };
          }
        }

        const activeDraftBranch = needsNewBranch ? draftBranchName : currentBranch;

        // Step 5: Stage all changes and commit (no Auditor — drafts are WIP)
        const draftMessage = call.args.message || 'WIP: draft save';
        const stageResult = await execInSandbox(sandboxId, 'cd /workspace && git add -A');
        if (stageResult.exitCode !== 0) {
          return { text: `[Tool Error — sandbox_save_draft]\nFailed to stage changes: ${stageResult.stderr}` };
        }

        const commitResult = await execInSandbox(
          sandboxId,
          `cd /workspace && git commit -m ${shellEscape(draftMessage)}`,
        );
        if (commitResult.exitCode !== 0) {
          return { text: `[Tool Error — sandbox_save_draft]\nFailed to commit draft: ${commitResult.stderr}` };
        }

        // Step 6: Push to remote
        const pushResult = await execInSandbox(
          sandboxId,
          `cd /workspace && git push -u origin ${shellEscape(activeDraftBranch)}`,
        );

        const pushOk = pushResult.exitCode === 0;
        const commitSha = commitResult.stdout.match(/\[.+? ([a-f0-9]+)\]/)?.[1] || 'unknown';
        const draftStats = parseDiffStats(draftDiffResult.diff);

        const draftLines: string[] = [
          `[Tool Result — sandbox_save_draft]`,
          `Draft saved to branch: ${activeDraftBranch}`,
          `Commit: ${commitSha}`,
          `Message: ${draftMessage}`,
          `${draftStats.filesChanged} file${draftStats.filesChanged !== 1 ? 's' : ''} changed, +${draftStats.additions} -${draftStats.deletions}`,
          pushOk ? 'Pushed to remote.' : `Push failed: ${pushResult.stderr}. Use sandbox_push() to retry.`,
        ];

        const draftCardData: DiffPreviewCardData = {
          diff: draftDiffResult.diff,
          filesChanged: draftStats.filesChanged,
          additions: draftStats.additions,
          deletions: draftStats.deletions,
          truncated: draftDiffResult.truncated,
        };

        return {
          text: draftLines.join('\n'),
          card: { type: 'diff-preview', data: draftCardData },
          // Propagate branch switch to app state so chat/merge context stays in sync
          ...(needsNewBranch ? { branchSwitch: activeDraftBranch } : {}),
        };
      }

      case 'promote_to_github': {
        const requestedName = call.args.repo_name.trim();
        const repoName = requestedName.includes('/') ? requestedName.split('/').pop()!.trim() : requestedName;
        if (!repoName) {
          return { text: '[Tool Error] promote_to_github requires a valid repo_name.' };
        }

        const createdRepo = await createGitHubRepo(
          repoName,
          call.args.description,
          call.args.private !== undefined ? call.args.private : true,
        );

        const authToken = getGitHubAuthToken();
        if (!authToken) {
          return { text: '[Tool Error] GitHub auth token missing after repo creation.' };
        }
        const remoteUrl = `https://x-access-token:${authToken}@github.com/${createdRepo.full_name}.git`;

        const branchResult = await execInSandbox(
          sandboxId,
          'cd /workspace && git rev-parse --abbrev-ref HEAD',
        );
        const branchName = branchResult.exitCode === 0
          ? (branchResult.stdout.trim() || createdRepo.default_branch || 'main')
          : (createdRepo.default_branch || 'main');

        const remoteResult = await execInSandbox(
          sandboxId,
          `cd /workspace && if git remote get-url origin >/dev/null 2>&1; then git remote set-url origin ${shellEscape(remoteUrl)}; else git remote add origin ${shellEscape(remoteUrl)}; fi`,
        );
        if (remoteResult.exitCode !== 0) {
          const remoteError = sanitizeGitOutput(remoteResult.stderr || remoteResult.stdout || 'unknown error', authToken);
          return { text: `[Tool Error] Created repo ${createdRepo.full_name}, but failed to configure git remote: ${remoteError}` };
        }

        const pushResult = await execInSandbox(
          sandboxId,
          `cd /workspace && git push -u origin ${shellEscape(branchName)}`,
        );

        const rawPushError = `${pushResult.stderr}\n${pushResult.stdout}`.toLowerCase();
        const noCommitsYet = rawPushError.includes('src refspec')
          || rawPushError.includes('does not match any')
          || rawPushError.includes('no commits yet');

        const repoObject: ActiveRepo = {
          id: createdRepo.id,
          name: createdRepo.name,
          full_name: createdRepo.full_name,
          owner: createdRepo.owner?.login || createdRepo.full_name.split('/')[0],
          default_branch: createdRepo.default_branch || branchName || 'main',
          private: createdRepo.private,
        };

        if (pushResult.exitCode !== 0 && !noCommitsYet) {
          const pushError = sanitizeGitOutput(pushResult.stderr || pushResult.stdout || 'unknown error', authToken);
          return {
            text: `[Tool Error] Repo ${createdRepo.full_name} was created, but push failed: ${pushError}. You can retry after fixing git/auth state.`,
          };
        }

        const warning = pushResult.exitCode !== 0 && noCommitsYet
          ? 'Repo created and remote configured, but there were no local commits to push yet.'
          : undefined;

        const lines = [
          '[Tool Result — promote_to_github]',
          `Repository created: ${createdRepo.full_name}`,
          `Visibility: ${createdRepo.private ? 'private' : 'public'}`,
          `Default branch: ${createdRepo.default_branch || branchName || 'main'}`,
          warning ? `Warning: ${warning}` : `Push: successful on branch ${branchName}`,
        ];

        return {
          text: lines.join('\n'),
          promotion: {
            repo: repoObject,
            pushed: !warning,
            warning,
            htmlUrl: createdRepo.html_url,
          },
        };
      }

      default:
        return { text: `[Tool Error] Unknown sandbox tool: ${String((call as { tool?: unknown }).tool ?? 'unknown')}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Push] Sandbox tool error:', msg);
    return { text: `[Tool Error] ${msg}` };
  }
}

// --- System prompt extension ---

const BROWSER_TOOL_PROTOCOL_LINE = browserToolEnabled
  ? '\n- sandbox_browser_screenshot(url, fullPage?) — Capture a webpage screenshot in the sandbox browser and return it as a card.\n- sandbox_browser_extract(url, instruction?) — Extract readable page text (or focused content with instruction) from a webpage.'
  : '';

const BROWSER_RULES_BLOCK = browserToolEnabled
  ? `- For webpage tasks with external URLs, prefer browser tools first:
  - Use sandbox_browser_screenshot for visual capture
  - Use sandbox_browser_extract for text extraction
  - Do not default to sandbox_exec with curl/python for these unless browser tools fail
`
  : '';

export const SANDBOX_TOOL_PROTOCOL = `
SANDBOX TOOLS — You have access to a code sandbox (persistent container with the repo cloned).

Additional tools available when sandbox is active:
- sandbox_exec(command, workdir?) — Run a shell command in the sandbox (default workdir: /workspace)
- sandbox_read_file(path) — Read a single file from the sandbox filesystem. Only works on files — fails on directories.
- sandbox_search(query, path?) — Search file contents in the sandbox (uses rg/grep). Fast way to locate functions, symbols, and strings before editing.
- sandbox_list_dir(path?) — List files and folders in a sandbox directory (default: /workspace). Use this to explore the project structure before reading specific files.
- sandbox_write_file(path, content) — Write or overwrite a file in the sandbox
- sandbox_diff() — Get the git diff of all uncommitted changes
- sandbox_prepare_commit(message) — Prepare a commit for review. Gets diff, runs Auditor. If SAFE, returns a review card for user approval. Does NOT commit — user must approve via the UI.
- sandbox_push() — Retry a failed push. Use this only if a push failed after approval. No Auditor needed (commit was already audited).
- sandbox_run_tests(framework?) — Run the test suite. Auto-detects npm/pytest/cargo/go if framework not specified. Returns pass/fail counts and output.
- sandbox_check_types() — Run type checker (tsc for TypeScript, pyright/mypy for Python). Auto-detects from config files. Returns errors with file:line locations.
- sandbox_save_draft(message?, branch_name?) — Quick-save all uncommitted changes to a draft branch. Stages everything, commits with the message (default: "WIP: draft save"), and pushes. Skips Auditor review (drafts are WIP). If not already on a draft/ branch, creates one automatically. Use this for checkpoints, WIP saves, or before sandbox expiry.
- sandbox_download(path?) — Download workspace files as a compressed archive (tar.gz). Path defaults to /workspace. Returns a download card the user can save.${BROWSER_TOOL_PROTOCOL_LINE}
- promote_to_github(repo_name, description?, private?) — Create a new GitHub repo under the authenticated user, set the sandbox git remote, and push current branch. Defaults to private=true.

Compatibility aliases also work:
- read_sandbox_file(path) → sandbox_read_file
- search_sandbox(query, path?) → sandbox_search
- list_sandbox_dir(path?) → sandbox_list_dir

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
${BROWSER_RULES_BLOCK}- sandbox_diff shows what you've changed — review before committing
- sandbox_prepare_commit triggers the Auditor for safety review, then presents a review card. The user approves or rejects via the UI.
- If the push fails after a successful commit, use sandbox_push() to retry
- Keep commands focused — avoid long-running servers or background processes
- IMPORTANT: sandbox_read_file only works on files, not directories. To explore the project structure, use sandbox_list_dir first, then read specific files.
- Before delegating code changes, prefer sandbox_search to quickly locate relevant files/functions and provide precise context.
- Use sandbox_run_tests BEFORE committing to catch regressions early. It's faster than sandbox_exec("npm test") and gives structured results.
- Use sandbox_check_types to validate TypeScript/Python code before committing. Catches type errors that tests might miss.`;
