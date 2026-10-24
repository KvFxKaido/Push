/**
 * Redact values from the workspace's credential files out of tool output.
 *
 * The file tools refuse sensitive paths (`ensureFileToolPath` in tools.ts),
 * but `exec` can read them anyway (`cat .env`, a script, `cat .e""nv`): a
 * shell command isn't a path, and no command-text check survives a
 * determined model. So the values themselves are scrubbed from whatever a
 * tool returns, however they were fetched.
 *
 * What counts as a value:
 *   - `.env`-style files: each `KEY=value` value of 8+ characters (shorter
 *     ones such as `3000` or `true` aren't secret-shaped, and redacting them
 *     would mangle ordinary output).
 *   - other credential files (keys, `.netrc`, `.npmrc`, …): each line of 16+
 *     characters.
 *
 * Limits: a value split across two streamed `exec_poll` chunks isn't caught,
 * and nothing stops a command from sending a value somewhere else; this only
 * keeps it out of what the model reads.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isSensitivePath } from '../lib/sensitive-paths.ts';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
]);
const MAX_DEPTH = 4;
const MAX_ENTRIES = 5_000;
const MAX_FILE_BYTES = 64 * 1024;
const MIN_ENV_VALUE = 8;
const MIN_KEY_LINE = 16;

export interface SensitiveValue {
  value: string;
  /** Workspace-relative file it came from, shown in the redaction marker. */
  file: string;
}

function isEnvFile(rel: string): boolean {
  return /^\.env(?:\..+)?$/i.test(path.basename(rel));
}

export function extractSensitiveValues(rel: string, content: string): string[] {
  const values: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (isEnvFile(rel)) {
      const m = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let value = m[1].trim();
      const quoted = /^(['"`])(.*)\1$/.exec(value);
      if (quoted) value = quoted[2];
      else value = value.replace(/\s+#.*$/, '');
      if (value.length >= MIN_ENV_VALUE) values.push(value);
    } else if (line.length >= MIN_KEY_LINE) {
      values.push(line);
    }
  }
  return values;
}

/** Find credential files under the workspace (bounded walk) and collect their values. */
export async function collectSensitiveValues(workspaceRoot: string): Promise<SensitiveValue[]> {
  const found: SensitiveValue[] = [];
  let seen = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (++seen > MAX_ENTRIES) return;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name)) await walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(workspaceRoot, abs).split(path.sep).join('/');
      if (!isSensitivePath(rel)) continue;
      try {
        const stat = await fs.stat(abs);
        if (stat.size > MAX_FILE_BYTES) continue;
        const content = await fs.readFile(abs, 'utf8');
        for (const value of extractSensitiveValues(rel, content)) found.push({ value, file: rel });
      } catch {
        // Unreadable: nothing of it can reach the model through us either.
      }
    }
  };
  await walk(workspaceRoot, 0);
  // Longest first, so a value containing another is replaced whole.
  return found.sort((a, b) => b.value.length - a.value.length);
}

/** Replace every occurrence of every value in `text`. */
export function redactText(
  text: string,
  values: SensitiveValue[],
): { text: string; count: number; files: string[] } {
  let out = text;
  let count = 0;
  const files = new Set<string>();
  for (const { value, file } of values) {
    if (!out.includes(value)) continue;
    const parts = out.split(value);
    count += parts.length - 1;
    files.add(file);
    out = parts.join(`[redacted: ${file}]`);
  }
  return { text: out, count, files: [...files] };
}

/** Deep-redact every string in a tool result (text, meta, card). */
export function redactDeep<T>(
  input: T,
  values: SensitiveValue[],
): { value: T; count: number; files: Set<string> } {
  let count = 0;
  const files = new Set<string>();
  const visit = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const r = redactText(node, values);
      count += r.count;
      for (const f of r.files) files.add(f);
      return r.text;
    }
    if (Array.isArray(node)) return node.map(visit);
    if (node && typeof node === 'object') {
      const copy: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node)) copy[k] = visit(v);
      return copy;
    }
    return node;
  };
  return { value: visit(input) as T, count, files };
}
