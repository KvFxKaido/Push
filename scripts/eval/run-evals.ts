#!/usr/bin/env npx tsx
/**
 * Agent eval harness — Durable Runs Phase 0 instrument (b).
 *
 * Runs the task manifest (scripts/eval/tasks.ts) through the live CLI
 * agent loop (`./push run --json`), one fresh temp-dir fixture workspace
 * per trial, and scores each trial on:
 *
 *   - task completion   (outcome === success && acceptance not failed)
 *   - turn count        (rounds; totalRounds for --delegate runs)
 *   - wall-clock        (spawn → exit)
 *   - tool-error rate   (tool.execution_complete isError / total, from the
 *                        session's events.jsonl)
 *
 * plus the regression-class signals (malformed tool calls, harness
 * adaptations, error events). This supplies the measurement gate for the
 * Phase-2 in-page-vs-RunHost comparison AND the delegation-collapse A/B
 * (`--delegate` runs the same suite through the task-graph path — compare
 * two result files).
 *
 * Usage:
 *   npx tsx scripts/eval/run-evals.ts                        # full suite
 *   npx tsx scripts/eval/run-evals.ts --tasks fix-string-typo,implement-clamp
 *   npx tsx scripts/eval/run-evals.ts --provider openrouter --model anthropic/claude-haiku-4.5
 *   npx tsx scripts/eval/run-evals.ts --delegate --label "delegated A/B leg"
 *   npx tsx scripts/eval/run-evals.ts --list                 # print task ids
 *
 * Output: results/<timestamp>.jsonl (one line per trial, written
 * incrementally) + results/<timestamp>.md (summary, also printed to
 * stdout). Progress goes to stderr; stdout carries only the report.
 *
 * Requires a provider API key for the chosen provider in the environment
 * (see `./push provider list`). Not CI-gating by design — runs cost real
 * tokens; the operator runs it deliberately.
 */

import { spawn, spawnSync } from 'node:child_process';
import { promises as fs, constants as fsConstants } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  buildCacheProbePlan,
  buildMarkdownSummary,
  countSessionEvents,
  evaluateCacheProbe,
  extractCliRunFields,
  fmtMs,
  isCompleted,
  parseCliJsonOutput,
  summarizeTrials,
  validateTasks,
  type EvalTask,
  type TrialResult,
} from './eval-lib';
import { EVAL_TASKS } from './tasks';
import { applyConfigToEnv, loadConfig } from '../../cli/config-store.js';
import { PROVIDER_CONFIGS, redirectDeprecatedProvider, resolveApiKey } from '../../cli/provider.js';
import { runCommandInResolvedShellSync } from '../../cli/shell.js';

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

const { values } = parseArgs({
  options: {
    provider: { type: 'string', default: 'zen' },
    model: { type: 'string', default: 'glm-5.1' },
    tasks: { type: 'string' },
    trials: { type: 'string', default: '1' },
    'max-rounds': { type: 'string', default: '14' },
    'task-timeout': { type: 'string', default: '600' },
    delegate: { type: 'boolean', default: false },
    label: { type: 'string' },
    out: { type: 'string' },
    'keep-workspaces': { type: 'boolean', default: false },
    'skip-preflight': { type: 'boolean', default: false },
    list: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
  strict: true,
});

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const PUSH_BIN = path.join(REPO_ROOT, 'push');
const SESSION_ROOT = process.env.PUSH_SESSION_DIR || path.join(os.homedir(), '.push', 'sessions');
const RESULTS_DIR = values.out ? path.resolve(values.out) : path.join(SCRIPT_DIR, 'results');

const PROVIDER = values.provider!;
const MODEL = values.model!;
const TRIALS = Math.max(1, Number(values.trials) || 1);
const MAX_ROUNDS = values['max-rounds']!;
const TASK_TIMEOUT_MS = Math.max(30, Number(values['task-timeout']) || 600) * 1000;
const DELEGATE = values.delegate!;
const KEEP_WORKSPACES = values['keep-workspaces']!;
const LABEL = values.label || `${PROVIDER}/${MODEL}${DELEGATE ? ' delegated' : ''}`;

function log(message: string): void {
  process.stderr.write(`[eval] ${message}\n`);
}

if (values.help) {
  process.stdout.write(`Usage: npx tsx scripts/eval/run-evals.ts [options]

Options:
  --provider <name>      Provider for the agent loop (default: zen).
  --model <id>           Model id (default: glm-5.1).
  --tasks <ids>          Comma-separated task ids to run (default: all).
  --trials <n>           Trials per task (default: 1).
  --max-rounds <n>       Round cap per run unless the task overrides (default: 14).
  --task-timeout <s>     Hard per-trial wall limit; the run is killed past it (default: 600).
  --delegate             Run via the task-graph delegation path (A/B leg).
  --label <text>         Label for the report header.
  --out <dir>            Results directory (default: scripts/eval/results).
  --keep-workspaces      Keep ALL trial workspaces (failed ones are always kept).
  --skip-preflight       Skip the provider sanity + cache-bypass preflights.
  --list                 Print task ids and exit.
  -h, --help             Show this help.
`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Subprocess
// ---------------------------------------------------------------------------

interface SpawnOutcome {
  exitCode: number;
  wallMs: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runPush(args: string[], cwd: string, timeoutMs: number): Promise<SpawnOutcome> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    // NODE_TEST_CONTEXT must not leak into the CLI (and from there into
    // acceptance commands): a spawned `node --test` that sees it believes
    // it's a child test shard and exits 0 without running anything.
    const env = { ...process.env, PUSH_TUI_ENABLED: '0' };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(PUSH_BIN, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      // Escalate if SIGTERM is ignored — a wedged provider stream must not
      // wedge the whole suite.
      setTimeout(() => child.kill('SIGKILL'), 10_000).unref();
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(killTimer);
      resolve({ exitCode: code ?? 1, wallMs: Date.now() - start, stdout, stderr, timedOut });
    });
  });
}

