import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runAssistantLoop } from '../engine.ts';
import { appendUserMessageWithFileReferences } from '../file-references.ts';
import { PROVIDER_CONFIGS } from '../provider.ts';
import {
  loadSessionEvents,
  loadSessionState,
  makeSessionId,
  saveSessionState,
} from '../session-store.ts';
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
    sessionName: 'Engine flow test',
    workingMemory: makeWorkingMemory(),
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Summarize the current state.' },
    ],
    ...overrides,
  };
}

async function withTempSessionDir(run) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-engine-flow-'));
  const previous = process.env.PUSH_SESSION_DIR;
  process.env.PUSH_SESSION_DIR = tmpDir;
  try {
    return await run(tmpDir);
  } finally {
    if (previous === undefined) delete process.env.PUSH_SESSION_DIR;
    else process.env.PUSH_SESSION_DIR = previous;
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function startSequencedProviderServer(plans) {
  let requestCount = 0;
  const requests = [];

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      let parsedBody = null;
      if (body) {
        parsedBody = JSON.parse(body);
      }
      requests.push(parsedBody);

      const plan = plans[Math.min(requestCount, plans.length - 1)] || {};
      requestCount += 1;

      if (typeof plan.afterRequest === 'function') {
        await plan.afterRequest({ requestCount, parsedBody });
      }

      if (plan.hang) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        const cleanup = () => {
          try {
            res.end();
          } catch {
            // socket already closed
          }
        };
        res.on('close', cleanup);
        return;
      }

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
      // `holdMs` keeps the stream open AFTER tokens are sent and BEFORE
      // [DONE]. Used by the mid-stream abort test to fire
      // controller.abort() while the client is still consuming the
      // response. Writes during/after a client-side abort may throw on
      // a closed socket — same shape the `hang: true` cleanup already
      // tolerates.
      if (typeof plan.holdMs === 'number' && plan.holdMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, plan.holdMs));
      }
      try {
        res.write('data: [DONE]\n\n');
        res.end();
      } catch {
        // socket already closed (client aborted)
      }
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

describe('runAssistantLoop flow characterization — success outcome', needsLoopback, () => {
  it('returns success with the streamed text and emits a success run_complete envelope', async () => {
    await withTempSessionDir(async (sessionDir) => {
      const server = await startSequencedProviderServer([
        { tokens: ['Investigation complete. The auth flow uses JWT.'] },
      ]);
      try {
        const providerConfig = makeProviderConfig(server.url);
        const state = makeState(sessionDir);
        const emitted = [];

        const result = await runAssistantLoop(state, providerConfig, 'mock-key', 5, {
          emit: (event) => emitted.push(event),
        });

        assert.deepEqual(result, {
          outcome: 'success',
          finalAssistantText: 'Investigation complete. The auth flow uses JWT.',
          rounds: 1,
          runId: result.runId,
        });
        assert.deepEqual(state.messages, [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Summarize the current state.' },
          { role: 'assistant', content: 'Investigation complete. The auth flow uses JWT.' },
        ]);
        assert.equal(state.rounds, 1);
        assert.equal(state.eventSeq, 4);
        assert.deepEqual(
          emitted.map((event) => event.type),
          [
            'assistant.turn_start',
            'assistant_token',
            'assistant_done',
            'assistant.turn_end',
            'run_complete',
          ],
        );
        assert.deepEqual(emitted.at(-1), {
          type: 'run_complete',
          payload: {
            outcome: 'success',
            summary: 'Investigation complete. The auth flow uses JWT.',
          },
          runId: result.runId,
          sessionId: state.sessionId,
        });

        const events = await loadSessionEvents(state.sessionId);
        assert.deepEqual(
          events.map((event) => ({
            seq: event.seq,
            type: event.type,
            payload: event.payload,
          })),
          [
            { seq: 1, type: 'assistant.turn_start', payload: { round: 0 } },
            {
              seq: 2,
              type: 'assistant_done',
              payload: { messageId: events[1].payload.messageId },
            },
            { seq: 3, type: 'assistant.turn_end', payload: { round: 0, outcome: 'completed' } },
            {
              seq: 4,
              type: 'run_complete',
              payload: {
                runId: result.runId,
                outcome: 'success',
                summary: 'Investigation complete. The auth flow uses JWT.',
              },
            },
          ],
        );
      } finally {
        await server.stop();
      }
    });
  });
});

