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
  countSessionEvents,
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
