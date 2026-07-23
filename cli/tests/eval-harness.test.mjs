/**
 * Agent eval harness — manifest validity + scoring-contract tests.
 *
 * The harness itself (scripts/eval/run-evals.ts) spawns live agent runs
 * and is not CI-exercised; these tests pin the parts that must not drift
 * silently: the task manifest stays well-formed (unique ids, scoreable
 * acceptance, shell-safe quoting), the fixture acceptance commands
 * actually pass against a solved fixture (so a task can't ship
 * unsatisfiable), and the scoring helpers classify CLI output the way
 * `push run --json` emits it.
 */

import { strict as assert } from 'node:assert';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';

import {
  buildCacheProbePlan,
  countSessionEvents,
  evaluateCacheProbe,
  extractCliRunFields,
  isCompleted,
  median,
  parseCliJsonOutput,
  summarizeTrials,
  validateTasks,
} from '../../scripts/eval/eval-lib.ts';
import { EVAL_TASKS } from '../../scripts/eval/tasks.ts';
import { runCommandInResolvedShellSync } from '../shell.ts';

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

test('manifest is valid and in the 10–20 task band', () => {
  assert.deepEqual(validateTasks(EVAL_TASKS), []);
  assert.ok(
    EVAL_TASKS.length >= 10 && EVAL_TASKS.length <= 20,
    `expected 10–20 tasks, got ${EVAL_TASKS.length}`,
  );
});

test('validateTasks flags duplicates, missing acceptance, and bad quoting', () => {
  const sol = { 'a.js': 'y' };
  const problems = validateTasks([
    {
      id: 'dup',
      title: 'a',
      prompt: 'p',
      files: { 'a.js': 'x' },
      accept: ["node -e 'ok'"],
      solution: sol,
    },
    { id: 'dup', title: 'b', prompt: 'p', files: { 'a.js': 'x' }, accept: [], solution: {} },
    {
      id: 'Bad_Case',
      title: 'c',
      prompt: ' ',
      files: {},
      accept: ["node -e 'unbalanced"],
      solution: sol,
    },
    {
      id: 'esc',
      title: 'd',
      prompt: 'p',
      files: { '../escape.js': 'x' },
      accept: ['true'],
      solution: sol,
    },
  ]);
  assert.ok(problems.some((p) => p.includes('duplicate task id')));
  assert.ok(problems.some((p) => p.includes('no acceptance commands')));
  assert.ok(problems.some((p) => p.includes('no reference solution')));
  assert.ok(problems.some((p) => p.includes('not kebab-case')));
  assert.ok(problems.some((p) => p.includes('empty prompt')));
  assert.ok(problems.some((p) => p.includes('unbalanced single quotes')));
  assert.ok(problems.some((p) => p.includes('must be relative')));
});

// ---------------------------------------------------------------------------
// Fixture acceptance commands are real shell commands that fail on the
// UNSOLVED fixture for at least one check (otherwise the task scores as
// complete with zero agent work) — sampled per task by running them in a
// materialized workspace.
// ---------------------------------------------------------------------------

function materialize(task, { solved = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), `eval-manifest-${task.id}-`));
  const layers = solved ? [task.files, task.solution] : [task.files];
  for (const layer of layers) {
    for (const [rel, content] of Object.entries(layer)) {
      const abs = path.join(dir, rel);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content, 'utf8');
    }
  }
  return dir;
}

async function runAccept(cmd, cwd) {
  // Scrub the test-runner context before spawning acceptance commands:
  //  - NODE_OPTIONS carries the tsx loader that runs this file, which
  //    changes how a spawned `node --test` resolves modules;
  //  - NODE_TEST_CONTEXT (child-v8) makes a spawned `node --test` believe
  //    it's a child test shard and exit 0 without running anything.
  // Production acceptance runs (runAcceptanceChecks) never execute under
  // a test runner, so the scrubbed env is the representative one.
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  delete env.NODE_TEST_CONTEXT;
  // Resolve the shell the way production does. A bare `shell: true` is `cmd.exe`
  // on Windows, which does not treat `'` as a quote character — so the
  // POSIX-quoted `node -e '...'` payloads in the manifest reach node as the
  // literal token `'const` and die on "Unterminated string constant". The
  // manifest documents that these commands are shell-executed via
  // `runCommandInResolvedShell`; run them that way here too.
  return runCommandInResolvedShellSync(cmd, { cwd, env });
}

