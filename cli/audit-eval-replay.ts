/**
 * `push audit-evals` — inspect and replay the audit eval-pair corpus.
 *
 * The corpus (`.push/audit-evals.jsonl`, written by `cli/audit-eval-store.ts`)
 * records rejection→correction pairs the Auditor commit gate observed. Replay
 * drives each pair back through `runAuditor` and flags regressions:
 *
 * - `rejected_now_safe`  — the Auditor stopped catching an issue it once
 *   flagged (a *safety* regression; usually a model swap that got laxer).
 * - `corrected_now_unsafe` — the Auditor now rejects a diff it once accepted
 *   (a *precision* regression / drift).
 *
 * Subcommands:
 *   push audit-evals list                 — show the captured corpus
 *   push audit-evals replay [--no-rejected] [--limit N] [--json]
 *
 * `replay` exits non-zero when any regression is found, so it doubles as a CI
 * gate over the Auditor kernel.
 *
 * Provider/model resolution mirrors the commit gate: the active CLI provider +
 * its model, run through the same `createProviderStream` path. With no provider
 * or key configured, replay can't run (the Auditor itself fails closed), so we
 * report and exit non-zero rather than pretend everything passed.
 */

import path from 'node:path';
import process from 'node:process';

import { runAuditor } from '../lib/auditor-agent.ts';
import type { AIProviderType } from '../lib/provider-contract.ts';
import {
  replayTrainset,
  type AuditEvalReplayCaseResult,
  type AuditEvalTrainsetCase,
  type AuditVerdictFn,
} from '../lib/audit-eval-pairs.ts';
import { loadConfig } from './config-store.ts';
import { PROVIDER_CONFIGS, resolveApiKey, createProviderStream } from './provider.ts';
import { loadTrainset, AUDIT_EVAL_TRAINSET_RELPATH } from './audit-eval-store.ts';

interface AuditEvalsValues {
  cwd?: string;
  json?: boolean;
  limit?: string;
  'no-rejected'?: boolean;
  noRejected?: boolean;
  provider?: string;
  model?: string;
}

function out(text: string): void {
  process.stdout.write(text);
}

/**
 * Build a verdict function backed by the active CLI provider's Auditor, or
 * return a typed reason when no provider/key/model is resolvable. Kept separate
 * so `list` (which needs no provider) never triggers provider resolution.
 */
async function resolveAuditorVerdictFn(
  values: AuditEvalsValues,
): Promise<{ getVerdict: AuditVerdictFn; label: string } | { error: string }> {
  const config = await loadConfig();
  const providerId = values.provider || config.provider || 'ollama';
  const cliProvider = PROVIDER_CONFIGS[providerId];
  if (!cliProvider) {
    return { error: `unknown provider "${providerId}" (set one with: push config)` };
  }

  const branch = (config[providerId] as { model?: string } | undefined) ?? {};
  const model = values.model || branch.model || cliProvider.defaultModel;
  if (!model) {
    return { error: `no model configured for provider "${providerId}"` };
  }

  let apiKey = '';
  try {
    apiKey = resolveApiKey(cliProvider);
  } catch {
    apiKey = '';
  }
  if (!apiKey) {
    return { error: `no API key available for provider "${providerId}"` };
  }

  const stream = createProviderStream(cliProvider, apiKey);
  const getVerdict: AuditVerdictFn = async (diff) => {
    const result = await runAuditor(
      diff,
      {
        // providerId indexes PROVIDER_CONFIGS above, so it's a valid provider key.
        provider: providerId as AIProviderType,
        stream,
        modelId: model,
        // Replay verdicts are compared against the recorded verdict, so keep
        // the runtime context empty — the comparison is corrected-vs-rejected
        // diff, not memory-augmented context (which would add nondeterminism).
        resolveRuntimeContext: async () => '',
      },
      () => {},
    );
    return result.verdict;
  };
  return { getVerdict, label: `${providerId}/${model}` };
}

