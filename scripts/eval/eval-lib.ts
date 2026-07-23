/**
 * Pure helpers for the agent eval harness — types, CLI-output parsing,
 * session-event counting, scoring, and summary formatting. No I/O here so
 * the scoring contract is unit-testable (cli/tests/eval-harness.test.mjs).
 *
 * Part of Durable Runs Phase 0 (docs/decisions/Durable Runs —
 * Adopt-on-Silence.md): the harness supplies the measurement both the
 * Phase-2 in-page-vs-RunHost comparison and the delegation-collapse A/B
 * were gated on.
 */

import { buildGeminiUpstreamUrl } from '../../cli/gemini-stream.js';
import { aiGatewaySkipCacheHeaders, isAiGatewayUrl } from '../../lib/ai-gateway.js';
import { evaluateRuntimeEvents, type RuntimeEvalRunSelector } from '../../lib/runtime-eval.js';

// ---------------------------------------------------------------------------
// Task manifest types
// ---------------------------------------------------------------------------

export interface EvalTask {
  /** Unique kebab-case id — used in filters, results, and workspace names. */
  id: string;
  title: string;
  /** The headless task prompt (passed to `push run --task`). */
  prompt: string;
  /** Fixture workspace: relative path → file content. */
  files: Record<string, string>;
  /**
   * Acceptance commands, shell-executed in the workspace by `push run`
   * (`runAcceptanceChecks`). Keep them deterministic and dependency-free
   * (plain `node`); they are the scorer's ground truth. They live in the
   * manifest — NOT as workspace files — so the agent can't edit them.
   */
  accept: string[];
  /**
   * A reference solution: files overlaid on the fixture that must make
   * every acceptance command pass. Never written into trial workspaces —
   * it exists so CI can prove each task is satisfiable (all checks pass
   * on solved) and non-trivial (≥1 check fails on unsolved) without
   * spending agent tokens.
   */
  solution: Record<string, string>;
  /** Per-task round cap override (default comes from the runner). */
  maxRounds?: number;
  tags?: string[];
}

// ---------------------------------------------------------------------------
// Trial result + scoring
// ---------------------------------------------------------------------------

export interface TrialResult {
  taskId: string;
  trial: number;
  exitCode: number;
  wallMs: number;
  sessionId: string | null;
  runId: string | null;
  /** success | acceptance_failed | aborted | error | max_rounds | unknown */
  outcome: string;
  rounds: number | null;
  acceptancePassed: boolean | null;
  /** The headline score: outcome success AND acceptance didn't fail. */
  completed: boolean;
  toolCalls: number;
  toolErrors: number;
  malformedToolCalls: number;
  harnessAdaptations: number;
  errorEvents: number;
  jsonParseError: string | null;
  stderrTail: string;
}

export interface EventCounts {
  toolCalls: number;
  toolErrors: number;
  malformed: number;
  adaptations: number;
  errors: number;
}

/**
 * Count scorer-relevant signals in a session's events.jsonl lines.
 * Event vocabulary per lib/runtime-contract.ts: `tool.execution_complete`
 * carries `payload.isError`; `tool.call_malformed`, `harness.adaptation`,
 * and `error` are counted as-is.
 */
export function countSessionEvents(
  events: unknown[],
  selector: RuntimeEvalRunSelector = {},
): EventCounts {
  const { metrics } = evaluateRuntimeEvents(events, undefined, selector);
  return {
    toolCalls: metrics.toolCalls,
    toolErrors: metrics.toolErrors,
    malformed: metrics.malformedToolCalls,
    adaptations: metrics.harnessAdaptations,
    errors: metrics.errorEvents,
  };
}

/**
 * Extract the CLI's `--json` result object from stdout. Tolerant of prose
 * preceding the JSON (same recovery as scripts/measure-delegation.ts):
 * walk backward through `{` positions and take the first parse that
 * succeeds.
 */
export function parseCliJsonOutput(stdout: string): { parsed: unknown; error: string | null } {
  const trimmed = stdout.trim();
  if (!trimmed) return { parsed: null, error: 'empty stdout' };
  try {
    return { parsed: JSON.parse(trimmed), error: null };
  } catch {
    // fall through to recovery
  }
  let lastError: string | null = null;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    if (trimmed[i] !== '{') continue;
    try {
      return { parsed: JSON.parse(trimmed.slice(i)), error: null };
    } catch (err) {
      lastError = (err as Error).message;
    }
  }
  return {
    parsed: null,
    error: lastError ? `no parsable object (last: ${lastError})` : 'no JSON object found',
  };
}

export interface CliRunFields {
  sessionId: string | null;
  runId: string | null;
  outcome: string;
  rounds: number | null;
  acceptancePassed: boolean | null;
}

