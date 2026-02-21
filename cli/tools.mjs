import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { applyHashlineEdits, calculateContentVersion, renderAnchoredRange } from './hashline.mjs';

const execFileAsync = promisify(execFile);

export const MAX_TOOL_OUTPUT_CHARS = 24_000;
const DEFAULT_SEARCH_RESULTS = 120;

const READ_ONLY_TOOLS = new Set(['read_file', 'list_dir', 'search_files', 'read_symbols', 'git_status', 'git_diff']);

// Patterns that indicate high-risk shell commands requiring user approval
const HIGH_RISK_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*[rRf]|--recursive|--force)/,
  /\brm\s+-[a-zA-Z]*\s/,
  /\bgit\s+reset\s+--hard/,
  /\bgit\s+clean\s+-[a-zA-Z]*[fd]/,
  /\bgit\s+push\s+.*--force/,
  /\bgit\s+push\s+-f\b/,
  /\bgit\s+checkout\s+\.\s*$/,
  /\bgit\s+restore\s+\.\s*$/,
  /\bchmod\s+.*[0-7]{3,4}/,
  /\bchown\b/,
  /\bmkfs\b/,
  /\bdd\s+/,
  /\b(curl|wget)\s+.*\|\s*(ba)?sh/,
  />\s*\/dev\/sd[a-z]/,
  /\bsudo\b/,
  /\bnpm\s+publish\b/,
  /\bdropdb\b/,
  /\bdrop\s+database\b/i,
  /\bdrop\s+table\b/i,
  /\btruncate\s+table\b/i,
];

export function isHighRiskCommand(command) {
  return HIGH_RISK_PATTERNS.some((pattern) => pattern.test(command));
}

export function isReadOnlyToolCall(call) {
  return Boolean(call && READ_ONLY_TOOLS.has(call.tool));
}

export const TOOL_PROTOCOL = `TOOL PROTOCOL

When you need tools, output one or more fenced JSON blocks:
\`\`\`json
{"tool":"tool_name","args":{"key":"value"}}
\`\`\`

Available tools:
- read_file(path, start_line?, end_line?) — read file content with stable line hash anchors
- list_dir(path?) — list files/directories
- search_files(pattern, path?, max_results?) — text search in workspace
- exec(command, timeout_ms?) — run a shell command
- write_file(path, content) — write full file content
- edit_file(path, edits, expected_version?) — surgical hashline edits. edits[] ops: replace_line | insert_after | insert_before | delete_line, each with ref and optional content
- read_symbols(path) — extract function/class/type declarations from a file
- git_status() — workspace git status (branch, dirty files)
- git_diff(path?, staged?) — show git diff (optionally for a specific file, optionally staged)
- git_commit(message, paths?) — stage and commit files (all files if paths not specified)
- save_memory(content) — persist learnings across sessions (stored in .push/memory.md). Save project patterns, build commands, conventions. Keep concise — this is loaded into every future session.
- coder_update_state(plan?, openTasks?, filesTouched?, assumptions?, errorsEncountered?) — update working memory (no filesystem action)

Rules:
- Paths are relative to workspace root unless absolute inside workspace.
- Never attempt paths outside workspace.
- You may emit multiple tool calls in one assistant reply.
- Emit at most one mutating filesystem/exec tool call per reply; read-only calls can be batched.
- Prefer edit_file over full-file rewrites when possible.
- If a tool fails, correct the call and retry when appropriate.
- Do not describe tool calls in prose. Emit only JSON blocks for tool calls.`;

/**
 * Behavioral rules only — used with native function calling where tool
 * definitions are sent as structured schemas in the request body.
 */
export const TOOL_RULES = `Tool Rules:
- Paths are relative to workspace root unless absolute inside workspace.
- Never attempt paths outside workspace.
- You may emit multiple tool calls in one assistant reply.
- Emit at most one mutating tool call per reply; read-only calls can be batched.
- Prefer edit_file over full-file rewrites when possible.
- If a tool fails, correct the call and retry when appropriate.
- Do not describe tool calls in prose; use tool calls directly.`;

export function truncateText(text, max = MAX_TOOL_OUTPUT_CHARS) {
  if (text.length <= max) return text;
  const totalLines = text.split('\n').length;
  const kept = text.slice(0, max);
  const keptLines = kept.split('\n').length;
  const extra = text.length - max;
  return `${kept}\n\n[truncated ${extra} chars, showing ${keptLines}/${totalLines} lines — use start_line/end_line to read specific ranges]`;
}

