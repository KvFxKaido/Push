#!/usr/bin/env npx tsx
/**
 * Delegation measurement wrapper.
 *
 * Runs the same task twice — once through the non-delegated headless path
 * (`./push run --task ...`) and once through the delegated path
 * (`./push run --delegate --task ...`) — captures wall time, parses the
 * `--json` output for outcome / rounds, and reads each run's session
 * `events.jsonl` for the regression-class signals the Architecture
 * Remediation Plan asks the operator to watch for (malformed tool calls,
 * harness-adaptation events, errors).
 *
 * The wrapper itself does NOT write to `docs/remediation-observations.md`
 * by default — it prints a markdown-shaped entry stub to stdout for the
 * operator to review and paste. The "no synthetic entries" rule from the
 * plan's Solo Developer Operating Notes is preserved: every entry that
 * lands in the log is a record of a real session the operator chose to
 * commit. Use `--append <path>` if you want the wrapper to do the append
 * directly.
 *
 * Usage:
 *   npx tsx scripts/measure-delegation.ts \
 *     --task "Fix the typo on line 42 of cli/foo.ts" \
 *     --model anthropic/claude-haiku-4.5 \
 *     --provider openrouter \
 *     --accept "npm run typecheck" \
 *     --label "small typo fix"
 *
 *   # Append directly:
 *   npx tsx scripts/measure-delegation.ts --task "..." --append docs/remediation-observations.md
 *
 * The two runs use independent fresh sessions so messages do not pollute
 * each other. If the same session is reused across runs, the second run's
 * model sees the first run's transcript — which would invalidate the
 * comparison.
 */

import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    task: { type: 'string' },
    model: { type: 'string', default: 'anthropic/claude-haiku-4.5' },
    provider: { type: 'string', default: 'openrouter' },
    accept: { type: 'string', multiple: true },
    'max-rounds': { type: 'string' },
    label: { type: 'string' },
    append: { type: 'string' },
    'skip-baseline': { type: 'boolean', default: false },
    'skip-delegated': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});

if (values.help || !values.task) {
  process.stdout.write(`Usage:
  npx tsx scripts/measure-delegation.ts --task "<prompt>" [options]

Options:
  --task <prompt>          Required. The task to run (same prompt in both runs).
  --model <id>             Provider model id (default: anthropic/claude-haiku-4.5).
  --provider <name>        ollama | openrouter | ... (default: openrouter).
  --accept <cmd>           Acceptance check; repeatable.
  --max-rounds <n>         Per-node and per-run round cap.
  --label <text>           Short label for the log entry's session purpose line.
  --append <path>          Append the entry to <path> instead of printing.
  --skip-baseline          Only run the delegated path.
  --skip-delegated         Only run the non-delegated path.
  -h, --help               Show this help.

Required env: a provider API key for the chosen provider (see "./push provider list").
For openrouter: PUSH_OPENROUTER_API_KEY, OPENROUTER_API_KEY, or VITE_OPENROUTER_API_KEY.
`);
  process.exit(values.help ? 0 : 2);
}

const TASK = values.task!;
const MODEL = values.model!;
const PROVIDER = values.provider!;
const MAX_ROUNDS = values['max-rounds'];
const LABEL = values.label || 'delegation measurement';
const ACCEPT = (values.accept ?? []) as string[];
const APPEND_TO = values.append;
const SKIP_BASELINE = values['skip-baseline']!;
const SKIP_DELEGATED = values['skip-delegated']!;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const PUSH_BIN = path.join(REPO_ROOT, 'push');
const SESSION_ROOT = process.env.PUSH_SESSION_DIR || path.join(os.homedir(), '.push', 'sessions');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RunMetrics {
  mode: 'baseline' | 'delegated';
  exitCode: number;
  wallMs: number;
  sessionId: string | null;
  runId: string | null;
  outcome: string;
  rounds: number | null; // total rounds; for delegated this is sum across nodes
  nodeCount: number | null; // delegated only
  acceptancePassed: boolean | null;
  fallbackTriggered: boolean; // true if delegated path fell back to non-delegated
  malformedToolCalls: number;
  harnessAdaptations: number;
  errors: number;
  rawJson: unknown;
  rawJsonParseError: string | null;
  stderrTail: string;
}

