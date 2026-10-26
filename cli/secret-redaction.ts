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
 *     characters, plus credential fields of 8+ (`key = value`, the word after
 *     `password` / `login` / `account`, a URL's userinfo password).
 * Symlinked credential files are followed; the caller snapshots before and
 * after each tool call so a read-then-overwrite still matches.
 *
 * Exec sessions stream their output in chunks that `exec_poll` / `exec_wait`
 * return in pieces, so per-result redaction can't see a value split across two
 * responses. `createStreamRedactor` redacts each session's stream as it is
 * stored instead, holding back any tail that could still be the start of a
 * value.
 *
 * Best effort, not a boundary. Misses: shorter values, files past the bounded
 * walk, a value created after an exec session started (per-result redaction
 * still catches it whole), and a value transformed before it's printed. Nothing here stops a command from sending a value elsewhere; it
 * only keeps values out of what the model reads.
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
    } else {
      // Whole lines catch key material (PEM bodies); the fields below catch
      // a command that prints only the credential out of a config line.
      if (line.length >= MIN_KEY_LINE) values.push(line);
      for (const field of credentialFields(line)) {
        if (field.length >= MIN_ENV_VALUE) values.push(field);
      }
    }
  }
  return values;
}

/**
 * Credential-bearing fields in non-.env credential files: `key = value`
 * (`.npmrc`, `.pypirc`), the words after `password` / `login` / `account`
 * (`.netrc`), and a URL's userinfo password (`.git-credentials`).
 */
function credentialFields(line: string): string[] {
  const fields: string[] = [];
  const assignment = /^[^=\s][^=]*?\s*=\s*(.+)$/.exec(line);
  if (assignment) {
    const value = assignment[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    fields.push(value);
  }
  const words = line.split(/\s+/);
  for (let i = 0; i < words.length - 1; i++) {
    if (/^(password|login|account)$/i.test(words[i])) fields.push(words[i + 1]);
  }
  for (const m of line.matchAll(/\/\/[^:/@\s]+:([^@\s]+)@/g)) fields.push(m[1]);
  return fields;
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
      // A symlinked credential file (`.env -> ../shared/config`) counts: a
      // shell command follows the link. Symlinked directories aren't walked.
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      const rel = path.relative(workspaceRoot, abs).split(path.sep).join('/');
      if (!isSensitivePath(rel)) continue;
      try {
        const stat = await fs.stat(abs); // follows the link to its target
        if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
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

/** Union of two snapshots, deduped by value, longest first. */
export function mergeSensitiveValues(a: SensitiveValue[], b: SensitiveValue[]): SensitiveValue[] {
  const byValue = new Map<string, SensitiveValue>();
  for (const v of [...a, ...b]) if (!byValue.has(v.value)) byValue.set(v.value, v);
  return [...byValue.values()].sort((x, y) => y.value.length - x.value.length);
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

/** Held fragments this long or longer are redacted at flush; shorter ones are
 *  emitted (a 2-character tail is as likely to be ordinary text). */
const MIN_PARTIAL_REDACT = 8;

export interface StreamRedactor {
  /** Redact a chunk; returns the text safe to store now (may be empty). */
  push(text: string): string;
  /** End of stream: release (or redact) whatever is still held back. */
  flush(): string;
  /** Values redacted so far, and the files they came from. */
  readonly count: number;
  readonly files: ReadonlySet<string>;
}

/**
 * Redact a stream that arrives in chunks — an exec session's stdout or stderr.
 * A value split across chunks matches no single chunk, so the trailing text
 * that could still be the start of a value is held back until the next chunk
 * completes or rules it out, or until `flush` at exit. Everything stored is
 * then already redacted, so any `exec_poll` / `exec_wait` window reads safe
 * output whatever its `from_seq`.
 */
export function createStreamRedactor(values: SensitiveValue[]): StreamRedactor {
  let carry = '';
  let count = 0;
  const files = new Set<string>();
  const maxHold = values.reduce((n, v) => Math.max(n, v.value.length - 1), 0);
  // Longest tail of `text` that is a proper prefix of some value.
  const heldLength = (text: string): number => {
    for (let len = Math.min(maxHold, text.length); len > 0; len--) {
      const tail = text.slice(text.length - len);
      if (values.some((v) => v.value.length > len && v.value.startsWith(tail))) return len;
    }
    return 0;
  };
  return {
    push(text) {
      if (values.length === 0) return text;
      const r = redactText(carry + text, values);
      count += r.count;
      for (const f of r.files) files.add(f);
      const hold = heldLength(r.text);
      carry = hold > 0 ? r.text.slice(r.text.length - hold) : '';
      return hold > 0 ? r.text.slice(0, r.text.length - hold) : r.text;
    },
    flush() {
      const held = carry;
      carry = '';
      if (held.length < MIN_PARTIAL_REDACT) return held;
      const source = values.find((v) => v.value.startsWith(held));
      count += 1;
      if (source) files.add(source.file);
      return `[redacted partial: ${source?.file ?? 'credential file'}]`;
    },
    get count() {
      return count;
    },
    get files() {
      return files;
    },
  };
}