function asString(value, field) {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

function asOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseToolCallCandidate(candidate) {
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return { ok: false, reason: 'json_parse_error' };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'invalid_shape' };
  }

  if (typeof parsed.tool !== 'string') {
    return { ok: false, reason: 'missing_tool' };
  }

  if (!parsed.args || typeof parsed.args !== 'object' || Array.isArray(parsed.args)) {
    return { ok: false, reason: 'missing_args_object' };
  }

  return {
    ok: true,
    call: {
      tool: parsed.tool,
      args: parsed.args,
    },
  };
}

function isLikelyToolCallCandidate(candidate) {
  if (!candidate) return false;
  const trimmed = candidate.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
  return /"tool"\s*:/.test(trimmed);
}

export function detectAllToolCalls(text) {
  const calls = [];
  const malformed = [];

  const fenceRegex = /```(?:\s*(\w+))?\s*\n?([\s\S]*?)\n?\s*```/g;
  let match;
  while ((match = fenceRegex.exec(text)) !== null) {
    const lang = (match[1] || '').toLowerCase();
    const candidate = (match[2] || '').trim();
    if (!candidate) continue;
    if (lang && lang !== 'json') continue;
    if (!isLikelyToolCallCandidate(candidate)) continue;
    const parsed = parseToolCallCandidate(candidate);
    if (parsed.ok) {
      calls.push(parsed.call);
    } else {
      malformed.push({ reason: parsed.reason, sample: candidate.slice(0, 120) });
    }
  }

  if (calls.length === 0) {
    const trimmed = text.trim();
    if (isLikelyToolCallCandidate(trimmed)) {
      const parsed = parseToolCallCandidate(trimmed);
      if (parsed.ok) {
        calls.push(parsed.call);
      } else {
        malformed.push({ reason: parsed.reason, sample: trimmed.slice(0, 120) });
      }
    }
  }

  return { calls, malformed };
}

export function detectToolCall(text) {
  const detected = detectAllToolCalls(text);
  return detected.calls[0] || null;
}

export function ensureInsideWorkspace(workspaceRoot, rawPath) {
  const trimmed = rawPath.trim();
  if (!trimmed) throw new Error('path is required');
  const resolved = path.resolve(workspaceRoot, trimmed);
  const root = path.resolve(workspaceRoot);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error('path escapes workspace root');
  }
  return resolved;
}

function formatExecOutput(stdout, stderr, exitCode, timedOut = false) {
  const parts = [`exit_code: ${exitCode}`];
  if (timedOut) parts.push('timed_out: true');
  if (stdout.trim()) parts.push(`stdout:\n${stdout}`);
  if (stderr.trim()) parts.push(`stderr:\n${stderr}`);
  if (!stdout.trim() && !stderr.trim()) parts.push('stdout:\n<empty>');
  return parts.join('\n\n');
}

function classifyToolError(err) {
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  if (lower.includes('path escapes workspace root')) {
    return { code: 'PATH_ESCAPE', message, retryable: false };
  }
  if (lower.includes('enoent') || lower.includes('no such file')) {
    return { code: 'NOT_FOUND', message, retryable: true };
  }
  if (lower.includes('stale ref') || lower.includes('stale expected_version')) {
    return { code: 'STALE_WRITE', message, retryable: true };
  }
  if (lower.includes('ambiguous ref')) {
    return { code: 'AMBIGUOUS_REF', message, retryable: true };
  }
  if (lower.includes('must be') || lower.includes('required') || lower.includes('invalid')) {
    return { code: 'INVALID_ARGS', message, retryable: false };
  }
  return { code: 'TOOL_ERROR', message, retryable: false };
}

async function executeSearch(pattern, searchRoot, maxResults) {
  try {
    const { stdout } = await execFileAsync('rg', [
      '--line-number',
      '--no-heading',
      '--color',
      'never',
      '--max-count',
      String(maxResults),
      pattern,
      searchRoot,
    ], { maxBuffer: 2_000_000 });
    return stdout.trim() || 'No matches';
  } catch (err) {
    if (err.code === 1) return (err.stdout || '').trim() || 'No matches';
    if (err.code === 'ENOENT') {
      try {
        const { stdout } = await execFileAsync('grep', [
          '-RIn',
          '--binary-files=without-match',
          '--',
          pattern,
          searchRoot,
        ], { maxBuffer: 2_000_000 });
        return stdout.trim() || 'No matches';
      } catch (grepErr) {
        if (grepErr.code === 1) return (grepErr.stdout || '').trim() || 'No matches';
        throw new Error(`Search failed: ${grepErr.message}`);
      }
    }
    throw new Error(`Search failed: ${err.message}`);
  }
}

