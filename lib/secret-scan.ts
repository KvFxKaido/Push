/**
 * lib/secret-scan.ts — the deterministic secret scanner.
 *
 * A pure, model-free detector for high-confidence credential shapes (provider
 * token prefixes, private-key headers, explicit AWS-secret assignments). It is
 * the *mechanical* half of the Auditor unbundle (see
 * `docs/decisions/Main as Scratchpad — Branch on Graduation.md` open-Q #2):
 * secret recall is a matching problem, not a judgment one, so it belongs in
 * deterministic code, not a model that misses and hallucinates. It is also the
 * gate `auto-branch-on-commit`'s auto-push will run before a branch reaches
 * origin.
 *
 * Precision over recall, on purpose. There is no human in the loop at auto-push,
 * so a false positive blocks a push nobody can wave through. Every rule here
 * keys on a structurally distinctive prefix/format (near-zero false positives)
 * rather than entropy heuristics. Broad shapes that leak constantly in docs and
 * tests (a bare `Bearer <jwt>`, generic `password=`) are deliberately omitted —
 * `redactSensitiveText` in `app/src/lib/sensitive-data-guard.ts` still redacts
 * those for *display*, but they are too noisy to *block* on.
 */

import { parseBooleanSetting } from './auditor-policy.js';

/** Env var that toggles the deterministic secret scan across surfaces. */
export const SECRET_SCAN_ENV_VAR = 'PUSH_SECRET_SCAN';

/**
 * Default state when nothing opts in: ON. The scan is a safety gate (like the
 * Auditor commit gate), so it is opt-out, disabled deliberately via the shared
 * env var / a per-surface setting.
 */
export const SECRET_SCAN_DEFAULT = true;

/**
 * Resolve whether the secret scan is enabled. Pure — callers pass the raw env
 * value and an optional explicit per-surface setting; precedence + default live
 * here so every surface agrees (mirrors `resolveAuditorGateEnabled`).
 */
export function resolveSecretScanEnabled(
  opts: { explicit?: unknown; env?: unknown } = {},
): boolean {
  const fromEnv = parseBooleanSetting(opts.env);
  if (fromEnv !== undefined) return fromEnv;
  const fromExplicit = parseBooleanSetting(opts.explicit);
  if (fromExplicit !== undefined) return fromExplicit;
  return SECRET_SCAN_DEFAULT;
}

export interface SecretRule {
  /** Stable identifier for logs/telemetry. */
  id: string;
  /** Human-readable label surfaced in the block reason. */
  label: string;
  /** Global (`g`) regex — `scanText` relies on `matchAll`. */
  pattern: RegExp;
}

/**
 * High-confidence credential shapes. Each keys on a distinctive prefix/format
 * so a match is almost certainly a real secret. Order is cosmetic (findings are
 * grouped by label in the reason).
 */
