import fs from 'node:fs';
import path from 'node:path';

const MAX_PATH_COMPLETIONS = 64;

function isWhitespace(ch) {
  return Boolean(ch) && /\s/.test(ch);
}

function isReferenceBoundary(ch) {
  if (!ch) return true;
  return /\s|[([{\<>"'`,;]/.test(ch);
}

function isInsideRoot(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function toPosix(relPath) {
  return relPath.split(path.sep).join('/');
}

/**
 * Find a trailing @reference token candidate at the end of a line.
 * Returns null if there is no completable @token.
 *
 * Examples:
 * - "review @src/ap" -> { start, end, fragment: "src/ap", token: "@src/ap" }
 * - "foo@bar.com" -> null
 * - "@@" -> null
 */
export function extractAtReferenceCompletionTarget(text) {
  const source = String(text || '');
  if (!source) return null;

  let tokenStart = source.length;
  while (tokenStart > 0 && !isWhitespace(source[tokenStart - 1])) tokenStart -= 1;
  const chunk = source.slice(tokenStart);
  if (!chunk) return null;

  const atOffset = chunk.lastIndexOf('@');
  if (atOffset < 0) return null;

  const absAt = tokenStart + atOffset;
  if (source[absAt + 1] === '@') return null; // escaped "@@"
  if (!isReferenceBoundary(source[absAt - 1])) return null; // email/usernames

  const fragment = source.slice(absAt + 1);
  if (fragment.includes('@')) return null;
  if (fragment.includes(':')) return null; // line-range syntax isn't path-completed (yet)

  return {
    start: absAt,
    end: source.length,
    token: source.slice(absAt),
    fragment,
  };
}

/**
 * Sync path suggestions for @file references (used by REPL/TUI tab completion).
 * Returns workspace-relative paths with "/" suffix for directories.
 */
export function listReferencePathCompletionsSync(workspaceRoot, fragment, { maxResults = MAX_PATH_COMPLETIONS } = {}) {
  const root = path.resolve(workspaceRoot || process.cwd());
  const raw = String(fragment || '');
  const normalized = raw.replace(/\\/g, '/');

  const lastSlash = normalized.lastIndexOf('/');
  const dirPrefix = lastSlash >= 0 ? normalized.slice(0, lastSlash + 1) : '';
  const basePrefix = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;
  const dirRel = dirPrefix.endsWith('/') ? dirPrefix.slice(0, -1) : dirPrefix;

  if (normalized.startsWith('/') || normalized.includes('\0')) return [];
  if (dirRel.split('/').some((segment) => segment === '..')) return [];

  const dirAbs = path.resolve(root, dirRel || '.');
  if (!isInsideRoot(root, dirAbs)) return [];

  let entries;
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return [];
  }

  const matches = [];
  for (const entry of entries) {
    const name = entry.name;
    if (!name.startsWith(basePrefix)) continue;
    // Current @reference parser does not support spaces; avoid suggesting unusable paths.
    if (/\s/.test(name)) continue;
    const rel = `${dirPrefix}${name}${entry.isDirectory() ? '/' : ''}`;
    matches.push({
      value: rel,
      isDir: entry.isDirectory(),
    });
  }

  matches.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.value.localeCompare(b.value);
  });

  return matches.slice(0, maxResults).map((m) => toPosix(m.value));
}