function describeCase(c: AuditEvalTrainsetCase): string {
  const files = c.sharedFiles.length > 0 ? c.sharedFiles.join(', ') : '(no shared files)';
  const risk = c.priorRisks[0]?.description ?? c.rejectedSummary ?? 'unknown risk';
  return `${c.id}  ${files}\n    rejected: ${truncate(risk, 100)}`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

async function runList(workspaceRoot: string, json: boolean): Promise<number> {
  const { cases, existed } = await loadTrainset(workspaceRoot);
  if (json) {
    out(`${JSON.stringify({ corpus: AUDIT_EVAL_TRAINSET_RELPATH, existed, cases }, null, 2)}\n`);
    return 0;
  }
  if (!existed) {
    out(emptyCorpusMessage());
    return 0;
  }
  if (cases.length === 0) {
    out(`Corpus ${AUDIT_EVAL_TRAINSET_RELPATH} is present but empty.\n`);
    return 0;
  }
  out(`${cases.length} captured pair(s) in ${AUDIT_EVAL_TRAINSET_RELPATH}:\n\n`);
  for (const c of cases) {
    out(`  ${describeCase(c)}\n\n`);
  }
  return 0;
}

function emptyCorpusMessage(): string {
  return (
    `No audit-eval corpus yet (${AUDIT_EVAL_TRAINSET_RELPATH}).\n` +
    'Pairs are captured automatically when the Auditor commit gate blocks a commit\n' +
    'as UNSAFE and a later commit on the same branch + files passes as SAFE.\n'
  );
}

function regressionLabel(result: AuditEvalReplayCaseResult): string {
  return result.regressions
    .map((r) =>
      r === 'rejected_now_safe'
        ? 'rejected diff is now SAFE (Auditor stopped catching it)'
        : 'corrected diff is now UNSAFE (Auditor got stricter / drifted)',
    )
    .join('; ');
}

async function runReplay(
  workspaceRoot: string,
  values: AuditEvalsValues,
  signal?: AbortSignal,
): Promise<number> {
  const json = values.json === true;
  const checkRejected = !(values['no-rejected'] === true || values.noRejected === true);

  const { cases, existed } = await loadTrainset(workspaceRoot);
  if (!existed || cases.length === 0) {
    if (json) {
      out(`${JSON.stringify({ existed, total: 0, results: [], summary: null }, null, 2)}\n`);
      return 0;
    }
    out(existed ? `Corpus ${AUDIT_EVAL_TRAINSET_RELPATH} is empty.\n` : emptyCorpusMessage());
    return 0;
  }

  const limit = values.limit ? Number(values.limit) : undefined;
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) {
    throw new Error(`Invalid --limit "${values.limit}" — expected a positive integer.`);
  }
  const selected = limit !== undefined ? cases.slice(0, limit) : cases;

  const resolved = await resolveAuditorVerdictFn(values);
  if ('error' in resolved) {
    if (json) {
      out(`${JSON.stringify({ error: resolved.error }, null, 2)}\n`);
    } else {
      out(`Cannot replay: ${resolved.error}.\n`);
    }
    return 1;
  }

  if (!json) {
    out(
      `Replaying ${selected.length}${
        selected.length < cases.length ? ` of ${cases.length}` : ''
      } pair(s) through ${resolved.label}${checkRejected ? '' : ' (corrected arm only)'}…\n\n`,
    );
  }

  const { results, summary, aborted } = await replayTrainset(selected, resolved.getVerdict, {
    checkRejected,
    signal,
  });

  if (json) {
    out(`${JSON.stringify({ summary, aborted, results }, null, 2)}\n`);
    return summary.regressed > 0 ? 1 : 0;
  }

  for (const result of results) {
    if (result.regressions.length === 0) {
      out(`  ok    ${result.id}\n`);
    } else {
      out(`  FAIL  ${result.id} — ${regressionLabel(result)}\n`);
    }
  }
  out(
    `\n${summary.passed}/${summary.total} held` +
      (summary.rejectedNowSafe ? `, ${summary.rejectedNowSafe} safety regression(s)` : '') +
      (summary.correctedNowUnsafe
        ? `, ${summary.correctedNowUnsafe} precision regression(s)`
        : '') +
      (aborted ? ' (aborted — partial results)' : '') +
      '\n',
  );
  return summary.regressed > 0 ? 1 : 0;
}

/**
 * `push audit-evals [list|replay]` dispatcher. Default action is `list` so a
 * bare `push audit-evals` shows the corpus without making provider calls.
 */
export async function runAuditEvalsSubcommand(
  values: AuditEvalsValues,
  positionals: string[],
  signal?: AbortSignal,
): Promise<number> {
  const action = (positionals[1] || 'list').toLowerCase();
  const workspaceRoot = path.resolve(values.cwd || process.cwd());

  if (action === 'list') {
    return runList(workspaceRoot, values.json === true);
  }
  if (action === 'replay') {
    return runReplay(workspaceRoot, values, signal);
  }
  throw new Error(`Unknown audit-evals subcommand: ${action}. Supported: list, replay`);
}
