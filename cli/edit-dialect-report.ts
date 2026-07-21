/**
 * Before/after report for the search/replace edit dialect rollout.
 *
 * Cohorts are selected from the persisted system prompt, not timestamps: a
 * session is "after" only when its tool protocol advertises old_string and
 * new_string. That keeps resumed sessions and machines updated at different
 * times out of the wrong cohort.
 */

import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const EDIT_DIALECT_PROTOCOL_MARKER = 'old_string?, new_string?';
export const DEFAULT_MINIMUM_AFTER_EDIT_CALLS = 35;

export interface EditDialectCohort {
  sessions: number;
  editCalls: number;
  errors: number;
  invalidRefErrors: number;
  errorRate: number | null;
}

export interface EditDialectReport {
  generatedAt: string;
  sessionRoot: string;
  modelPattern: string;
  minimumAfterEditCalls: number;
  scannedSessions: number;
  matchingSessions: number;
  before: EditDialectCohort;
  after: EditDialectCohort;
  verdict:
    | { status: 'pending'; remainingEditCalls: number }
    | { status: 'ready'; errorRateDelta: number; relativeErrorReduction: number | null };
}

interface PersistedMessage {
  role?: unknown;
  content?: unknown;
}

interface PersistedToolResult {
  tool?: unknown;
  ok?: unknown;
  output?: unknown;
  structuredError?: { message?: unknown } | null;
}

function emptyCohort(): EditDialectCohort {
  return { sessions: 0, editCalls: 0, errors: 0, invalidRefErrors: 0, errorRate: null };
}

function finalizeCohort(cohort: EditDialectCohort): EditDialectCohort {
  return {
    ...cohort,
    errorRate: cohort.editCalls > 0 ? cohort.errors / cohort.editCalls : null,
  };
}