// ---------------------------------------------------------------------------
// Workspace fixtures
// ---------------------------------------------------------------------------

async function createWorkspace(task: EvalTask, trial: number): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `push-eval-${task.id}-t${trial}-`));
  for (const [rel, content] of Object.entries(task.files)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
  }
  // Fixtures are git repos: the CLI's workspace snapshot reads branch +
  // dirty state, and a clean baseline commit makes post-run `git diff`
  // inspection of kept workspaces trivial.
  const git = (args: string[]) =>
    spawnSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
  git(['init', '-q']);
  git(['add', '-A']);
  git([
    '-c',
    'user.name=push-eval',
    '-c',
    'user.email=eval@push.local',
    'commit',
    '-qm',
    'fixture baseline',
  ]);
  return dir;
}

// ---------------------------------------------------------------------------
// Session events
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
        // Torn tail line in an append-only journal — skip, don't fail.
      }
    }
    return events;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Trial
// ---------------------------------------------------------------------------

/**
 * Harness-side acceptance fallback: the delegated CLI path doesn't emit a
 * top-level `acceptance` block in its `--json` output, and completion
 * requires positive evidence (isCompleted). When the CLI didn't report
 * acceptance, run the manifest commands directly in the trial workspace —
 * same shell semantics as runAcceptanceChecks, scrubbed env.
 */
async function runHarnessAcceptance(task: EvalTask, workspace: string): Promise<boolean> {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  for (const cmd of task.accept) {
    // Resolve the shell rather than passing `shell: true`, which is `cmd.exe` on
    // Windows and shreds the manifest's POSIX-quoted `node -e '...'` payloads.
    const res = await runCommandInResolvedShellSync(cmd, {
      cwd: workspace,
      timeout: 120_000,
      env,
    });
    if (res.status !== 0) return false;
  }
  return true;
}