// ---------------------------------------------------------------------------
// Subprocess runner
// ---------------------------------------------------------------------------

function runPush(extraArgs: string[]): Promise<{
  exitCode: number;
  wallMs: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const args = [
      'run',
      '--json',
      '--provider',
      PROVIDER,
      '--model',
      MODEL,
      ...(MAX_ROUNDS ? ['--max-rounds', MAX_ROUNDS] : []),
      ...ACCEPT.flatMap((cmd) => ['--accept', cmd]),
      '--task',
      TASK,
      ...extraArgs,
    ];

    const start = Date.now();
    const child = spawn(PUSH_BIN, args, {
      cwd: REPO_ROOT,
      env: { ...process.env, PUSH_TUI_ENABLED: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      // Stream stderr through so the operator sees progress.
      process.stderr.write(d);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, wallMs: Date.now() - start, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// JSON output parser
// ---------------------------------------------------------------------------

function parseJsonOutput(stdout: string): { parsed: unknown; error: string | null } {
  // The CLI emits exactly one JSON object on stdout in --json mode. But in
  // delegated mode the success/summary text precedes the JSON in some
  // shapes, so be tolerant: take the last balanced top-level object.
  const trimmed = stdout.trim();
  if (!trimmed) return { parsed: null, error: 'empty stdout' };

  // Fast path: whole stdout is JSON.
  try {
    return { parsed: JSON.parse(trimmed), error: null };
  } catch {
    // Fall through to the recovery path.
  }

  // Recovery: scan for the last top-level `{` and try parsing from there.
  const lastBrace = trimmed.lastIndexOf('\n{');
  if (lastBrace >= 0) {
    try {
      return { parsed: JSON.parse(trimmed.slice(lastBrace + 1)), error: null };
    } catch (err) {
      return { parsed: null, error: `recovery parse failed: ${(err as Error).message}` };
    }
  }
  return { parsed: null, error: 'no JSON object found' };
}

// ---------------------------------------------------------------------------
// Session events reader
// ---------------------------------------------------------------------------

async function readSessionEvents(sessionId: string): Promise<unknown[]> {
  const eventsPath = path.join(SESSION_ROOT, sessionId, 'events.jsonl');
  try {
    const raw = await fs.readFile(eventsPath, 'utf8');
    const events: unknown[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        events.push(JSON.parse(trimmed));
      } catch {
        // Skip malformed lines — events.jsonl is append-only and a torn
        // tail line shouldn't fail the whole read.
      }
    }
    return events;
  } catch {
    return [];
  }
}

function countEventTypes(events: unknown[]): {
  malformed: number;
  adaptations: number;
  errors: number;
} {
  let malformed = 0;
  let adaptations = 0;
  let errors = 0;
  for (const evt of events) {
    if (typeof evt !== 'object' || evt === null) continue;
    const type = (evt as { type?: string }).type;
    if (type === 'tool.call_malformed') malformed++;
    else if (type === 'harness.adaptation') adaptations++;
    else if (type === 'error') errors++;
  }
  return { malformed, adaptations, errors };
}

// ---------------------------------------------------------------------------
// Run + measure
// ---------------------------------------------------------------------------

async function measureRun(mode: 'baseline' | 'delegated'): Promise<RunMetrics> {
  const extraArgs = mode === 'delegated' ? ['--delegate'] : [];
  process.stderr.write(`\n[measure-delegation] running ${mode}…\n`);
  const { exitCode, wallMs, stdout, stderr } = await runPush(extraArgs);

  const { parsed, error: parseError } = parseJsonOutput(stdout);
  const obj = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;

  const sessionId = typeof obj.sessionId === 'string' ? obj.sessionId : null;
  const runId = typeof obj.runId === 'string' ? obj.runId : null;
  const outcome = typeof obj.outcome === 'string' ? obj.outcome : 'unknown';

  // Round count differs by path:
  //   non-delegated   → `rounds` (number)
  //   delegated       → `totalRounds` (sum across nodes)
  //   delegated→fallback → `rounds` (the fallback runAssistantLoop's count)
  const rounds =
    typeof obj.totalRounds === 'number'
      ? obj.totalRounds
      : typeof obj.rounds === 'number'
        ? obj.rounds
        : null;

  const nodeCount = typeof obj.nodeCount === 'number' ? obj.nodeCount : null;
  const fallbackTriggered = obj.fallback === 'planner_empty';

  let acceptancePassed: boolean | null = null;
  const acceptance = obj.acceptance as { passed?: boolean } | undefined;
  if (acceptance && typeof acceptance === 'object' && typeof acceptance.passed === 'boolean') {
    acceptancePassed = acceptance.passed;
  } else if (ACCEPT.length > 0) {
    // Acceptance configured but no acceptance block in the JSON output.
    // Delegated path doesn't currently emit acceptance results in its
    // top-level JSON — flag this for the operator instead of silently
    // recording null.
    acceptancePassed = null;
  }

  const events = sessionId ? await readSessionEvents(sessionId) : [];
  const { malformed, adaptations, errors } = countEventTypes(events);

  // stderr can be long; keep the tail for the entry's notes.
  const stderrLines = stderr.trim().split('\n');
  const stderrTail = stderrLines.slice(-10).join('\n');

  return {
    mode,
    exitCode,
    wallMs,
    sessionId,
    runId,
    outcome,
    rounds,
    nodeCount,
    acceptancePassed,
    fallbackTriggered,
    malformedToolCalls: malformed,
    harnessAdaptations: adaptations,
    errors,
    rawJson: parsed,
    rawJsonParseError: parseError,
    stderrTail,
  };
}

// ---------------------------------------------------------------------------
// Markdown emitter
// ---------------------------------------------------------------------------

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

function fmtAcceptance(v: boolean | null): string {
  if (v === null) return 'n/a';
  return v ? 'pass' : 'fail';
}

function fmtRow(m: RunMetrics): string {
  const roundsCell =
    m.rounds === null
      ? '—'
      : m.nodeCount !== null
        ? `${m.rounds} (${m.nodeCount} nodes)`
        : String(m.rounds);
  const flags: string[] = [];
  if (m.fallbackTriggered) flags.push('fell-back');
  if (m.rawJsonParseError) flags.push(`json-parse-failed: ${m.rawJsonParseError}`);
  const flagCell = flags.length > 0 ? ` _(${flags.join('; ')})_` : '';
  return `| ${m.mode} | ${m.outcome}${flagCell} | ${roundsCell} | ${fmtMs(m.wallMs)} | ${fmtAcceptance(m.acceptancePassed)} | ${m.malformedToolCalls} | ${m.harnessAdaptations} | ${m.errors} |`;
}

function buildMarkdownEntry(today: string, metrics: RunMetrics[]): string {
  const lines: string[] = [];
  lines.push(`## ${today} — ${LABEL} (Gap 3 measurement)`);
  lines.push('');
  lines.push(
    `**Session purpose:** ${LABEL}. Same task run through the non-delegated and delegated paths on \`${PROVIDER}/${MODEL}\` to populate the Gap 3 Step 1 go/no-go signal per the Architecture Remediation Plan §CLI Runtime Parity.`,
  );
  lines.push('');
  lines.push(`**Task:** ${TASK.length > 200 ? `${TASK.slice(0, 200)}…` : TASK}`);
  lines.push('');
  lines.push(`**Model:** \`${PROVIDER}/${MODEL}\``);
  lines.push(
    `**Acceptance:** ${ACCEPT.length === 0 ? 'none' : ACCEPT.map((c) => `\`${c}\``).join(', ')}`,
  );
  lines.push('');
  lines.push('| mode | outcome | rounds | wall | accept | malformed | adapts | errors |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const m of metrics) {
    lines.push(fmtRow(m));
  }
  lines.push('');
  lines.push('**Session ids:**');
  for (const m of metrics) {
    lines.push(`- ${m.mode}: \`${m.sessionId ?? '(none)'}\` (runId \`${m.runId ?? '(none)'}\`)`);
  }
  lines.push('');

  // Decision-tree placeholder per the plan's go/no-go signal.
  if (metrics.length === 2) {
    const baseline = metrics.find((m) => m.mode === 'baseline');
    const delegated = metrics.find((m) => m.mode === 'delegated');
    if (baseline && delegated) {
      lines.push('**Decision-tree input (per plan §Gap 3 Step 1):**');
      lines.push(
        `- baseline outcome: ${baseline.outcome}; delegated outcome: ${delegated.outcome}.`,
      );
      lines.push(
        `- rounds: baseline=${baseline.rounds ?? '—'}, delegated=${delegated.rounds ?? '—'} across ${delegated.nodeCount ?? '—'} nodes.`,
      );
      lines.push(
        `- wall: baseline=${fmtMs(baseline.wallMs)}, delegated=${fmtMs(delegated.wallMs)}.`,
      );
      lines.push('');
      lines.push(
        "_Operator: fill in the qualitative call. ≥, ≈, or < per the plan's decision tree, plus what actually shipped or didn't. The numbers above are inputs, not the verdict._",
      );
      lines.push('');
    }
  }

  // Regression-class watch per plan §"What 'real usage' actually has to surface".
  const anyMalformed = metrics.some((m) => m.malformedToolCalls > 0);
  const anyErrors = metrics.some((m) => m.errors > 0);
  const anyAdapts = metrics.some((m) => m.harnessAdaptations > 0);
  if (anyMalformed || anyErrors || anyAdapts) {
    lines.push('**Regression-class watch:**');
    if (anyMalformed) {
      lines.push(
        `- Malformed tool calls observed (${metrics.map((m) => `${m.mode}=${m.malformedToolCalls}`).join(', ')}). Inspect \`tool.call_malformed\` events in the session(s) above for reasons.`,
      );
    }
    if (anyAdapts) {
      lines.push(
        `- Harness adaptations fired (${metrics.map((m) => `${m.mode}=${m.harnessAdaptations}`).join(', ')}). Round budget shrunk mid-run; cli/harness-adaptation.ts:121 floor was hit.`,
      );
    }
    if (anyErrors) {
      lines.push(
        `- Errors recorded (${metrics.map((m) => `${m.mode}=${m.errors}`).join(', ')}). Check the session events.jsonl for \`type:"error"\` payloads.`,
      );
    }
    lines.push('');
  } else {
    lines.push(
      '**Regression-class watch:** none of the flagged signals fired (no malformed tool calls, no harness adaptations, no errors).',
    );
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push(
    `_Generated by \`scripts/measure-delegation.ts\`. Numbers above are mechanical; the operator is responsible for the qualitative read and for editing this entry into the log's prose voice before committing._`,
  );
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  // Sanity check: push binary present and executable. resolveApiKey lives
  // inside the spawned process; if it throws, we'll see it in stderr +
  // a non-zero exit.
  try {
    await fs.access(PUSH_BIN, fs.constants.X_OK);
  } catch {
    process.stderr.write(`error: ${PUSH_BIN} not found or not executable.\n`);
    return 2;
  }

  const metrics: RunMetrics[] = [];

  if (!SKIP_BASELINE) {
    metrics.push(await measureRun('baseline'));
  }
  if (!SKIP_DELEGATED) {
    metrics.push(await measureRun('delegated'));
  }

  const today = new Date().toISOString().slice(0, 10);
  const entry = buildMarkdownEntry(today, metrics);

  if (APPEND_TO) {
    // Append with a leading blank line so successive runs don't collide.
    await fs.appendFile(APPEND_TO, `\n${entry}\n`, 'utf8');
    process.stderr.write(`\n[measure-delegation] appended to ${APPEND_TO}\n`);
  } else {
    process.stdout.write(`\n${entry}\n`);
  }

  // Exit non-zero only if both runs failed to produce a parsable JSON
  // output — otherwise the operator can still read the entry. A failed
  // delegated run with a successful baseline (or vice versa) is itself a
  // valid measurement.
  const allUnparsable = metrics.every((m) => m.rawJsonParseError !== null);
  return allUnparsable ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