/**
 * Best-effort backup of a file before mutation.
 * Stored in .push/backups/ with a timestamped name.
 */
export async function backupFile(filePath, workspaceRoot) {
  try {
    await fs.access(filePath); // only backup if file exists
    const backupDir = path.join(workspaceRoot, '.push', 'backups');
    await fs.mkdir(backupDir, { recursive: true });
    const relative = path.relative(workspaceRoot, filePath).replace(/\//g, '__');
    const backupPath = path.join(backupDir, `${relative}.${Date.now()}.bak`);
    await fs.copyFile(filePath, backupPath);
  } catch {
    // Best-effort — don't fail the write/edit if backup fails
  }
}

/**
 * Execute a tool call. Options:
 * - approvalFn(tool, detail): async fn that returns true to proceed, false to deny.
 *   If not provided, all calls proceed (headless default: deny high-risk).
 */
export async function executeToolCall(call, workspaceRoot, options = {}) {
  try {
    switch (call.tool) {
      case 'read_file': {
        const filePath = ensureInsideWorkspace(workspaceRoot, asString(call.args.path, 'path'));
        const raw = await fs.readFile(filePath, 'utf8');
        const startLine = asOptionalNumber(call.args.start_line);
        const endLine = asOptionalNumber(call.args.end_line);

        const rendered = renderAnchoredRange(raw, startLine, endLine);
        return {
          ok: true,
          text: truncateText(rendered.text || '<empty file>'),
          meta: {
            path: filePath,
            start_line: rendered.startLine,
            end_line: rendered.endLine,
            total_lines: rendered.totalLines,
            lines: rendered.endLine - rendered.startLine + 1,
            version: calculateContentVersion(raw),
            anchored: true,
          },
        };
      }

      case 'list_dir': {
        const dirArg = typeof call.args.path === 'string' ? call.args.path : '.';
        const dirPath = ensureInsideWorkspace(workspaceRoot, dirArg);
        const entries = await fs.readdir(dirPath, { withFileTypes: true });
        const mapped = entries
          .map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : 'other',
          }))
          .sort((a, b) => {
            if (a.type === b.type) return a.name.localeCompare(b.name);
            if (a.type === 'dir') return -1;
            if (b.type === 'dir') return 1;
            return a.name.localeCompare(b.name);
          })
          .slice(0, 300);
        const text = mapped.map((entry) => `${entry.type === 'dir' ? 'd' : 'f'} ${entry.name}`).join('\n');
        return {
          ok: true,
          text: text || '<empty directory>',
          meta: { path: dirPath, count: mapped.length },
        };
      }

      case 'search_files': {
        const pattern = asString(call.args.pattern, 'pattern').trim();
        if (!pattern) throw new Error('pattern cannot be empty');
        const searchPath = typeof call.args.path === 'string' ? ensureInsideWorkspace(workspaceRoot, call.args.path) : workspaceRoot;
        const maxResults = clamp(asOptionalNumber(call.args.max_results) ?? DEFAULT_SEARCH_RESULTS, 1, 1000);
        const output = await executeSearch(pattern, searchPath, maxResults);
        return {
          ok: true,
          text: truncateText(output),
          meta: { path: searchPath, max_results: maxResults },
        };
      }

      case 'exec': {
        const command = asString(call.args.command, 'command');
        const timeoutMs = clamp(asOptionalNumber(call.args.timeout_ms) ?? 90_000, 1_000, 180_000);

        if (isHighRiskCommand(command)) {
          const { approvalFn } = options;
          if (!approvalFn) {
            return {
              ok: false,
              text: `Blocked: "${command}" is a high-risk command. Not allowed in headless mode without approval.`,
              structuredError: {
                code: 'APPROVAL_REQUIRED',
                message: 'High-risk command blocked in non-interactive mode',
                retryable: false,
              },
            };
          }
          const approved = await approvalFn('exec', command);
          if (!approved) {
            return {
              ok: false,
              text: `Denied by user: "${command}" was not approved for execution.`,
              structuredError: {
                code: 'APPROVAL_DENIED',
                message: 'User denied high-risk command',
                retryable: false,
              },
            };
          }
        }

        try {
          const isLocalSandbox = process.env.PUSH_LOCAL_SANDBOX === 'true';
          const bin = isLocalSandbox ? 'docker' : '/bin/bash';
          const args = isLocalSandbox 
            ? ['run', '--rm', '-v', `${workspaceRoot}:/workspace`, '-w', '/workspace', 'push-sandbox', 'bash', '-lc', command]
            : ['-lc', command];
          const execOpts = {
            cwd: workspaceRoot,
            timeout: timeoutMs,
            maxBuffer: 4_000_000,
          };
          if (options.signal) execOpts.signal = options.signal;
          const { stdout, stderr } = await execFileAsync(bin, args, execOpts);
          return {
            ok: true,
            text: truncateText(formatExecOutput(stdout, stderr, 0)),
            meta: { command, timeout_ms: timeoutMs },
          };
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          const exitCode = typeof err.code === 'number' ? err.code : 1;
          return {
            ok: false,
            text: truncateText(formatExecOutput(err.stdout || '', err.stderr || err.message, exitCode, Boolean(err.killed))),
            structuredError: {
              code: err.killed ? 'EXEC_TIMEOUT' : 'EXEC_FAILED',
              message: err.killed ? 'Command timed out' : `Command exited with code ${exitCode}`,
              retryable: true,
            },
            meta: { command, timeout_ms: timeoutMs, exit_code: exitCode, timed_out: Boolean(err.killed) },
          };
        }
      }

      case 'write_file': {
        const filePath = ensureInsideWorkspace(workspaceRoot, asString(call.args.path, 'path'));
        const content = asString(call.args.content, 'content');
        await backupFile(filePath, workspaceRoot);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, 'utf8');
        return {
          ok: true,
          text: `Wrote ${content.length} bytes to ${path.relative(workspaceRoot, filePath) || '.'}`,
          meta: { path: filePath, bytes: content.length, version: calculateContentVersion(content) },
        };
      }

      case 'edit_file': {
        const filePath = ensureInsideWorkspace(workspaceRoot, asString(call.args.path, 'path'));
        const edits = Array.isArray(call.args.edits) ? call.args.edits : null;
        if (!edits) throw new Error('edits must be an array');

        await backupFile(filePath, workspaceRoot);
        const before = await fs.readFile(filePath, 'utf8');
        const versionBefore = calculateContentVersion(before);

        if (typeof call.args.expected_version === 'string' && call.args.expected_version.trim()) {
          const expected = call.args.expected_version.trim();
          if (expected !== versionBefore) {
            return {
              ok: false,
              text: `Stale expected_version: expected ${expected}, found ${versionBefore}. Re-read file and retry.`,
              structuredError: {
                code: 'STALE_WRITE',
                message: `expected_version mismatch: expected ${expected}, found ${versionBefore}`,
                retryable: true,
              },
              meta: { path: filePath, version_before: versionBefore },
            };
          }
        }

        const applied = applyHashlineEdits(before, edits);
        await fs.writeFile(filePath, applied.content, 'utf8');
        const versionAfter = calculateContentVersion(applied.content);

        // Build context preview around each edit site
        const afterLines = applied.content.split('\n');
        const previews = applied.applied.map(({ op, line }) => {
          const center = line - 1; // 0-indexed
          const start = Math.max(0, center - 3);
          const end = Math.min(afterLines.length, center + 4);
          return afterLines.slice(start, end).map((l, i) => `${start + i + 1}| ${l}`).join('\n');
        });
        const previewText = previews.length > 0 ? `\n\nContext after edits:\n${previews.join('\n---\n')}` : '';

        return {
          ok: true,
          text: `Applied ${applied.applied.length} hashline edits to ${path.relative(workspaceRoot, filePath) || '.'}${previewText}`,
          meta: {
            path: filePath,
            edits: applied.applied.length,
            version_before: versionBefore,
            version_after: versionAfter,
          },
        };
      }

      case 'read_symbols': {
        const filePath = ensureInsideWorkspace(workspaceRoot, asString(call.args.path, 'path'));
        const content = await fs.readFile(filePath, 'utf8');
        const lines = content.split('\n');
        const symbols = [];
        const patterns = [
          { pat: /^\s*(export\s+)?(default\s+)?(async\s+)?function\s+(\w+)/, kind: 'function' },
          { pat: /^\s*(export\s+)?(default\s+)?class\s+(\w+)/, kind: 'class' },
          { pat: /^\s*(export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\(/, kind: 'function' },
          { pat: /^\s*(export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/, kind: 'function' },
          { pat: /^\s*def\s+(\w+)/, kind: 'function' },
          { pat: /^\s*(async\s+)?fn\s+(\w+)/, kind: 'function' },
          { pat: /^\s*func\s+(\w+)/, kind: 'function' },
          { pat: /^\s*type\s+(\w+)/, kind: 'type' },
          { pat: /^\s*(export\s+)?interface\s+(\w+)/, kind: 'interface' },
        ];
        lines.forEach((line, i) => {
          for (const { pat, kind } of patterns) {
            if (pat.test(line)) {
              symbols.push({ line: i + 1, kind, text: line.trim() });
              break;
            }
          }
        });
        const text = symbols.length > 0
          ? symbols.map(s => `${s.line}| [${s.kind}] ${s.text}`).join('\n')
          : 'No symbols found';
        return {
          ok: true,
          text: truncateText(text),
          meta: { path: filePath, symbolCount: symbols.length },
        };
      }

      case 'git_status': {
        try {
          const { stdout } = await execFileAsync('git', ['status', '--porcelain=v1', '--branch'], { cwd: workspaceRoot });
          const lines = stdout.trim().split('\n');
          const branchLine = lines[0] || '';
          const branchMatch = branchLine.match(/^## (.+?)(?:\.\.\.(.+?))?(?:\s+\[(.+)\])?$/);
          const branch = branchMatch ? branchMatch[1] : 'unknown';
          const tracking = branchMatch ? (branchMatch[2] || null) : null;
          const changes = lines.slice(1).filter(l => l.trim()).map(l => ({
            status: l.slice(0, 2).trim(),
            path: l.slice(3),
          }));
          return {
            ok: true,
            text: stdout.trim() || 'Clean working tree',
            meta: { branch, tracking, changedFiles: changes.length },
          };
        } catch (err) {
          return { ok: false, text: `git status failed: ${err.message}`, structuredError: { code: 'GIT_ERROR', message: err.message, retryable: false } };
        }
      }

      case 'git_diff': {
        const diffPath = call.args.path ? ensureInsideWorkspace(workspaceRoot, asString(call.args.path, 'path')) : null;
        const staged = call.args.staged === true;
        const gitArgs = ['diff'];
        if (staged) gitArgs.push('--staged');
        if (diffPath) gitArgs.push('--', diffPath);
        try {
          const { stdout } = await execFileAsync('git', gitArgs, { cwd: workspaceRoot, maxBuffer: 2_000_000 });
          return {
            ok: true,
            text: truncateText(stdout.trim() || 'No changes'),
            meta: { staged, path: diffPath },
          };
        } catch (err) {
          return { ok: false, text: `git diff failed: ${err.message}`, structuredError: { code: 'GIT_ERROR', message: err.message, retryable: false } };
        }
      }

      case 'git_commit': {
        const message = asString(call.args.message, 'message');
        const paths = Array.isArray(call.args.paths) ? call.args.paths : [];

        // This is a mutating operation — validate paths are inside workspace
        const resolvedPaths = paths.map(p => ensureInsideWorkspace(workspaceRoot, p));

        try {
          // Stage specified files, or all if none specified
          if (resolvedPaths.length > 0) {
            await execFileAsync('git', ['add', '--', ...resolvedPaths], { cwd: workspaceRoot });
          } else {
            // Exclude .push/ (sessions, backups, internal state) from "all" staging
            await execFileAsync('git', ['add', '-A', '--', '.', ':!.push'], { cwd: workspaceRoot });
          }

          const { stdout } = await execFileAsync('git', ['commit', '-m', message], { cwd: workspaceRoot });

          // Get the commit SHA
          const { stdout: sha } = await execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: workspaceRoot });

          return {
            ok: true,
            text: stdout.trim(),
            meta: { sha: sha.trim(), message, filesStaged: resolvedPaths.length || 'all' },
          };
        } catch (err) {
          return { ok: false, text: `git commit failed: ${err.message}`, structuredError: { code: 'GIT_ERROR', message: err.message, retryable: true } };
        }
      }

      case 'save_memory': {
        const content = asString(call.args.content, 'content');
        const memoryDir = path.join(workspaceRoot, '.push');
        const memoryPath = path.join(memoryDir, 'memory.md');
        await fs.mkdir(memoryDir, { recursive: true });
        await fs.writeFile(memoryPath, content, 'utf8');
        return {
          ok: true,
          text: `Memory saved (${content.length} chars). Will be loaded into system prompt on next session.`,
          meta: { path: memoryPath, chars: content.length },
        };
      }

      default:
        return {
          ok: false,
          text: `Unknown tool: ${call.tool}. Available: read_file, list_dir, search_files, exec, write_file, edit_file, read_symbols, git_status, git_diff, git_commit, save_memory`,
          structuredError: {
            code: 'UNKNOWN_TOOL',
            message: `Unknown tool: ${call.tool}`,
            retryable: false,
          },
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      text: `Tool error: ${message}`,
      structuredError: classifyToolError(err),
    };
  }
}