export const SECRET_RULES: readonly SecretRule[] = [
  {
    id: 'private-key',
    label: 'Private key',
    pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/g,
  },
  {
    id: 'github-token',
    label: 'GitHub token',
    pattern: /\b(?:github_pat_[A-Za-z0-9_]{22,}|gh[pousr]_[A-Za-z0-9]{36,})\b/g,
  },
  {
    id: 'openai-key',
    label: 'OpenAI-style API key',
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: 'google-api-key',
    label: 'Google API key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: 'aws-access-key-id',
    label: 'AWS access key ID',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    id: 'aws-secret-access-key',
    label: 'AWS secret access key',
    // Requires the explicit key name, so the 40-char base64 tail is almost
    // certainly a real secret rather than an incidental string.
    pattern:
      /\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\b\s*[:=]\s*["']?[A-Za-z0-9/+]{40}["']?/g,
  },
  {
    id: 'slack-token',
    label: 'Slack token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: 'stripe-secret-key',
    label: 'Stripe secret key',
    // `_live_` only — test keys (`_test_`) are not a leak worth blocking.
    pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g,
  },
  {
    id: 'gcp-service-account',
    label: 'GCP service-account key',
    pattern: /"type"\s*:\s*"service_account"/g,
  },
];

export interface SecretFinding {
  /** Which rule fired. */
  ruleId: string;
  /** Human-readable rule label. */
  label: string;
  /** A masked fingerprint of the match — NEVER the raw secret. */
  masked: string;
  /** 1-based line number in the new file (diff scans only). */
  line?: number;
  /** File path from the diff hunk header (diff scans only). */
  file?: string;
}

/**
 * Mask a matched secret to a short fingerprint that identifies the rule without
 * letting a reader reconstruct the value. Short matches collapse to `****`.
 */
export function maskSecret(match: string): string {
  const compact = match.replace(/\s+/g, ' ').trim();
  if (compact.length <= 8) return '****';
  return `${compact.slice(0, 4)}…${compact.slice(-2)}`;
}

/** Scan free text for every rule. No file/line context (use `scanDiffForSecrets` for that). */
export function scanTextForSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const rule of SECRET_RULES) {
    // `matchAll` ignores `lastIndex`, but resetting keeps the shared RegExp
    // objects defensively stateless across calls.
    rule.pattern.lastIndex = 0;
    for (const m of text.matchAll(rule.pattern)) {
      findings.push({ ruleId: rule.id, label: rule.label, masked: maskSecret(m[0]) });
    }
  }
  return findings;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Scan a unified diff, flagging secrets only on **added** lines (`+`, excluding
 * the `+++` file header) — context and removed lines are existing/gone content,
 * not what this change introduces. Tracks the current file (`+++ b/<path>`) and
 * the new-file line number (from `@@` hunk headers) so findings point at a
 * location.
 */
export function scanDiffForSecrets(diff: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let currentFile: string | undefined;
  let newLineNo = 0;

  for (const rawLine of diff.split('\n')) {
    // File headers carry a trailing space (`+++ b/path`); require it so an
    // added source line like `+++x` (content `++x`) isn't misread as a header.
    if (rawLine.startsWith('+++ ')) {
      const target = rawLine.slice(4).trim();
      currentFile = target === '/dev/null' ? undefined : target.replace(/^b\//, '');
      continue;
    }
    if (rawLine.startsWith('--- ')) continue; // old-file header — not an added line
    const hunk = HUNK_HEADER.exec(rawLine);
    if (hunk) {
      newLineNo = Number.parseInt(hunk[1], 10);
      continue;
    }
    if (rawLine.startsWith('+')) {
      const content = rawLine.slice(1);
      for (const finding of scanTextForSecrets(content)) {
        findings.push({ ...finding, file: currentFile, line: newLineNo });
      }
      newLineNo += 1;
    } else if (rawLine.startsWith('-')) {
      // Removed line — present in the old file only, does not advance new count.
    } else if (rawLine.startsWith(' ') || rawLine === '') {
      // Context line (leading space) or a blank line — advances the new count.
      // Other metadata (e.g. `\ No newline at end of file`) is neither added
      // nor a real new-file line, so it must NOT advance the counter.
      newLineNo += 1;
    }
  }
  return findings;
}

/**
 * A user-facing block reason. Names the distinct rule labels and a few
 * file:line locations; never includes the raw secret. The message is
 * surface-neutral (the opt-out env var differs per surface and isn't readable
 * on the web client, so it's documented in code, not advertised here).
 */
export function formatSecretFindings(findings: SecretFinding[]): string {
  const labels = [...new Set(findings.map((f) => f.label))];
  const locations = findings
    .filter((f) => f.file)
    .slice(0, 5)
    .map((f) => (f.line ? `${f.file}:${f.line}` : f.file));
  const count = findings.length;
  const noun = count === 1 ? 'potential secret' : 'potential secrets';
  const where = locations.length ? ` (${locations.join(', ')})` : '';
  return (
    `Blocked: ${count} ${noun} detected in the commits being pushed — ` +
    `${labels.join(', ')}${where}. Remove the credential(s) from the commit ` +
    `history (or move them to a secret store), then push again.`
  );
}
