import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);

export const MAX_TOOL_OUTPUT_CHARS = 24_000;
const DEFAULT_SEARCH_RESULTS = 120;

// Patterns that indicate high-risk shell commands requiring user approval
const HIGH_RISK_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*[rRf]|--recursive|--force)/,   // rm -rf, rm -r, rm -f and variants
  /\brm\s+-[a-zA-Z]*\s/,                              // rm with any flags
  /\bgit\s+reset\s+--hard/,
  /\bgit\s+clean\s+-[a-zA-Z]*[fd]/,                   // git clean -f, -fd, -fdx
  /\bgit\s+push\s+.*--force/,
  /\bgit\s+push\s+-f\b/,
  /\bgit\s+checkout\s+\.\s*$/,                         // git checkout .
  /\bgit\s+restore\s+\.\s*$/,                          // git restore .
  /\bchmod\s+.*[0-7]{3,4}/,                            // chmod with octal perms
  /\bchown\b/,
  /\bmkfs\b/,
  /\bdd\s+/,
  /\b(curl|wget)\s+.*\|\s*(ba)?sh/,                    // pipe-to-shell
  />\s*\/dev\/sd[a-z]/,                                 // write to block devices
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

export const TOOL_PROTOCOL = `TOOL PROTOCOL

When you need a tool, output ONLY a fenced JSON block:
\`\`\`json
{"tool":"tool_name","args":{"key":"value"}}
\`\`\`

Available tools:
- read_file(path, start_line?, end_line?) — read a file from the workspace
- list_dir(path?) — list files/directories
- search_files(pattern, path?, max_results?) — text search in workspace
- exec(command, timeout_ms?) — run a shell command
- write_file(path, content) — write file content

Rules:
- Paths are relative to workspace root unless absolute inside workspace.
- Never attempt paths outside workspace.
- If a tool fails, correct the call and retry when appropriate.
- Do not describe a tool call in prose. Emit only the JSON block.`;

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

export function detectToolCall(text) {
  const fenceRegex = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/g;
  let match;
  while ((match = fenceRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (typeof parsed.tool === 'string' && parsed.args && typeof parsed.args === 'object') {
        return { tool: parsed.tool, args: parsed.args };
      }
    } catch {
      // ignore parse errors in non-JSON fences
    }
  }

  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.tool === 'string' && parsed.args && typeof parsed.args === 'object') {
        return { tool: parsed.tool, args: parsed.args };
      }
    } catch {
      // ignore
    }
  }

  return null;
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
        if (startLine !== undefined || endLine !== undefined) {
          const lines = raw.split(/\r?\n/);
          const start = clamp(startLine ?? 1, 1, lines.length || 1);
          const end = clamp(endLine ?? lines.length, start, lines.length || start);
          const slice = lines.slice(start - 1, end);
          const numbered = slice.map((line, idx) => `${start + idx}: ${line}`).join('\n');
          return {
            ok: true,
            text: truncateText(numbered || '<empty file>'),
            meta: { path: filePath, start_line: start, end_line: end, lines: slice.length },
          };
        }
        return {
          ok: true,
          text: truncateText(raw || '<empty file>'),
          meta: { path: filePath, bytes: raw.length },
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
            };
          }
          const approved = await approvalFn('exec', command);
          if (!approved) {
            return {
              ok: false,
              text: `Denied by user: "${command}" was not approved for execution.`,
            };
          }
        }

        try {
          const { stdout, stderr } = await execFileAsync('/bin/bash', ['-lc', command], {
            cwd: workspaceRoot,
            timeout: timeoutMs,
            maxBuffer: 4_000_000,
          });
          return {
            ok: true,
            text: truncateText(formatExecOutput(stdout, stderr, 0)),
          };
        } catch (err) {
          const exitCode = typeof err.code === 'number' ? err.code : 1;
          return {
            ok: false,
            text: truncateText(formatExecOutput(err.stdout || '', err.stderr || err.message, exitCode, Boolean(err.killed))),
          };
        }
      }
      case 'write_file': {
        const filePath = ensureInsideWorkspace(workspaceRoot, asString(call.args.path, 'path'));
        const content = asString(call.args.content, 'content');
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, 'utf8');
        return {
          ok: true,
          text: `Wrote ${content.length} bytes to ${path.relative(workspaceRoot, filePath) || '.'}`,
          meta: { path: filePath, bytes: content.length },
        };
      }
      default:
        return {
          ok: false,
          text: `Unknown tool: ${call.tool}. Available: read_file, list_dir, search_files, exec, write_file`,
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, text: `Tool error: ${message}` };
  }
}