test('every task has at least one acceptance check that fails on the unsolved fixture', async () => {
  for (const task of EVAL_TASKS) {
    const dir = materialize(task);
    try {
      let anyFails = false;
      for (const cmd of task.accept) {
        if ((await runAccept(cmd, dir)).status !== 0) {
          anyFails = true;
          break;
        }
      }
      assert.ok(
        anyFails,
        `task "${task.id}": all acceptance checks already pass on the unsolved fixture`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('every acceptance check passes on the solved fixture (tasks are satisfiable)', async () => {
  for (const task of EVAL_TASKS) {
    const dir = materialize(task, { solved: true });
    try {
      for (const cmd of task.accept) {
        const res = await runAccept(cmd, dir);
        assert.equal(
          res.status,
          0,
          `task "${task.id}": acceptance failed on the reference solution: ${cmd}\n` +
            `${res.stdout}\n${res.stderr}`,
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ---------------------------------------------------------------------------
// CLI output parsing + scoring
// ---------------------------------------------------------------------------

function runtimeEvent(type, payload, index, overrides = {}) {
  return {
    v: 'push.runtime.v1',
    kind: 'event',
    sessionId: 'sess_eval',
    runId: 'run_eval',
    seq: index + 1,
    ts: 1_000 + index,
    type,
    payload,
    ...overrides,
  };
}

test('parseCliJsonOutput tolerates prose before the JSON object', () => {
  const clean = parseCliJsonOutput('{"sessionId":"s1","outcome":"success","rounds":3}');
  assert.equal(clean.error, null);

  const noisy = parseCliJsonOutput(
    'Task complete.\nSummary text{"sessionId":"s2","outcome":"success","rounds":4}',
  );
  assert.equal(noisy.error, null);
  assert.equal(extractCliRunFields(noisy.parsed).sessionId, 's2');

  assert.notEqual(parseCliJsonOutput('no json here').error, null);
  assert.notEqual(parseCliJsonOutput('').error, null);
});

test('extractCliRunFields reads both plain and delegated round counters', () => {
  const plain = extractCliRunFields({
    sessionId: 's',
    runId: 'r',
    outcome: 'success',
    rounds: 5,
    acceptance: { passed: true, checks: [] },
  });
  assert.equal(plain.rounds, 5);
  assert.equal(plain.acceptancePassed, true);
  assert.ok(isCompleted(plain));

  const delegated = extractCliRunFields({ outcome: 'success', totalRounds: 9, rounds: 2 });
  assert.equal(delegated.rounds, 9);

  const failed = extractCliRunFields({
    outcome: 'success',
    rounds: 2,
    acceptance: { passed: false, checks: [] },
  });
  assert.ok(!isCompleted(failed), 'acceptance failure must not score as completed');

  const errored = extractCliRunFields({ outcome: 'error' });
  assert.ok(!isCompleted(errored));
  // No acceptance block (the delegated path emits none): completion
  // requires positive evidence, so this must NOT score as completed —
  // the runner re-verifies via runHarnessAcceptance instead.
  const noAcceptance = extractCliRunFields({ outcome: 'success', rounds: 1 });
  assert.equal(noAcceptance.acceptancePassed, null);
  assert.ok(!isCompleted(noAcceptance));
});

test('countSessionEvents tallies tool calls, errors, and regression signals', () => {
  const counts = countSessionEvents([
    runtimeEvent('tool.execution_complete', { toolName: 'read_file', isError: false }, 0),
    runtimeEvent('tool.execution_complete', { toolName: 'exec', isError: true }, 1),
    runtimeEvent('tool.execution_complete', { toolName: 'write_file', isError: false }, 2),
    runtimeEvent('tool.call_malformed', { round: 1, reason: 'bad json', preview: '{nope' }, 3),
    runtimeEvent(
      'harness.adaptation',
      { round: 1, fromMaxRounds: 50, toMaxRounds: 40, reasons: ['looping'] },
      4,
    ),
    runtimeEvent('error', { message: 'provider failed' }, 5),
    runtimeEvent('assistant.turn_end', { round: 1, outcome: 'error' }, 6),
  ]);
  assert.deepEqual(counts, {
    toolCalls: 3,
    toolErrors: 1,
    malformed: 1,
    adaptations: 1,
    errors: 1,
  });
});

test('countSessionEvents isolates the selected run in a shared session journal', () => {
  const events = [
    runtimeEvent('tool.execution_complete', { toolName: 'exec', isError: true }, 0, {
      runId: 'run_old',
    }),
    runtimeEvent('tool.execution_complete', { toolName: 'read_file', isError: false }, 1, {
      runId: 'run_target',
    }),
  ];

  assert.deepEqual(countSessionEvents(events, { runId: 'run_target' }), {
    toolCalls: 1,
    toolErrors: 0,
    malformed: 0,
    adaptations: 0,
    errors: 0,
  });
});

test('summarizeTrials computes completion rate, medians, and tool-error rate', () => {
  const base = {
    exitCode: 0,
    sessionId: 's',
    runId: 'r',
    acceptancePassed: true,
    malformedToolCalls: 0,
    harnessAdaptations: 0,
    errorEvents: 0,
    jsonParseError: null,
    stderrTail: '',
  };
  const summary = summarizeTrials([
    {
      ...base,
      taskId: 'a',
      trial: 1,
      outcome: 'success',
      completed: true,
      rounds: 3,
      wallMs: 10_000,
      toolCalls: 8,
      toolErrors: 1,
    },
    {
      ...base,
      taskId: 'b',
      trial: 1,
      outcome: 'max_rounds',
      completed: false,
      rounds: 14,
      wallMs: 60_000,
      toolCalls: 12,
      toolErrors: 3,
    },
  ]);
  assert.equal(summary.trials, 2);
  assert.equal(summary.completedTrials, 1);
  assert.equal(summary.completionRate, 0.5);
  assert.equal(summary.medianRounds, Math.round((3 + 14) / 2));
  assert.equal(summary.medianWallMs, 35_000);
  assert.equal(summary.toolErrorRate, 4 / 20);

  assert.equal(median([]), null);
  assert.equal(median([7]), 7);
  assert.equal(median([1, 2, 3]), 2);
});

// ─── cache-bypass preflight (#1554) ──────────────────────────────────────

test('buildCacheProbePlan mirrors the transport: bypass header on gateway routes only', () => {
  const gateway = buildCacheProbePlan({
    id: 'zen',
    url: 'https://gateway.ai.cloudflare.com/v1/acct/push-gate/zen/api/paas/v4/chat/completions',
    apiKey: 'k',
    model: 'glm-5.1',
  });
  assert.ok('request' in gateway);
  assert.equal(gateway.request.headers['cf-aig-skip-cache'], 'true');
  assert.equal(gateway.request.headers.Authorization, 'Bearer k');

  const direct = buildCacheProbePlan({
    id: 'zen',
    url: 'https://api.z.ai/api/paas/v4/chat/completions',
    apiKey: 'k',
    model: 'glm-5.1',
  });
  assert.ok('request' in direct);
  assert.equal(direct.request.headers['cf-aig-skip-cache'], undefined);
});

test('buildCacheProbePlan sends identical bodies across calls and omits auth when keyless', () => {
  const build = () =>
    buildCacheProbePlan({
      id: 'zen',
      url: 'https://gateway.ai.cloudflare.com/v1/acct/push-gate/zen/v1/chat/completions',
      apiKey: '',
      model: 'glm-5.1',
    });
  const a = build();
  const b = build();
  assert.ok('request' in a && 'request' in b);
  // The whole point of the probe: the second request must be byte-identical.
  assert.equal(a.request.body, b.request.body);
  assert.equal(a.request.headers.Authorization, undefined);
  const body = JSON.parse(a.request.body);
  assert.equal(body.model, 'glm-5.1');
  assert.equal(body.stream, false);
});

test('buildCacheProbePlan speaks each dialect', () => {
  const anthropic = buildCacheProbePlan({
    id: 'anthropic',
    url: 'https://gateway.ai.cloudflare.com/v1/acct/push-gate/anthropic/v1/messages',
    streamShape: 'anthropic',
    apiKey: 'sk',
    model: 'claude-sonnet-4-6',
  });
  assert.ok('request' in anthropic);
  assert.equal(anthropic.request.headers['x-api-key'], 'sk');
  assert.equal(anthropic.request.headers['anthropic-version'], '2023-06-01');
  assert.equal(JSON.parse(anthropic.request.body).max_tokens, 16);

  const responses = buildCacheProbePlan({
    id: 'openai',
    url: 'https://gateway.ai.cloudflare.com/v1/acct/push-gate/openai/responses',
    streamShape: 'openai-responses',
    apiKey: 'k',
    model: 'gpt-5.4',
  });
  assert.ok('request' in responses);
  assert.equal(JSON.parse(responses.request.body).max_output_tokens, 16);

  const gemini = buildCacheProbePlan({
    id: 'google',
    url: 'https://gateway.ai.cloudflare.com/v1/acct/push-gate/google-ai-studio/v1beta',
    streamShape: 'gemini',
    apiKey: 'AIza',
    model: 'gemini-3.1-pro-preview',
  });
  assert.ok('request' in gemini);
  assert.match(gemini.request.url, /:streamGenerateContent/);
  assert.equal(gemini.request.headers['x-goog-api-key'], 'AIza');
  // The model rides the URL for gemini, so the header check keys off the
  // final upstream URL, not the base.
  assert.equal(gemini.request.headers['cf-aig-skip-cache'], 'true');
});

test('buildCacheProbePlan skips openrouter only on its direct host', () => {
  const direct = buildCacheProbePlan({
    id: 'openrouter',
    url: 'https://openrouter.ai/api/v1',
    streamShape: 'openai-responses',
    apiKey: 'k',
    model: 'anthropic/claude-haiku-4.5',
  });
  assert.ok('skip' in direct);
  assert.match(direct.skip, /openrouter/);

  // A gateway-pinned OpenRouter URL (profile/env override) gets the strict
  // probe on the chat wire, not the skip — the production transports send
  // the bypass on it, so the preflight must assert it (fugu, #1581).
  const gateway = buildCacheProbePlan({
    id: 'openrouter',
    url: 'https://gateway.ai.cloudflare.com/v1/acct/push-gate/openrouter/api/v1/responses',
    streamShape: 'openai-responses',
    apiKey: 'k',
    model: 'anthropic/claude-haiku-4.5',
  });
  assert.ok('request' in gateway);
  assert.equal(gateway.request.gatewayRoute, true);
  assert.match(gateway.request.url, /\/chat\/completions$/);
  assert.equal(gateway.request.headers['cf-aig-skip-cache'], 'true');
  const body = JSON.parse(gateway.request.body);
  assert.ok(Array.isArray(body.messages));
  assert.equal(body.max_tokens, 16);
});

function probePair(
  secondCacheStatus,
  { gatewayRoute = false, first = 200, second = 200, firstCacheStatus = null } = {},
) {
  return {
    gatewayRoute,
    first: { status: first, cacheStatus: firstCacheStatus },
    second: { status: second, cacheStatus: secondCacheStatus },
  };
}

test('evaluateCacheProbe fails on a verified replay on any route', () => {
  assert.equal(evaluateCacheProbe(probePair('HIT')).ok, false);
  assert.equal(evaluateCacheProbe(probePair('hit')).ok, false);
  assert.equal(evaluateCacheProbe(probePair('HIT', { gatewayRoute: true })).ok, false);
  // A HIT outranks the status gate — even an error pair with a HIT fails as
  // a replay, not as an unclean probe.
  assert.equal(evaluateCacheProbe(probePair('HIT', { first: 500, second: 500 })).ok, false);
  assert.match(evaluateCacheProbe(probePair('HIT')).reason, /1554/);
  // A FIRST-call HIT is replay evidence too: the constant probe body can hit
  // an entry seeded by an earlier preflight (aborted-run re-run), and that
  // entry can expire before the delayed second call — HIT/MISS must not pass.
  assert.equal(evaluateCacheProbe(probePair('MISS', { firstCacheStatus: 'HIT' })).ok, false);
  assert.equal(
    evaluateCacheProbe(probePair('BYPASS', { gatewayRoute: true, firstCacheStatus: 'hit' })).ok,
    false,
  );
  assert.match(
    evaluateCacheProbe(probePair('MISS', { firstCacheStatus: 'HIT' })).reason,
    /first call/,
  );
});

test('evaluateCacheProbe is strict on detected gateway routes', () => {
  const gw = { gatewayRoute: true };
  assert.equal(evaluateCacheProbe(probePair('MISS', gw)).ok, true);
  assert.equal(evaluateCacheProbe(probePair('BYPASS', gw)).ok, true);
  // Unverified is failure where verification was possible: a missing header
  // or an unclean status pair aborts instead of passing as inconclusive.
  assert.equal(evaluateCacheProbe(probePair(null, gw)).ok, false);
  assert.match(evaluateCacheProbe(probePair(null, gw)).reason, /unverified/);
  assert.equal(
    evaluateCacheProbe(probePair('MISS', { gatewayRoute: true, second: 429 })).ok,
    false,
  );
  assert.equal(
    evaluateCacheProbe(probePair(null, { gatewayRoute: true, first: 401, second: 401 })).ok,
    false,
  );
});

test('evaluateCacheProbe stays lenient off gateway routes', () => {
  assert.equal(evaluateCacheProbe(probePair('MISS')).ok, true);
  assert.equal(evaluateCacheProbe(probePair(null)).ok, true);
  assert.equal(evaluateCacheProbe(probePair('')).ok, true);
  // Direct providers carry no gateway header and may 4xx on the hand-built
  // probe; neither is replay evidence, so the suite proceeds (with a caveat
  // in the reason, not a silent pass).
  const errPair = evaluateCacheProbe(probePair(null, { first: 404, second: 404 }));
  assert.equal(errPair.ok, true);
  assert.match(errPair.reason, /404/);
});

test('buildCacheProbePlan stamps gatewayRoute from the final probe URL', () => {
  const gateway = buildCacheProbePlan({
    id: 'zen',
    url: 'https://gateway.ai.cloudflare.com/v1/acct/push-gate/zen/v1/chat/completions',
    apiKey: 'k',
    model: 'glm-5.1',
  });
  assert.ok('request' in gateway);
  assert.equal(gateway.request.gatewayRoute, true);

  const direct = buildCacheProbePlan({
    id: 'zen',
    url: 'https://api.z.ai/api/paas/v4/chat/completions',
    apiKey: 'k',
    model: 'glm-5.1',
  });
  assert.ok('request' in direct);
  assert.equal(direct.request.gatewayRoute, false);

  // Gemini's model rides the URL — the stamp comes off the FINAL upstream
  // URL, same as its header check.
  const gemini = buildCacheProbePlan({
    id: 'google',
    url: 'https://gateway.ai.cloudflare.com/v1/acct/push-gate/google-ai-studio/v1beta',
    streamShape: 'gemini',
    apiKey: 'AIza',
    model: 'gemini-3.1-pro-preview',
  });
  assert.ok('request' in gemini);
  assert.equal(gemini.request.gatewayRoute, true);
});
