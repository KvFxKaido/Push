// The path predicate and its data tables now live in `@push/lib` so
// the `pushd` daemon can share them (Copilot drift concern on PR #516).
// Re-export keeps the existing app-layer import path stable.
import { isSensitivePath } from '@push/lib/sensitive-paths';
export { isSensitivePath };

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').trim();
}

export function filterSensitiveDirectoryEntries<T extends { name: string; path?: string }>(
  directoryPath: string,
  entries: T[],
): { entries: T[]; hiddenCount: number } {
  const visibleEntries: T[] = [];
  let hiddenCount = 0;

  for (const entry of entries) {
    const entryPath =
      entry.path ?? `${normalizePath(directoryPath).replace(/\/$/, '')}/${entry.name}`;
    if (isSensitivePath(entryPath)) {
      hiddenCount += 1;
      continue;
    }
    visibleEntries.push(entry);
  }

  return { entries: visibleEntries, hiddenCount };
}

function replaceAll(
  input: string,
  pattern: RegExp,
  replacement: string | ((substring: string, ...args: string[]) => string),
): { text: string; changed: boolean } {
  let changed = false;
  const text = input.replace(pattern, (...args) => {
    changed = true;
    if (typeof replacement === 'function') {
      return replacement(args[0], ...(args.slice(1, -2) as string[]));
    }
    return replacement;
  });
  return { text, changed };
}

export function redactSensitiveText(text: string): { text: string; redacted: boolean } {
  let next = text;
  let redacted = false;

  const apply = (
    pattern: RegExp,
    replacement: string | ((substring: string, ...args: string[]) => string),
  ): void => {
    const result = replaceAll(next, pattern, replacement);
    next = result.text;
    redacted ||= result.changed;
  };

  apply(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    '[REDACTED PRIVATE KEY]',
  );
  apply(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[REDACTED GITHUB TOKEN]');
  apply(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED API KEY]');
  apply(/\bAIza[0-9A-Za-z\-_]{20,}\b/g, '[REDACTED GOOGLE API KEY]');
  apply(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED AWS ACCESS KEY]');
  apply(
    /\b(Bearer)\s+[A-Za-z0-9._~+/-]{20,}\b/gi,
    (_substring, scheme) => `${scheme} [REDACTED TOKEN]`,
  );
  apply(
    /((?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[:=]\s*)([A-Za-z0-9/+=]{20,})/g,
    (_substring, prefix) => `${prefix}[REDACTED]`,
  );

  return { text: next, redacted };
}

export function formatSensitivePathToolError(path: string): string {
  return `[Tool Error] Access denied — "${path}" looks like a secret or credential file. Ask the user directly for the value or use a safer source.`;
}
