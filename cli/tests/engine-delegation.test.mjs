// Integration test for `runAssistantTurn` delegation wiring. Asserts that a
// multi-feature planner response routes through the task-graph subsystem and
// emits the canonical `subagent.*` / `task_graph.*` event envelopes
// consumed by `cli/tui-delegation-events.ts`.
//
// The fallback case (null / 1-feature plan → single-agent loop) is
// characterized by `engine-flow.test.mjs`; here we only pin the delegation
// event sequence so the TUI's observer contract stays honored.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runAssistantTurn } from '../engine.ts';
import { PROVIDER_CONFIGS } from '../provider.ts';
import { loadSessionEvents, makeSessionId } from '../session-store.ts';
import { canListenOnLoopback } from './test-environment.mjs';

const loopbackAvailable = await canListenOnLoopback();
const needsLoopback = {
  skip: !loopbackAvailable && 'loopback HTTP listeners are unavailable in this sandbox',
};

function makeWorkingMemory(overrides = {}) {
  return {
    plan: '',
    currentPhase: '',
    openTasks: [],
    filesTouched: [],
    assumptions: [],
    errorsEncountered: [],
    ...overrides,
  };
}

function makeState(cwd, overrides = {}) {
  return {
    sessionId: makeSessionId(),
    createdAt: 1_712_345_600_000,
    updatedAt: 1_712_345_600_000,
    provider: 'ollama',
    model: 'mock-model',
    cwd,
    rounds: 0,
    eventSeq: 0,
    sessionName: 'Engine delegation test',
    workingMemory: makeWorkingMemory(),
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Inspect cli/provider.ts and worker-providers.ts' },
    ],
    ...overrides,
  };
}