describe('runAssistantLoop flow characterization — max_rounds outcome', needsLoopback, () => {
  it('finalizes after the round cap and returns the synthesized summary', async () => {
    await withTempSessionDir(async (sessionDir) => {
      const server = await startSequencedProviderServer([
        {
          tokens: [
            '{"tool":"coder_update_state","args":{"plan":"Check resume state","currentPhase":"investigation"}}',
          ],
        },
        { tokens: ['Final summary after the round cap.'] },
      ]);
      try {
        const providerConfig = makeProviderConfig(server.url);
        const state = makeState(sessionDir);
        const emitted = [];

        const result = await runAssistantLoop(state, providerConfig, 'mock-key', 1, {
          emit: (event) => emitted.push(event),
        });

        assert.deepEqual(result, {
          outcome: 'max_rounds',
          finalAssistantText: 'Final summary after the round cap.',
          rounds: 1,
          runId: result.runId,
        });
        assert.equal(state.rounds, 1);
        assert.equal(state.eventSeq, 7);
        assert.deepEqual(state.messages, [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Summarize the current state.' },
          {
            role: 'assistant',
            content:
              '{"tool":"coder_update_state","args":{"plan":"Check resume state","currentPhase":"investigation"}}',
          },
          {
            role: 'user',
            content: state.messages[3].content,
          },
          {
            role: 'user',
            content: state.messages[4].content,
          },
          { role: 'assistant', content: 'Final summary after the round cap.' },
        ]);
        assert.match(state.messages[3].content, /\[TOOL_RESULT\]/);
        assert.match(state.messages[4].content, /\[MAX_ROUNDS_REACHED\]/);
        assert.deepEqual(emitted.at(-1), {
          type: 'run_complete',
          payload: { outcome: 'max_rounds', summary: 'Final summary after the round cap.' },
          runId: result.runId,
          sessionId: state.sessionId,
        });

        const events = await loadSessionEvents(state.sessionId);
        assert.deepEqual(
          events.map((event) => ({
            seq: event.seq,
            type: event.type,
            payload: event.payload,
          })),
          [
            { seq: 1, type: 'assistant.turn_start', payload: { round: 0 } },
            {
              seq: 2,
              type: 'assistant_done',
              payload: { messageId: events[1].payload.messageId },
            },
            {
              seq: 3,
              type: 'working_memory_updated',
              payload: { keys: Object.keys(state.workingMemory) },
            },
            { seq: 4, type: 'assistant.turn_end', payload: { round: 0, outcome: 'continued' } },
            {
              seq: 5,
              type: 'warning',
              payload: {
                code: 'MAX_ROUNDS_REACHED',
                message:
                  'Reached max rounds (1). Tools used: none. Asking the assistant for a final no-tool summary.',
              },
            },
            {
              seq: 6,
              type: 'assistant_done',
              payload: { messageId: events[5].payload.messageId },
            },
            {
              seq: 7,
              type: 'run_complete',
              payload: {
                runId: result.runId,
                outcome: 'max_rounds',
                summary: 'Final summary after the round cap.',
              },
            },
          ],
        );
      } finally {
        await server.stop();
      }
    });
  });
});

