const SENSITIVE_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx'];
const SENSITIVE_BASENAMES = new Set([
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'id_dsa',
]);

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').trim();
}

function basename(path: string): string {
  const normalized = normalizePath(path);
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function isEnvironmentTemplate(name: string): boolean {
  return /\.(example|sample|template|schema)(?:\.|$)/i.test(name);
}

export function isSensitivePath(path: string): boolean {
  const normalized = normalizePath(path);
  if (!normalized) return false;

  const lower = normalized.toLowerCase();
  const base = basename(normalized).toLowerCase();

  if (/^\.env(?:\..+)?$/i.test(base) && !isEnvironmentTemplate(base)) {
    return true;
  }

  if (SENSITIVE_BASENAMES.has(base)) {
    return true;
  }

  if (SENSITIVE_EXTENSIONS.some((ext) => base.endsWith(ext))) {
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