async function withTempSessionDir(run) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-engine-delegation-'));
  const prevSession = process.env.PUSH_SESSION_DIR;
  const prevMemory = process.env.PUSH_MEMORY_DIR;
  process.env.PUSH_SESSION_DIR = tmpDir;
  process.env.PUSH_MEMORY_DIR = path.join(tmpDir, 'memory');
  try {
    return await run(tmpDir);
  } finally {
    if (prevSession === undefined) delete process.env.PUSH_SESSION_DIR;
    else process.env.PUSH_SESSION_DIR = prevSession;
    if (prevMemory === undefined) delete process.env.PUSH_MEMORY_DIR;
    else process.env.PUSH_MEMORY_DIR = prevMemory;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// Minimal sequenced mock of the OpenAI-compatible streaming provider.
// Request 1 is the planner; subsequent requests are per-node Coder runs.
async function startSequencedProviderServer(plans) {
  let requestCount = 0;
  const requests = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      let parsedBody = null;
      if (body) parsedBody = JSON.parse(body);
      requests.push(parsedBody);

      const plan = plans[Math.min(requestCount, plans.length - 1)] || {};
      requestCount += 1;

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });

      for (const token of plan.tokens || []) {
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: token } }],
          })}\n\n`,
        );
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind sequenced provider server');
  }

  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    requests,
    async stop() {
      await new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve(undefined));
      });
    },
  };
}

function makeProviderConfig(url) {
  return {
    ...PROVIDER_CONFIGS.ollama,
    url,
  };
}

describe('runAssistantTurn — multi-feature delegation event sequence', needsLoopback, () => {
  it('emits canonical subagent.* and task_graph.* envelopes for a 2-feature plan', async () => {
    await withTempSessionDir(async (sessionDir) => {
      // Planner returns a 2-feature plan; each Coder node returns a one-line
      // final message via a no-tool response (runAssistantLoop treats that as
      // outcome=success).
      const plannerPayload = JSON.stringify({
        approach: 'Inspect each file and compare',
        features: [
          {
            id: 'inspect-cli-provider',
            description: 'Read cli/provider.ts and note provider URLs.',
            files: ['cli/provider.ts'],
          },
          {
            id: 'inspect-worker-providers',
            description: 'Read app/src/worker/worker-providers.ts and note URLs.',
            files: ['app/src/worker/worker-providers.ts'],
            dependsOn: ['inspect-cli-provider'],
          },
        ],
      });

      const server = await startSequencedProviderServer([
        { tokens: [plannerPayload] },
        { tokens: ['Inspected cli/provider.ts. URLs look consistent.'] },
        { tokens: ['Inspected worker-providers.ts. URLs look consistent.'] },
      ]);

      try {
        const providerConfig = makeProviderConfig(server.url);
        const state = makeState(sessionDir);
        const emitted = [];

        const result = await runAssistantTurn(
          state,
          providerConfig,
          'mock-key',
          'Inspect cli/provider.ts and worker-providers.ts',
          5,
          {
            emit: (event) => emitted.push(event),
          },
        );

        assert.equal(result.outcome, 'success');
        assert.ok(result.finalAssistantText.includes('Delegation complete'));

        const eventTypes = emitted.map((e) => e.type);

        // Planner lifecycle envelopes fire first.
        assert.ok(
          eventTypes.includes('subagent.started'),
          `missing subagent.started (got ${eventTypes.join(', ')})`,
        );
        assert.ok(eventTypes.includes('subagent.completed'), 'missing subagent.completed');

        // Canonical task_graph.* envelopes must appear for each node, in
        // lifecycle order: ready → started → completed.
        for (const taskId of ['inspect-cli-provider', 'inspect-worker-providers']) {
          const ready = emitted.find(
            (e) => e.type === 'task_graph.task_ready' && e.payload?.taskId === taskId,
          );
          const started = emitted.find(
            (e) => e.type === 'task_graph.task_started' && e.payload?.taskId === taskId,
          );
          const completed = emitted.find(
            (e) => e.type === 'task_graph.task_completed' && e.payload?.taskId === taskId,
          );
          assert.ok(ready, `missing task_graph.task_ready for ${taskId}`);
          assert.ok(started, `missing task_graph.task_started for ${taskId}`);
          assert.ok(completed, `missing task_graph.task_completed for ${taskId}`);
          assert.equal(ready.payload.agent, 'coder');

          // Copilot review: `detail` on task_ready/started must be compact —
          // the raw node.task contains a long "Ground your answer…" preamble
          // that would flood the transcript if passed through verbatim.
          assert.ok(
            (ready.payload.detail?.length ?? 0) <= 120,
            `task_ready.detail too long (${ready.payload.detail?.length}) for ${taskId}`,
          );
          assert.ok(
            !ready.payload.detail?.includes('Ground your answer'),
            `task_ready.detail leaked preamble for ${taskId}`,
          );
        }

        // Graph-level completion envelope.
        const graphCompleted = emitted.find((e) => e.type === 'task_graph.graph_completed');
        assert.ok(graphCompleted, 'missing task_graph.graph_completed');
        assert.equal(graphCompleted.payload.success, true);
        assert.equal(graphCompleted.payload.nodeCount, 2);

        // Task-graph subagent envelope pair (wrapping the graph execution).
        const taskGraphStarted = emitted.find(
          (e) => e.type === 'subagent.started' && e.payload?.agent === 'task_graph',
        );
        const taskGraphCompleted = emitted.find(
          (e) => e.type === 'subagent.completed' && e.payload?.agent === 'task_graph',
        );
        assert.ok(taskGraphStarted, 'missing subagent.started agent=task_graph');
        assert.ok(taskGraphCompleted, 'missing subagent.completed agent=task_graph');

        // Copilot review: runId must be stable across the whole turn, so
        // event-log consumers can correlate planner subagent events with
        // the task-graph lifecycle as one user turn.
        const runIds = new Set(emitted.map((e) => e.runId).filter(Boolean));
        assert.equal(runIds.size, 1, `events split across runIds: ${[...runIds].join(', ')}`);

        // Final assistant turn closure: assistant_done then run_complete so
        // the TUI flushes the synthesized summary and flips runState=idle.
        assert.ok(eventTypes.includes('assistant_done'), 'missing assistant_done');
        assert.equal(
          eventTypes.at(-1),
          'run_complete',
          'run_complete should be the final envelope',
        );

        // Codex P2 review: the session event log must contain exactly one
        // `run_complete` per delegated turn. Per-node runAssistantLoop runs
        // pass suppressRunComplete=true so the parent wrapper owns the
        // authoritative record; aggregateStats would otherwise overcount
        // runs for delegated sessions.
        const persisted = await loadSessionEvents(state.sessionId);
        const runCompletes = persisted.filter((e) => e.type === 'run_complete');
        assert.equal(
          runCompletes.length,
          1,
          `expected 1 persisted run_complete, got ${runCompletes.length}`,
        );
        assert.equal(runCompletes[0].payload.outcome, 'success');
      } finally {
        await server.stop();
      }
    });
  });
});

describe(
  'runAssistantTurn — single-feature plan falls back to runAssistantLoop',
  needsLoopback,
  () => {
    it('does not emit task_graph.* events when the planner returns 1 feature', async () => {
      await withTempSessionDir(async (sessionDir) => {
        const plannerPayload = JSON.stringify({
          approach: 'One-liner task',
          features: [{ id: 'single', description: 'Do the thing.' }],
        });

        const server = await startSequencedProviderServer([
          { tokens: [plannerPayload] },
          { tokens: ['Single-agent reply to the user.'] },
        ]);

        try {
          const providerConfig = makeProviderConfig(server.url);
          const state = makeState(sessionDir);
          const emitted = [];

          const result = await runAssistantTurn(
            state,
            providerConfig,
            'mock-key',
            'Simple follow-up',
            5,
            {
              emit: (event) => emitted.push(event),
            },
          );

          assert.equal(result.outcome, 'success');
          assert.equal(result.finalAssistantText, 'Single-agent reply to the user.');

          const eventTypes = emitted.map((e) => e.type);

          // Planner envelopes still fire — the planner itself runs.
          assert.ok(eventTypes.includes('subagent.started'));
          assert.ok(eventTypes.includes('subagent.completed'));

          // But no task_graph.* envelopes: single-feature falls back so the
          // transcript matches a normal single-agent run.
          assert.ok(
            !eventTypes.some((t) => t.startsWith('task_graph.')),
            `task_graph.* emitted on single-feature plan (got ${eventTypes.join(', ')})`,
          );

          // runAssistantLoop's normal closure envelopes still fire.
          assert.ok(eventTypes.includes('run_complete'));
        } finally {
          await server.stop();
        }
      });
    });
  },
);