describe('runAssistantLoop flow characterization — error outcome', needsLoopback, () => {
  it('halts on consecutive drift rounds and records a failed run_complete envelope', async () => {
    await withTempSessionDir(async (sessionDir) => {
      const driftText = 'drft'.repeat(60);
      const server = await startSequencedProviderServer([
        { tokens: [driftText] },
        { tokens: [driftText] },
      ]);
      try {
        const providerConfig = makeProviderConfig(server.url);
        const state = makeState(sessionDir);
        const emitted = [];

        const result = await runAssistantLoop(state, providerConfig, 'mock-key', 5, {
          emit: (event) => emitted.push(event),
        });

        const haltSummary =
          '[Stopped — cognitive drift detected for 2 consecutive rounds. ' +
          'Repeated token pattern: "drft" ×60. Task may be incomplete.]';
        assert.deepEqual(result, {
          outcome: 'error',
          finalAssistantText: haltSummary,
          rounds: 2,
          runId: result.runId,
        });
        assert.equal(state.rounds, 2);
        assert.equal(state.eventSeq, 4);
        assert.deepEqual(state.messages, [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Summarize the current state.' },
          { role: 'assistant', content: driftText },
          { role: 'user', content: state.messages[3].content },
          { role: 'assistant', content: driftText },
        ]);
        assert.match(state.messages[3].content, /\[POLICY: DRIFT_DETECTED\]/);
        assert.deepEqual(emitted.at(-1), {
          type: 'run_complete',
          payload: { outcome: 'failed', summary: haltSummary },
          runId: result.runId,
          sessionId: state.sessionId,
        });

        const events = await loadSessionEvents(state.sessionId);
        assert.deepEqual(
          events.map((event) => ({
            seq: event.seq,
            type: event.type,
            payload: event.payload,
          })),
          [
            { seq: 1, type: 'assistant.turn_start', payload: { round: 0 } },
            { seq: 2, type: 'assistant.turn_start', payload: { round: 1 } },
            { seq: 3, type: 'assistant.turn_end', payload: { round: 1, outcome: 'error' } },
            {
              seq: 4,
              type: 'run_complete',
              payload: {
                runId: result.runId,
                outcome: 'failed',
                summary: haltSummary,
              },
            },
          ],
        );
      } finally {
        await server.stop();
      }
    });
  });
});

