import type { NativeFsDiffResult } from './native-fs';
import { isSensitivePath, redactSensitiveText } from './sensitive-data-guard';

/**
 * Undo git's C-style path quoting (`"a/pa th"`, `"a/caf\303\251"`). Returns the
 * raw string unchanged when unquoted, or `null` when the quoting is malformed —
 * callers treat `null` as "path unknown" and fail closed.
 */
function unquoteGitPath(raw: string): string | null {
  if (!raw.startsWith('"')) return raw;
  if (raw.length < 2 || !raw.endsWith('"')) return null;
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch !== '\\') {
      for (const b of new TextEncoder().encode(ch)) bytes.push(b);
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) return null;
    i += 1;
    if (next === 'n') bytes.push(0x0a);
    else if (next === 't') bytes.push(0x09);
    else if (next === 'r') bytes.push(0x0d);
    else if (next >= '0' && next <= '7') {
      const octal = body.slice(i, i + 3);
      if (!/^[0-7]{3}$/.test(octal)) return null;
      bytes.push(Number.parseInt(octal, 8));
      i += 2;
    } else bytes.push(next.charCodeAt(0));
  }
  // Octal escapes encode UTF-8 bytes, so decode the whole run at once.
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/**
 * Both paths a `diff --git` header names, or `null` when it cannot be read.
 *
 * Reading **both** operands is the point: a rename-with-edit from a safe source
 * into a sensitive destination (`diff --git a/safe b/.env`) is sensitive on the
 * `b/` side only, and inspecting `a/` alone would keep the block and print the
 * new contents. Quoted headers must be parsed too — a `\S+` match silently
 * fails on `"a/pa th"`, which reads as "no sensitive path found".
 */
function diffHeaderPaths(block: string): [string, string] | null {
  const newline = block.indexOf('\n');
  const line = newline === -1 ? block : block.slice(0, newline);
  const prefix = 'diff --git ';
  if (!line.startsWith(prefix)) return null;
  const rest = line.slice(prefix.length);

  let aRaw: string;
  let bRaw: string;
  if (rest.startsWith('"')) {
    let i = 1;
    while (i < rest.length && rest[i] !== '"') i += rest[i] === '\\' ? 2 : 1;
    if (i >= rest.length) return null;
    aRaw = rest.slice(0, i + 1);
    const remainder = rest.slice(i + 1);
    if (!remainder.startsWith(' ')) return null;
    bRaw = remainder.slice(1);
  } else {
    // Unquoted paths may still contain spaces (core.quotePath=false), so split
    // on the last ` b/` / ` "b/` rather than the first space.
    const at = Math.max(rest.lastIndexOf(' b/'), rest.lastIndexOf(' "b/'));
    if (at < 0) return null;
    aRaw = rest.slice(0, at);
    bRaw = rest.slice(at + 1);
  }

  const a = unquoteGitPath(aRaw);
  const b = unquoteGitPath(bRaw);
  if (a === null || b === null) return null;
  if (!a.startsWith('a/') || !b.startsWith('b/')) return null;
  return [a.slice(2), b.slice(2)];
}

/** True when a porcelain status line or diff header names a sensitive path. */
function namesSensitivePath(paths: readonly string[]): boolean {
  return paths.some((p) => isSensitivePath(p));
}

/**
 * The native working-copy diff includes untracked files as additions so commit
 * preview/stats see the same files JGit will stage. It can carry contents no
 * other native read path would return raw, so apply the same defenses as
 * read/search: drop whole blocks for sensitive paths, value-redact the rest.
 */
export function sanitizeNativeDiff(result: NativeFsDiffResult): NativeFsDiffResult {
  // Porcelain status names files too (`?? .env`) — filter it with the same
  // rule as the diff body so a consumer that prints git_status (the diff
  // handler's empty-diff branch does, and the commit handler's status lines
  // would) can't leak what the diff hides. Filtered even when the diff body
  // is empty — that IS the branch that prints status.
  const gitStatus = result.git_status
    ?.split('\n')
    .filter((line) => {
      if (!line || line.startsWith('##')) return true;
      // XY <path> (renames: `XY old -> new`) — drop the line if any named
      // path is sensitive. Porcelain quotes paths with special characters the
      // same way the diff header does, so unquote before matching; an
      // unreadable path fails closed rather than passing the filter.
      const paths = line
        .slice(3)
        .split(' -> ')
        .map((p) => p.trim())
        .filter(Boolean)
        .map(unquoteGitPath);
      if (paths.some((p) => p === null)) return false;
      return !namesSensitivePath(paths as string[]);
    })
    .join('\n');
  const withStatus = (value: NativeFsDiffResult): NativeFsDiffResult => ({
    ...value,
    ...(result.git_status !== undefined ? { git_status: gitStatus } : {}),
  });
  if (!result.diff) return withStatus(result);
  let hidden = 0;
  const kept = result.diff.split(/^(?=diff --git )/m).filter((block) => {
    // Only `diff --git` blocks name files; a leading preamble chunk is not a
    // file block and is left alone.
    if (!block.startsWith('diff --git ')) return true;
    const paths = diffHeaderPaths(block);
    // Fail closed: an unparseable header is a path we cannot vet, and the old
    // `\S+` match treated exactly that case as "nothing sensitive here".
    if (!paths || namesSensitivePath(paths)) {
      hidden += 1;
      return false;
    }
    return true;
  });
  const redaction = redactSensitiveText(kept.join(''));
  const notes = [
    ...(hidden > 0 ? [`[${hidden} sensitive file diff${hidden === 1 ? '' : 's'} hidden]`] : []),
    ...(redaction.redacted ? ['[secret-like values redacted]'] : []),
  ];
  const diff = [redaction.text.trimEnd(), ...notes].filter(Boolean).join('\n');
  return withStatus({ ...result, diff });
}