/** Pull the scored fields out of the parsed `--json` object. */
export function extractCliRunFields(parsed: unknown): CliRunFields {
  const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  const acceptance = obj.acceptance as { passed?: boolean } | null | undefined;
  return {
    sessionId: typeof obj.sessionId === 'string' ? obj.sessionId : null,
    runId: typeof obj.runId === 'string' ? obj.runId : null,
    outcome: typeof obj.outcome === 'string' ? obj.outcome : 'unknown',
    // Delegated runs report `totalRounds` (sum across nodes); plain runs
    // report `rounds`. Score them on one axis.
    rounds:
      typeof obj.totalRounds === 'number'
        ? obj.totalRounds
        : typeof obj.rounds === 'number'
          ? obj.rounds
          : null,
    acceptancePassed:
      acceptance && typeof acceptance === 'object' && typeof acceptance.passed === 'boolean'
        ? acceptance.passed
        : null,
  };
}

/**
 * Completion requires positive acceptance EVIDENCE, not just absence of
 * failure: every manifest task has acceptance commands, so a trial with
 * `acceptancePassed === null` means nothing verified the work — the
 * delegated CLI path emits no top-level acceptance block, and treating
 * that as completed would corrupt the A/B completion metric. The runner
 * closes the gap by executing the acceptance commands itself when the
 * CLI didn't report them (see runHarnessAcceptance in run-evals.ts).
 */