describe('runAssistantLoop flow characterization — aborted outcome', needsLoopback, () => {
  it('returns Aborted. and emits an aborted run_complete envelope when the signal is already aborted', async () => {
    await withTempSessionDir(async (sessionDir) => {
      const controller = new AbortController();
      controller.abort();
      const providerConfig = makeProviderConfig('http://127.0.0.1:9/v1/chat/completions');
      const state = makeState(sessionDir);
      const emitted = [];

      const result = await runAssistantLoop(state, providerConfig, 'mock-key', 5, {
        signal: controller.signal,
        emit: (event) => emitted.push(event),
      });

      assert.deepEqual(result, {
        outcome: 'aborted',
        finalAssistantText: 'Aborted.',
        rounds: 0,
        runId: result.runId,
      });
      assert.equal(state.rounds, 0);
      assert.equal(state.eventSeq, 2);
      assert.deepEqual(state.messages, [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Summarize the current state.' },
      ]);
      assert.deepEqual(
        emitted.map((event) => ({ type: event.type, payload: event.payload })),
        [
          { type: 'assistant.turn_end', payload: { round: 0, outcome: 'aborted' } },
          { type: 'run_complete', payload: { outcome: 'aborted', summary: 'Aborted by user.' } },
        ],
      );

      const events = await loadSessionEvents(state.sessionId);
      assert.deepEqual(
        events.map((event) => ({
          seq: event.seq,
          type: event.type,
          payload: event.payload,
        })),
        [
          { seq: 1, type: 'assistant.turn_end', payload: { round: 0, outcome: 'aborted' } },
          {
            seq: 2,
            type: 'run_complete',
            payload: {
              runId: result.runId,
              outcome: 'aborted',
              summary: 'Aborted by user.',
            },
          },
        ],
      );
    });
  });

  it('does not persist a partial assistant message when abort fires mid-stream', async () => {
    // Cancellation invariant follow-up (Hermes #6) — CLI / TUI surface.
    // The pre-aborted-signal case above pins the trivial path
    // (signal.aborted === true at entry). This test pins the realistic
    // shape: tokens are streaming, the user hits Ctrl+C (which fires
    // controller.abort()), and the engine drops the partial without
    // persisting it as an assistant turn in state.messages or the
    // session journal.
    //
    // Engine wiring relied on: the assistant message push at
    // cli/engine.ts:1311 runs AFTER `streamCompletion` resolves
    // successfully. If streamCompletion throws AbortError mid-stream
    // (catch at line 1264), the push is skipped — only the
    // assistant.turn_end + run_complete events with outcome 'aborted'
    // land in the journal.
    await withTempSessionDir(async (sessionDir) => {
      // `holdMs` keeps the SSE stream open after the tokens are sent,
      // so the client is still reading when the test fires abort.
      // 500ms is generous — typical CI sees the test resolve in
      // ~100ms of the abort call.
      const server = await startSequencedProviderServer([
        { tokens: ['Looking', ' at the', ' code'], holdMs: 500 },
      ]);
      try {
        const controller = new AbortController();
        const providerConfig = makeProviderConfig(server.url);
        const state = makeState(sessionDir);
        const emitted = [];

        // Start the loop without awaiting — gives us a handle to fire
        // abort mid-stream.
        const loopPromise = runAssistantLoop(state, providerConfig, 'mock-key', 5, {
          signal: controller.signal,
          emit: (event) => emitted.push(event),
        });

        // Wait long enough for the first SSE tokens to arrive at the
        // client. 100ms is comfortably more than the provider stream
        // round-trip on loopback; less than `holdMs` so we abort
        // before [DONE].
        await new Promise((resolve) => setTimeout(resolve, 100));
        controller.abort();

        const result = await loopPromise;

        // The invariant: outcome is 'aborted' and no rounds completed.
        assert.equal(result.outcome, 'aborted');
        assert.equal(result.finalAssistantText, 'Aborted.');
        assert.equal(result.rounds, 0);
        assert.equal(state.rounds, 0);

        // Load-bearing: state.messages stays [system, user]. No
        // partial assistant entry, no matter how many tokens streamed
        // before the abort. If this fails, cli/engine.ts somehow
        // pushed an assistant message in the abort path — a real
        // bug.
        assert.deepEqual(state.messages, [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Summarize the current state.' },
        ]);

        // Journal contains the structural lifecycle events for the
        // aborted turn — no assistant_token persistence, no replay-
        // worthy assistant content. The dispatched assistant_token
        // events fire to the emit callback (for live UI), but
        // persisted events stay structural. Pre-aborted-signal case
        // above skips `turn_start` because the early-exit fires
        // before the round body opens; mid-stream abort comes after
        // `turn_start` already landed, so the journal has the full
        // pair plus run_complete.
        const events = await loadSessionEvents(state.sessionId);
        const persistedTypes = events.map((event) => event.type);
        assert.deepEqual(persistedTypes, [
          'assistant.turn_start',
          'assistant.turn_end',
          'run_complete',
        ]);
        const turnEnd = events.find((event) => event.type === 'assistant.turn_end');
        assert.equal(turnEnd?.payload?.outcome, 'aborted');
        const runComplete = events.find((event) => event.type === 'run_complete');
        assert.equal(runComplete?.payload?.outcome, 'aborted');
        assert.equal(runComplete?.payload?.summary, 'Aborted by user.');

        // Emitted (live) events match the persisted journal for the
        // structural lifecycle events. Token events may also have
        // emitted before the abort — that's fine; they're not
        // persisted and won't affect a resend.
        const emittedStructural = emitted
          .map((event) => event.type)
          .filter(
            (type) =>
              type === 'assistant.turn_start' ||
              type === 'assistant.turn_end' ||
              type === 'run_complete',
          );
        assert.deepEqual(emittedStructural, [
          'assistant.turn_start',
          'assistant.turn_end',
          'run_complete',
        ]);
      } finally {
        await server.stop();
      }
    });
  });

  it('starts the next runAssistantLoop cleanly after a mid-stream abort', async () => {
    // Producer-side continuation of the test above: after an aborted
    // turn, a second runAssistantLoop call must complete normally
    // and not inherit any partial state from the cancelled turn. The
    // engine's invariant (only-push-on-success at cli/engine.ts:1311)
    // makes this trivially true today, but a regression that started
    // pushing a placeholder on abort would surface here as a wrong
    // round count or stale prefix in the next request body.
    await withTempSessionDir(async (sessionDir) => {
      const server = await startSequencedProviderServer([
        { tokens: ['First, partial'], holdMs: 500 },
        { tokens: ['Done.'] },
      ]);
      try {
        const controller = new AbortController();
        const providerConfig = makeProviderConfig(server.url);
        const state = makeState(sessionDir);

        // Turn 1: abort mid-stream.
        const firstPromise = runAssistantLoop(state, providerConfig, 'mock-key', 5, {
          signal: controller.signal,
          emit: () => {},
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        controller.abort();
        const firstResult = await firstPromise;
        assert.equal(firstResult.outcome, 'aborted');

        // Turn 2: fresh controller, clean run. The state still has
        // only [system, user] from turn 1's invariant.
        const freshController = new AbortController();
        const secondResult = await runAssistantLoop(state, providerConfig, 'mock-key', 5, {
          signal: freshController.signal,
          emit: () => {},
        });

        assert.equal(secondResult.outcome, 'success');
        assert.equal(state.rounds, 1);
        // After the successful round, state.messages includes the
        // assistant turn with content 'Done.' — and the aborted
        // partial 'First, partial' is nowhere in it.
        const assistantMessages = state.messages.filter((m) => m.role === 'assistant');
        assert.equal(assistantMessages.length, 1);
        assert.equal(assistantMessages[0].content, 'Done.');
        assert.ok(!assistantMessages[0].content.includes('First, partial'));

        // The provider received exactly one user message in the second
        // request body — the original one. No leaked assistant prefix
        // from the aborted turn.
        assert.equal(server.requests.length, 2);
        const secondRequestMessages = server.requests[1]?.messages ?? [];
        const secondRequestAssistants = secondRequestMessages.filter((m) => m.role === 'assistant');
        assert.equal(secondRequestAssistants.length, 0);
      } finally {
        await server.stop();
      }
    });
  });
});

describe(
  'runAssistantLoop flow characterization — save/load/continue round-trip',
  needsLoopback,
  () => {
    it('persists messages, rounds, eventSeq, and workingMemory across save-load and resumes from the next round', async () => {
      await withTempSessionDir(async (sessionDir) => {
        await fs.writeFile(path.join(sessionDir, 'README.md'), 'alpha\nbeta\n', 'utf8');

        const server = await startSequencedProviderServer([
          { tokens: ['First resumed answer.'] },
          { tokens: ['Second resumed answer.'] },
        ]);
        try {
          const providerConfig = makeProviderConfig(server.url);
          const state = makeState(sessionDir, {
            workingMemory: makeWorkingMemory({
              plan: 'Resume this conversation',
              currentPhase: 'investigation',
              openTasks: ['review README'],
              filesTouched: ['README.md'],
            }),
            messages: [{ role: 'system', content: 'You are a helpful assistant.' }],
          });

          const appendInfo = await appendUserMessageWithFileReferences(
            state,
            'Please inspect @README.md:1-2 before answering.',
            sessionDir,
          );
          assert.deepEqual(appendInfo, {
            message: appendInfo.message,
            parsedCount: 1,
            resolvedCount: 1,
            errorCount: 0,
            skippedCount: 0,
          });

          const firstRun = await runAssistantLoop(state, providerConfig, 'mock-key', 5);
          assert.deepEqual(firstRun, {
            outcome: 'success',
            finalAssistantText: 'First resumed answer.',
            rounds: 1,
            runId: firstRun.runId,
          });
          assert.equal(state.rounds, 1);
          assert.equal(state.eventSeq, 4);
          await saveSessionState(state);

          const loaded = await loadSessionState(state.sessionId);
          assert.deepEqual(loaded.messages, state.messages);
          assert.equal(loaded.rounds, 1);
          assert.equal(loaded.eventSeq, 4);
          assert.deepEqual(loaded.workingMemory, state.workingMemory);

          loaded.messages.push({ role: 'user', content: 'Now summarize what you found.' });

          const secondRun = await runAssistantLoop(loaded, providerConfig, 'mock-key', 5);
          assert.deepEqual(secondRun, {
            outcome: 'success',
            finalAssistantText: 'Second resumed answer.',
            rounds: 1,
            runId: secondRun.runId,
          });
          assert.equal(loaded.rounds, 2);
          assert.equal(loaded.eventSeq, 8);
          assert.deepEqual(loaded.messages, [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Please inspect @README.md:1-2 before answering.' },
            { role: 'user', content: loaded.messages[2].content },
            { role: 'assistant', content: 'First resumed answer.' },
            { role: 'user', content: 'Now summarize what you found.' },
            { role: 'assistant', content: 'Second resumed answer.' },
          ]);
          assert.match(loaded.messages[2].content, /\[REFERENCED_FILES\]/);
        } finally {
          await server.stop();
        }
      });
    });
  },
);

describe(
  'runAssistantLoop flow characterization — empty-success finalization',
  needsLoopback,
  () => {
    it('runs finalization when the model exits empty and returns the synthesized summary', async () => {
      await withTempSessionDir(async (sessionDir) => {
        const server = await startSequencedProviderServer([
          { tokens: [] },
          { tokens: ['Self-contained final summary.'] },
        ]);
        try {
          const providerConfig = makeProviderConfig(server.url);
          const state = makeState(sessionDir);
          const emitted = [];

          const result = await runAssistantLoop(state, providerConfig, 'mock-key', 5, {
            emit: (event) => emitted.push(event),
          });

          assert.deepEqual(result, {
            outcome: 'success',
            finalAssistantText: 'Self-contained final summary.',
            rounds: 1,
            runId: result.runId,
          });
          assert.equal(server.requests.length, 2);
          assert.equal(state.rounds, 1);
          assert.equal(state.eventSeq, 5);
          assert.deepEqual(state.messages, [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Summarize the current state.' },
            { role: 'assistant', content: '' },
            { role: 'user', content: state.messages[3].content },
            { role: 'assistant', content: 'Self-contained final summary.' },
          ]);
          assert.match(state.messages[3].content, /\[FINAL_SUMMARY_REQUEST\]/);
          assert.deepEqual(emitted.at(-1), {
            type: 'run_complete',
            payload: { outcome: 'success', summary: 'Self-contained final summary.' },
            runId: result.runId,
            sessionId: state.sessionId,
          });
        } finally {
          await server.stop();
        }
      });
    });

    it('rolls back the orphaned finalization prompt when finalization throws', async () => {
      await withTempSessionDir(async (sessionDir) => {
        const providerConfig = makeProviderConfig('http://127.0.0.1:9/v1/chat/completions');
        const server = await startSequencedProviderServer([
          {
            tokens: [],
            afterRequest: () => {
              providerConfig.url = 'http://127.0.0.1:9/v1/chat/completions';
            },
          },
        ]);
        try {
          providerConfig.url = server.url;
          const state = makeState(sessionDir);
          const emitted = [];

          const result = await runAssistantLoop(state, providerConfig, 'mock-key', 5, {
            emit: (event) => emitted.push(event),
          });

          assert.deepEqual(result, {
            outcome: 'success',
            finalAssistantText: '',
            rounds: 1,
            runId: result.runId,
          });
          assert.equal(state.rounds, 1);
          assert.equal(state.eventSeq, 5);
          assert.deepEqual(state.messages, [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Summarize the current state.' },
            { role: 'assistant', content: '' },
          ]);
          assert.deepEqual(
            emitted
              .filter((event) => event.type === 'warning' || event.type === 'run_complete')
              .map((event) => ({ type: event.type, payload: event.payload })),
            [
              {
                type: 'warning',
                payload: {
                  code: 'EMPTY_SUCCESS_FINALIZATION_FAILED',
                  message: 'Could not get final summary after empty success: fetch failed',
                },
              },
              { type: 'run_complete', payload: { outcome: 'success', summary: '' } },
            ],
          );

          const events = await loadSessionEvents(state.sessionId);
          assert.deepEqual(
            events.map((event) => ({
              seq: event.seq,
              type: event.type,
              payload: event.payload,
            })),
            [
              { seq: 1, type: 'assistant.turn_start', payload: { round: 0 } },
              {
                seq: 2,
                type: 'assistant_done',
                payload: { messageId: events[1].payload.messageId },
              },
              {
                seq: 3,
                type: 'warning',
                payload: {
                  code: 'EMPTY_SUCCESS_FINALIZATION_FAILED',
                  message: 'fetch failed',
                  retryable: true,
                },
              },
              { seq: 4, type: 'assistant.turn_end', payload: { round: 0, outcome: 'completed' } },
              {
                seq: 5,
                type: 'run_complete',
                payload: {
                  runId: result.runId,
                  outcome: 'success',
                  summary: '',
                },
              },
            ],
          );
        } finally {
          await server.stop();
        }
      });
    });
  },
);