/** Read the first balanced JSON object from a tool-result envelope. */
export function extractFirstJsonObject(value: string): unknown | null {
  const start = value.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(value.slice(start, index + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function parseMessages(raw: string): PersistedMessage[] {
  const messages: PersistedMessage[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as PersistedMessage;
      if (parsed && typeof parsed === 'object') messages.push(parsed);
    } catch {
      // Append-only logs can end with a torn line after an interrupted write.
    }
  }
  return messages;
}

function recordSession(messages: readonly PersistedMessage[], cohort: EditDialectCohort): void {
  cohort.sessions += 1;
  for (const message of messages) {
    if (message.role !== 'user' || typeof message.content !== 'string') continue;
    if (!message.content.includes('[TOOL_RESULT]')) continue;
    const result = extractFirstJsonObject(message.content) as PersistedToolResult | null;
    if (!result || result.tool !== 'edit_file') continue;
    cohort.editCalls += 1;
    if (result.ok !== false) continue;
    cohort.errors += 1;
    const detail = [result.output, result.structuredError?.message]
      .filter((part): part is string => typeof part === 'string')
      .join('\n');
    if (/invalid ref/i.test(detail)) cohort.invalidRefErrors += 1;
  }
}

export async function buildEditDialectReport(
  options: {
    sessionRoot?: string;
    modelPattern?: RegExp;
    minimumAfterEditCalls?: number;
    generatedAt?: string;
  } = {},
): Promise<EditDialectReport> {
  const sessionRoot = path.resolve(
    options.sessionRoot ??
      process.env.PUSH_SESSION_DIR ??
      path.join(os.homedir(), '.push', 'sessions'),
  );
  const modelPattern = options.modelPattern ?? /glm-5\.1/i;
  const minimumAfterEditCalls = Math.max(
    1,
    Math.trunc(options.minimumAfterEditCalls ?? DEFAULT_MINIMUM_AFTER_EDIT_CALLS),
  );
  const before = emptyCohort();
  const after = emptyCohort();
  let scannedSessions = 0;
  let matchingSessions = 0;

  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(sessionRoot, { withFileTypes: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read session root ${sessionRoot}: ${message}`);
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    scannedSessions += 1;
    const sessionDir = path.join(sessionRoot, entry.name);
    try {
      const [stateRaw, messagesRaw] = await Promise.all([
        fs.readFile(path.join(sessionDir, 'state.json'), 'utf8'),
        fs.readFile(path.join(sessionDir, 'messages.jsonl'), 'utf8'),
      ]);
      const state = JSON.parse(stateRaw) as { model?: unknown };
      const model = typeof state.model === 'string' ? state.model : '';
      modelPattern.lastIndex = 0;
      if (!modelPattern.test(model)) continue;
      matchingSessions += 1;
      const messages = parseMessages(messagesRaw);
      const systemPrompt = messages.find(
        (message) => message.role === 'system' && typeof message.content === 'string',
      )?.content;
      const hasDialect =
        typeof systemPrompt === 'string' && systemPrompt.includes(EDIT_DIALECT_PROTOCOL_MARKER);
      recordSession(messages, hasDialect ? after : before);
    } catch {
      // Session scans are best-effort; incomplete/legacy entries do not poison
      // the aggregate, matching listSessions' corruption tolerance.
    }
  }

  const finalizedBefore = finalizeCohort(before);
  const finalizedAfter = finalizeCohort(after);
  const remainingEditCalls = Math.max(0, minimumAfterEditCalls - finalizedAfter.editCalls);
  const verdict: EditDialectReport['verdict'] =
    remainingEditCalls > 0
      ? { status: 'pending', remainingEditCalls }
      : {
          status: 'ready',
          errorRateDelta: (finalizedAfter.errorRate ?? 0) - (finalizedBefore.errorRate ?? 0),
          relativeErrorReduction:
            finalizedBefore.errorRate && finalizedAfter.errorRate !== null
              ? (finalizedBefore.errorRate - finalizedAfter.errorRate) / finalizedBefore.errorRate
              : null,
        };

  return {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    sessionRoot,
    modelPattern: modelPattern.source,
    minimumAfterEditCalls,
    scannedSessions,
    matchingSessions,
    before: finalizedBefore,
    after: finalizedAfter,
    verdict,
  };
}

function formatRate(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

export function formatEditDialectReport(report: EditDialectReport): string {
  const lines = [
    `GLM-5.1 edit dialect report`,
    `Sessions: ${report.matchingSessions} matching / ${report.scannedSessions} scanned`,
    `Before: ${report.before.errors}/${report.before.editCalls} edit errors (${formatRate(report.before.errorRate)}); ${report.before.invalidRefErrors} invalid-ref`,
    `After: ${report.after.errors}/${report.after.editCalls} edit errors (${formatRate(report.after.errorRate)}); ${report.after.invalidRefErrors} invalid-ref`,
  ];
  if (report.verdict.status === 'pending') {
    lines.push(
      `Verdict: pending — ${report.verdict.remainingEditCalls} more post-dialect edit call(s) needed (minimum ${report.minimumAfterEditCalls}).`,
    );
  } else {
    lines.push(
      `Verdict: ready — absolute error-rate delta ${(report.verdict.errorRateDelta * 100).toFixed(1)} percentage points.`,
    );
  }
  return lines.join('\n');
}

function parseCliArgs(argv: readonly string[]): {
  sessionRoot?: string;
  minimumAfterEditCalls?: number;
  json: boolean;
} {
  const result: { sessionRoot?: string; minimumAfterEditCalls?: number; json: boolean } = {
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') result.json = true;
    else if (arg === '--session-dir') result.sessionRoot = argv[++index];
    else if (arg === '--min-after-calls') {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value) || value < 1) {
        throw new Error('--min-after-calls must be a positive number');
      }
      result.minimumAfterEditCalls = value;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return result;
}

async function main(): Promise<void> {
  const args = parseCliArgs(process.argv.slice(2));
  const report = await buildEditDialectReport({
    sessionRoot: args.sessionRoot,
    minimumAfterEditCalls: args.minimumAfterEditCalls,
  });
  process.stdout.write(
    args.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatEditDialectReport(report)}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