export function isCompleted(fields: CliRunFields): boolean {
  return fields.outcome === 'success' && fields.acceptancePassed === true;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface EvalSummary {
  trials: number;
  completedTrials: number;
  completionRate: number;
  medianRounds: number | null;
  medianWallMs: number | null;
  totalToolCalls: number;
  totalToolErrors: number;
  toolErrorRate: number | null;
  totalMalformed: number;
  totalAdaptations: number;
  totalErrorEvents: number;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export function summarizeTrials(results: TrialResult[]): EvalSummary {
  const completed = results.filter((r) => r.completed);
  const rounds = results.map((r) => r.rounds).filter((r): r is number => typeof r === 'number');
  const walls = results.map((r) => r.wallMs);
  const totalToolCalls = results.reduce((acc, r) => acc + r.toolCalls, 0);
  const totalToolErrors = results.reduce((acc, r) => acc + r.toolErrors, 0);
  return {
    trials: results.length,
    completedTrials: completed.length,
    completionRate: results.length === 0 ? 0 : completed.length / results.length,
    medianRounds: median(rounds),
    medianWallMs: median(walls),
    totalToolCalls,
    totalToolErrors,
    toolErrorRate: totalToolCalls === 0 ? null : totalToolErrors / totalToolCalls,
    totalMalformed: results.reduce((acc, r) => acc + r.malformedToolCalls, 0),
    totalAdaptations: results.reduce((acc, r) => acc + r.harnessAdaptations, 0),
    totalErrorEvents: results.reduce((acc, r) => acc + r.errorEvents, 0),
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function fmtMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

export function fmtRate(rate: number | null): string {
  if (rate === null) return '—';
  return `${Math.round(rate * 100)}%`;
}

export interface RunMeta {
  provider: string;
  model: string;
  delegate: boolean;
  trialsPerTask: number;
  label: string;
  startedAtIso: string;
}

/** Markdown report: per-trial table + aggregate line. */
export function buildMarkdownSummary(
  meta: RunMeta,
  results: TrialResult[],
  summary: EvalSummary,
): string {
  const lines: string[] = [];
  lines.push(`## Agent eval — ${meta.label}`);
  lines.push('');
  lines.push(
    `**Stack:** \`${meta.provider}/${meta.model}\`${meta.delegate ? ' (delegated)' : ''} · ` +
      `${summary.trials} trials (${meta.trialsPerTask}× per task) · started ${meta.startedAtIso}`,
  );
  lines.push('');
  lines.push('| task | trial | outcome | accept | rounds | wall | tool err | malformed |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const accept = r.acceptancePassed === null ? 'n/a' : r.acceptancePassed ? 'pass' : '**fail**';
    const outcome = r.completed ? r.outcome : `**${r.outcome}**`;
    const flags = r.jsonParseError ? ' _(json-parse-failed)_' : '';
    lines.push(
      `| ${r.taskId} | ${r.trial} | ${outcome}${flags} | ${accept} | ${r.rounds ?? '—'} | ` +
        `${fmtMs(r.wallMs)} | ${r.toolErrors}/${r.toolCalls} | ${r.malformedToolCalls} |`,
    );
  }
  lines.push('');
  lines.push(
    `**Aggregate:** completion ${summary.completedTrials}/${summary.trials} ` +
      `(${fmtRate(summary.completionRate)}) · median rounds ${summary.medianRounds ?? '—'} · ` +
      `median wall ${fmtMs(summary.medianWallMs)} · tool-error rate ${fmtRate(summary.toolErrorRate)} ` +
      `(${summary.totalToolErrors}/${summary.totalToolCalls}) · malformed ${summary.totalMalformed} · ` +
      `adaptations ${summary.totalAdaptations} · error events ${summary.totalErrorEvents}`,
  );
  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Manifest validation (run by the harness at startup and by tests)
// ---------------------------------------------------------------------------

export function validateTasks(tasks: EvalTask[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const task of tasks) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(task.id)) {
      problems.push(`task id "${task.id}" is not kebab-case`);
    }
    if (seen.has(task.id)) problems.push(`duplicate task id "${task.id}"`);
    seen.add(task.id);
    if (!task.prompt.trim()) problems.push(`task "${task.id}" has an empty prompt`);
    if (task.accept.length === 0) {
      problems.push(`task "${task.id}" has no acceptance commands — it can't be scored`);
    }
    if (Object.keys(task.files).length === 0) {
      problems.push(`task "${task.id}" has no fixture files`);
    }
    if (Object.keys(task.solution).length === 0) {
      problems.push(`task "${task.id}" has no reference solution — satisfiability is unprovable`);
    }
    for (const file of [...Object.keys(task.files), ...Object.keys(task.solution)]) {
      if (path_isAbsoluteOrEscaping(file)) {
        problems.push(`task "${task.id}" fixture path "${file}" must be relative (no ..)`);
      }
    }
    for (const cmd of task.accept) {
      // Single quotes delimit the `node -e` payloads in a shell-executed
      // string; a stray inner single quote silently truncates the JS.
      const quoteCount = (cmd.match(/'/g) ?? []).length;
      if (quoteCount % 2 !== 0) {
        problems.push(`task "${task.id}" accept command has unbalanced single quotes: ${cmd}`);
      }
    }
  }
  return problems;
}

function path_isAbsoluteOrEscaping(p: string): boolean {
  return p.startsWith('/') || p.split('/').includes('..');
}

// ---------------------------------------------------------------------------
// Cache-bypass preflight (#1554)
// ---------------------------------------------------------------------------
//
// The gateway posture (lib/ai-gateway.ts) is bypass-per-request, but evals
// must not TRUST it: a dashboard cache toggle is exactly the kind of state
// that drifts. So the harness sends two identical tiny calls through the
// same URL/auth/header construction the CLI transports use and hard-fails
// the suite if the second comes back as a cache replay — a silent
// data-quality bug becomes a loud error at eval start.
//
// Verdict strictness is route-dependent (fugu review, #1581): on a DETECTED
// gateway route the probe must complete cleanly (2xx + a cf-aig-cache-status
// present and not HIT) or the suite aborts — inconclusive is failure where
// verification was possible. On any other route, a HIT still aborts, but
// missing headers / probe errors only log: requiring gateway evidence from a
// direct provider would fail every non-gateway eval. Consequently a
// custom-domain gateway is caught only while it forwards the standard
// cf-aig-cache-status header; a front that strips it is out of this probe's
// reach — point evals at the canonical gateway host to get the strict tier.

const CACHE_PROBE_PROMPT = 'Reply with the single word: ok.';

export interface CacheProbeProvider {
  id: string;
  url: string;
  streamShape?: 'openai-compat' | 'openai-responses' | 'anthropic' | 'gemini';
  apiKey: string;
  model: string;
}

export interface CacheProbeRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
  /** True when the final probe URL is a detected AI Gateway route — selects
   *  the strict verdict tier in {@link evaluateCacheProbe}. */
  gatewayRoute: boolean;
}

export type CacheProbePlan = { request: CacheProbeRequest } | { skip: string };

/**
 * Build the dialect-appropriate minimal request for the cache probe. The
 * skip-cache header comes from the SAME lib helper the CLI transports use,
 * so the probe cannot drift from what real eval traffic sends.
 */
export function buildCacheProbePlan(provider: CacheProbeProvider): CacheProbePlan {
  const { id, apiKey, model } = provider;
  let { url, streamShape } = provider;
  if (id === 'openrouter') {
    if (!isAiGatewayUrl(url)) {
      // OpenRouter picks its wire (responses vs chat) per request; its direct
      // host is never a gateway, so there is nothing route-shaped to assert.
      return { skip: 'openrouter routes per-request and its direct host is not a gateway' };
    }
    // A gateway-pinned OpenRouter URL is live config (profile/env override)
    // and the production transports DO send the bypass on it — so it gets the
    // strict probe, not the skip. Probe the chat wire: the suffix swap
    // mirrors openRouterWireUrl (cli/provider.ts), the cache assertion is
    // about the route rather than the wire, and the strict gateway tier turns
    // a wire mismatch into a loud fail instead of a silent skip.
    url = url.trim().replace(/\/responses\/?$/, '/chat/completions');
    streamShape = 'openai-compat';
  }
  const message = { role: 'user', content: CACHE_PROBE_PROMPT };
  switch (streamShape) {
    case 'anthropic':
      return {
        request: {
          url,
          headers: {
            'Content-Type': 'application/json',
            // Mirrors ANTHROPIC_API_VERSION in cli/anthropic-stream.ts.
            'anthropic-version': '2023-06-01',
            ...(apiKey ? { 'x-api-key': apiKey } : {}),
            ...aiGatewaySkipCacheHeaders(url),
          },
          body: JSON.stringify({ model, max_tokens: 16, messages: [message], stream: false }),
          gatewayRoute: isAiGatewayUrl(url),
        },
      };
    case 'gemini': {
      const upstreamUrl = buildGeminiUpstreamUrl(url, model);
      return {
        request: {
          url: upstreamUrl,
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'x-goog-api-key': apiKey } : {}),
            ...aiGatewaySkipCacheHeaders(upstreamUrl),
          },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: CACHE_PROBE_PROMPT }] }],
            generationConfig: { maxOutputTokens: 16 },
          }),
          gatewayRoute: isAiGatewayUrl(upstreamUrl),
        },
      };
    }
    case 'openai-responses':
      return {
        request: {
          url,
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            ...aiGatewaySkipCacheHeaders(url),
          },
          body: JSON.stringify({
            model,
            input: CACHE_PROBE_PROMPT,
            max_output_tokens: 16,
            stream: false,
          }),
          gatewayRoute: isAiGatewayUrl(url),
        },
      };
    case 'openai-compat':
    case undefined:
      return {
        request: {
          url,
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
            ...aiGatewaySkipCacheHeaders(url),
          },
          body: JSON.stringify({ model, messages: [message], max_tokens: 16, stream: false }),
          gatewayRoute: isAiGatewayUrl(url),
        },
      };
  }
}

