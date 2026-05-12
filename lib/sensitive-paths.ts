/**
 * sensitive-paths.ts — Shared path-shape rules for credential-looking
 * files that the runtime should refuse to read/write/list regardless
 * of which surface (web dispatcher, `pushd` daemon, MCP server) is
 * asked.
 *
 * Historically each surface carried its own copy of these constants —
 * `app/src/lib/sensitive-data-guard.ts` and `cli/pushd.ts` had
 * identical hand-maintained sets, kept in sync via review. Copilot
 * flagged the drift risk on PR #516; the right answer is one source.
 *
 * Web-layer concerns that USE these primitives — secret redaction in
 * file content, envelope-boundary escaping, formatted tool-error
 * messages — stay in `app/src/lib/sensitive-data-guard.ts` because
 * they depend on web-only helpers. This module owns only the path
 * predicate and the data behind it.
 */

export const SENSITIVE_FILE_EXTENSIONS: readonly string[] = ['.pem', '.key', '.p12', '.pfx'];

export const SENSITIVE_FILE_BASENAMES: ReadonlySet<string> = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
]);

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/').trim();
}

function basename(p: string): string {
  const normalized = normalizePath(p);
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function isEnvironmentTemplate(name: string): boolean {
  return /\.(example|sample|template|schema)(?:\.|$)/i.test(name);
}

/**
 * Returns true when `path` looks like a credential / secret file the
 * runtime should refuse to read, write, or list:
 *
 *   - `.env` or `.env.<anything>` (but NOT `.env.example` / `.env.sample`
 *     / `.env.template` / `.env.schema`)
 *   - well-known credential basenames (`id_rsa`, `.netrc`, …)
 *   - well-known credential extensions (`.pem`, `.key`, …)
 *   - anything under `~/.ssh/`
 *   - `.aws/credentials`
 *   - `.docker/config.json`
 *
 * Returns `false` for empty / non-string inputs (caller decides what
 * to do with that). The check is path-shape only — it does NOT touch
 * the filesystem.
 */
export function isSensitivePath(p: string): boolean {
  if (typeof p !== 'string' || p === '') return false;
  const normalized = normalizePath(p);
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  const base = basename(normalized).toLowerCase();

  if (/^\.env(?:\..+)?$/i.test(base) && !isEnvironmentTemplate(base)) {
    return true;
  }
  if (SENSITIVE_FILE_BASENAMES.has(base)) {
    return true;
  }
  if (SENSITIVE_FILE_EXTENSIONS.some((ext) => base.endsWith(ext))) {
    return true;
  }
  if (lower.includes('/.ssh/') || lower.endsWith('/.ssh')) {
    return true;
  }
  if (lower.includes('/.aws/credentials') || lower.endsWith('/.aws/credentials')) {
    return true;
  }
  if (lower.includes('/.docker/config.json') || lower.endsWith('/.docker/config.json')) {
    return true;
  }
  return false;
}