async function runTrial(task: EvalTask, trial: number): Promise<TrialResult> {
  const workspace = await createWorkspace(task, trial);
  const args = [
    'run',
    '--json',
    // Agents must be able to run code to verify their work — that's the
    // realistic condition being measured. Without this, headless mode blocks
    // every exec (EXEC_DISABLED), inflating tool-error rates (the 2026-06-11
    // A/B measured 25–30% with blocks vs ~5% real) and pushing models into
    // read-file verification fallbacks. The fixture workspaces are throwaway
    // temp dirs and the acceptance checks already run arbitrary shell there,
    // so this adds no new trust surface.
    '--allow-exec',
    '--provider',
    PROVIDER,
    '--model',
    MODEL,
    '--max-rounds',
    String(task.maxRounds ?? MAX_ROUNDS),
    ...task.accept.flatMap((cmd) => ['--accept', cmd]),
    ...(DELEGATE ? ['--delegate'] : []),
    '--task',
    task.prompt,
  ];

  const { exitCode, wallMs, stdout, stderr, timedOut } = await runPush(
    args,
    workspace,
    TASK_TIMEOUT_MS,
  );

  const { parsed, error: jsonParseError } = parseCliJsonOutput(stdout);
  const fields = extractCliRunFields(parsed);
  if (timedOut) fields.outcome = 'harness_timeout';

  // Acceptance evidence fallback (Codex P1): if the CLI claims success but
  // reported no acceptance block (the delegated path doesn't emit one),
  // verify the work here — never score a completion nobody checked.
  if (!timedOut && fields.outcome === 'success' && fields.acceptancePassed === null) {
    fields.acceptancePassed = await runHarnessAcceptance(task, workspace);
  }

  const events = fields.sessionId ? await readSessionEvents(fields.sessionId) : [];
  const counts = countSessionEvents(events, {
    ...(fields.sessionId ? { sessionId: fields.sessionId } : {}),
    ...(fields.runId ? { runId: fields.runId } : {}),
  });

  const result: TrialResult = {
    taskId: task.id,
    trial,
    exitCode,
    wallMs,
    sessionId: fields.sessionId,
    runId: fields.runId,
    outcome: fields.outcome,
    rounds: fields.rounds,
    acceptancePassed: fields.acceptancePassed,
    completed: !timedOut && isCompleted(fields),
    toolCalls: counts.toolCalls,
    toolErrors: counts.toolErrors,
    malformedToolCalls: counts.malformed,
    harnessAdaptations: counts.adaptations,
    errorEvents: counts.errors,
    jsonParseError,
    stderrTail: stderr.trim().split('\n').slice(-8).join('\n'),
  };

  // Failed workspaces are always kept for post-mortem (`git diff` against
  // the fixture baseline shows exactly what the agent did); successful
  // ones are reclaimed unless --keep-workspaces.
  if (result.completed && !KEEP_WORKSPACES) {
    await fs.rm(workspace, { recursive: true, force: true });
  } else {
    log(`workspace kept: ${workspace}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

async function preflight(): Promise<boolean> {
  log(`preflight: 1-round sanity run on ${PROVIDER}/${MODEL}…`);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-eval-preflight-'));
  try {
    const { exitCode, stdout, stderr } = await runPush(
      [
        'run',
        '--json',
        '--provider',
        PROVIDER,
        '--model',
        MODEL,
        '--max-rounds',
        '2',
        '--task',
        'Reply with the single word: ok. Do not call any tools.',
      ],
      dir,
      120_000,
    );
    const { parsed } = parseCliJsonOutput(stdout);
    const fields = extractCliRunFields(parsed);
    if (fields.outcome === 'success' || fields.outcome === 'max_rounds') return true;
    log(`preflight failed (exit ${exitCode}, outcome ${fields.outcome}).`);
    log(`stderr tail:\n${stderr.trim().split('\n').slice(-6).join('\n')}`);
    return false;
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Cache-bypass assertion (#1554): two identical tiny calls through the same
 * URL/auth/headers the CLI transports will use; a `cf-aig-cache-status: HIT`
 * on the repeat means eval outputs would be edge replays, not model output —
 * abort before burning a suite. Provider config resolves exactly the way the
 * spawned CLI resolves it (config file hydrated into env, lazy env getters).
 */
async function cacheBypassPreflight(): Promise<boolean> {
  try {
    applyConfigToEnv(await loadConfig());
  } catch {
    // No config file — env-only setups are valid; the getters read env.
  }
  const providerId = redirectDeprecatedProvider(PROVIDER) ?? PROVIDER;
  const providerConfig = PROVIDER_CONFIGS[providerId];
  if (!providerConfig) {
    log(`cache preflight: unknown provider "${providerId}" — skipped (sanity run gates this).`);
    return true;
  }
  let apiKey = '';
  try {
    apiKey = resolveApiKey(providerConfig);
  } catch {
    // Keyless is legitimate on gateway BYOK routes — probe without auth.
  }
  const plan = buildCacheProbePlan({
    id: providerConfig.id,
    url: providerConfig.url,
    streamShape: providerConfig.streamShape,
    apiKey,
    model: MODEL,
  });
  if ('skip' in plan) {
    log(`cache preflight: skipped — ${plan.skip}.`);
    return true;
  }
  const call = async () => {
    const res = await fetch(plan.request.url, {
      method: 'POST',
      headers: plan.request.headers,
      body: plan.request.body,
      signal: AbortSignal.timeout(30_000),
    });
    const cacheStatus = res.headers.get('cf-aig-cache-status');
    await res.text().catch(() => '');
    return { status: res.status, cacheStatus };
  };
  try {
    const first = await call();
    // The gateway's cache write is async: a back-to-back repeat can land
    // inside the propagation window and read MISS even when caching is live
    // (verified against push-gate 2026-07-23 — immediate repeat MISSed, the
    // same body 5s later HIT). Space the probe past the window or a poisoned
    // transport passes preflight and still replays mid-suite.
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const second = await call();
    const verdict = evaluateCacheProbe(second.cacheStatus);
    log(
      `cache preflight: first=${first.status}/${first.cacheStatus ?? 'no-cache-header'} ` +
        `second=${second.status}/${second.cacheStatus ?? 'no-cache-header'} — ${verdict.reason}`,
    );
    return verdict.ok;
  } catch (err) {
    // The sanity run already proved the provider reachable; a probe-only
    // failure (dialect quirk, timeout) is inconclusive, not a cache verdict.
    log(
      `cache preflight: probe error (${err instanceof Error ? err.message : String(err)}) — inconclusive, continuing.`,
    );
    return true;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const problems = validateTasks(EVAL_TASKS);
  if (problems.length > 0) {
    for (const p of problems) log(`manifest problem: ${p}`);
    return 2;
  }

  if (values.list) {
    for (const t of EVAL_TASKS) {
      process.stdout.write(`${t.id}\t${t.title}\n`);
    }
    return 0;
  }

  try {
    await fs.access(PUSH_BIN, fsConstants.X_OK);
  } catch {
    log(`error: ${PUSH_BIN} not found or not executable.`);
    return 2;
  }

  const filter = values.tasks
    ? new Set(
        values.tasks
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;
  const tasks = filter ? EVAL_TASKS.filter((t) => filter.has(t.id)) : EVAL_TASKS;
  if (filter) {
    const known = new Set(EVAL_TASKS.map((t) => t.id));
    for (const id of filter) {
      if (!known.has(id)) log(`warning: unknown task id "${id}" (see --list)`);
    }
  }
  if (tasks.length === 0) {
    log('no tasks selected.');
    return 2;
  }

  if (!values['skip-preflight']) {
    const ok = await preflight();
    if (!ok) {
      log('aborting: provider sanity check failed — fix the key/provider before burning a suite.');
      return 1;
    }
    const cacheOk = await cacheBypassPreflight();
    if (!cacheOk) {
      log(
        'aborting: response-cache replay detected — every repeated prompt would score a cached copy, not the model (#1554).',
      );
      return 1;
    }
  }

  await fs.mkdir(RESULTS_DIR, { recursive: true });
  const startedAtIso = new Date().toISOString();
  const stamp = startedAtIso.replace(/[:.]/g, '-');
  const jsonlPath = path.join(RESULTS_DIR, `${stamp}.jsonl`);
  const mdPath = path.join(RESULTS_DIR, `${stamp}.md`);

  const meta = {
    provider: PROVIDER,
    model: MODEL,
    delegate: DELEGATE,
    trialsPerTask: TRIALS,
    label: LABEL,
    startedAtIso,
  };
  // Header line first so a partial (interrupted) JSONL is still
  // self-describing.
  await fs.appendFile(jsonlPath, `${JSON.stringify({ kind: 'meta', ...meta })}\n`, 'utf8');

  const results: TrialResult[] = [];
  const total = tasks.length * TRIALS;
  let n = 0;
  for (const task of tasks) {
    for (let trial = 1; trial <= TRIALS; trial++) {
      n++;
      log(`(${n}/${total}) ${task.id} trial ${trial}…`);
      const result = await runTrial(task, trial);
      results.push(result);
      await fs.appendFile(jsonlPath, `${JSON.stringify({ kind: 'trial', ...result })}\n`, 'utf8');
      log(
        `(${n}/${total}) ${task.id}: ${result.completed ? 'PASS' : `FAIL (${result.outcome})`} · ` +
          `rounds ${result.rounds ?? '—'} · ${fmtMs(result.wallMs)} · ` +
          `tool errors ${result.toolErrors}/${result.toolCalls}`,
      );
    }
  }

  const summary = summarizeTrials(results);
  const markdown = buildMarkdownSummary(meta, results, summary);
  await fs.writeFile(mdPath, `${markdown}\n`, 'utf8');

  process.stdout.write(`\n${markdown}\n`);
  log(`results: ${jsonlPath}`);
  log(`summary: ${mdPath}`);

  // The harness measures; it doesn't judge. Exit non-zero only when the
  // measurement itself is unusable (every trial's JSON was unparsable).
  const allUnparsable = results.every((r) => r.jsonParseError !== null);
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