export interface CacheProbeCallResult {
  status: number;
  cacheStatus: string | null;
}

/**
 * Verdict on the probe pair. A HIT from EITHER call fails on ANY route — the
 * probe body is constant per provider/model, so the first call can replay an
 * entry seeded by an earlier preflight (an aborted run's operator re-run is
 * the realistic case), and that entry can expire before the delayed second
 * call; any observed HIT proves this transport construction was replayed. On
 * a detected gateway route the bar is higher still: both calls must be 2xx
 * and the repeat must carry a non-HIT `cf-aig-cache-status` — the header is
 * guaranteed there, so its absence (or an error pair) means the bypass went
 * unverified and the suite must not proceed on trust. Elsewhere those same
 * outcomes only earn a caveat in the reason (see the module note on the
 * custom-domain limitation).
 */
export function evaluateCacheProbe(input: {
  gatewayRoute: boolean;
  first: CacheProbeCallResult;
  second: CacheProbeCallResult;
}): { ok: boolean; reason: string } {
  const { gatewayRoute, first, second } = input;
  const firstStatus = first.cacheStatus?.trim().toUpperCase() || null;
  const status = second.cacheStatus?.trim().toUpperCase() || null;
  if (firstStatus === 'HIT' || status === 'HIT') {
    const which =
      firstStatus === 'HIT' && status === 'HIT'
        ? 'both calls were'
        : firstStatus === 'HIT'
          ? 'the first call was'
          : 'the identical repeat was';
    return {
      ok: false,
      reason: `${which} served from the gateway response cache (cf-aig-cache-status: HIT) — eval outputs would be replays, not model output (#1554)`,
    };
  }
  const cleanStatuses =
    first.status >= 200 && first.status < 300 && second.status >= 200 && second.status < 300;
  if (gatewayRoute) {
    if (!cleanStatuses) {
      return {
        ok: false,
        reason: `gateway probe did not complete cleanly (HTTP ${first.status}/${second.status}) — cache bypass unverified on a gateway route`,
      };
    }
    if (status === null) {
      return {
        ok: false,
        reason:
          'gateway route returned no cf-aig-cache-status on the repeat — cache bypass unverified',
      };
    }
    return { ok: true, reason: `gateway verified not replaying (cf-aig-cache-status: ${status})` };
  }
  if (!cleanStatuses) {
    return {
      ok: true,
      reason: `probe returned HTTP ${first.status}/${second.status} on a non-gateway route — no replay evidence (a HIT would still have failed)`,
    };
  }
  if (status === null) {
    return { ok: true, reason: 'no gateway cache header on this route' };
  }
  return {
    ok: true,
    reason: `caching proxy present and not replaying (cf-aig-cache-status: ${status})`,
  };
}
