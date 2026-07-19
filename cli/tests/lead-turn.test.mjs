// Integration tests for the lead-kernel lane (cli/lead-turn.ts) — §10 step 2.
//
// Pins that the lane runs the terminal turn as a `leadMode: true` run
// of the shared coder kernel: the lead identity reaches the provider (not the
// CLI engine's local identity, not the delegated Coder implementer prompt),
// tools round-trip through the real `executeToolCall` against the workspace,
// and the lane speaks the engine's existing event vocabulary so the TUI /
// daemon clients render it unchanged. Routing pins live at the
// `runAssistantTurn` seam: the kernel lane is the only lane (the CLI-local
// engine-loop opt-out was retired once the lane baked).

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  runLeadKernelTurn,
  buildLeadReasoningReplaySeed,
  buildLeadTurnPreamble,
  resolveDefaultExecMode,
  wrapCliDetectAllToolCalls,
} from '../lead-turn.ts';
import {
  LEAD_EXPLORER_DELEGATION_PROTOCOL,
  LEAD_MAX_PARALLEL_EXPLORERS,
} from '../lead-explorer.ts';
import { getCliNativeToolSchemas } from '../tool-function-schemas.ts';
import { roleCanUseTool } from '../../lib/capabilities.ts';
import { buildHandoffBlock } from '../../lib/llm-compaction.ts';
import { runAssistantTurn } from '../engine.ts';
import { PROVIDER_CONFIGS } from '../provider.ts';
import { loadSessionEvents, loadSessionState, makeSessionId } from '../session-store.ts';
import { canListenOnLoopback } from './test-environment.mjs';

const loopbackAvailable = await canListenOnLoopback();
const needsLoopback = {
  skip: !loopbackAvailable && 'loopback HTTP listeners are unavailable in this sandbox',
};

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
    sessionName: 'Lead-turn test',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'What does notes.txt say?' },
    ],
    ...overrides,
  };
}

async function withTempWorkspace(run) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-lead-turn-'));
  const prevSession = process.env.PUSH_SESSION_DIR;
  const prevMemory = process.env.PUSH_MEMORY_DIR;
  process.env.PUSH_SESSION_DIR = path.join(tmpDir, 'sessions');
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

async function loadSessionEventsEventually(sessionId, predicate) {
  let events = [];
  for (let i = 0; i < 20; i++) {
    events = await loadSessionEvents(sessionId);
    if (predicate(events)) return events;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return events;
}

// Sequenced mock of the OpenAI-compatible streaming provider — one scripted
// response per request, with captured request bodies for prompt assertions.
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

      for (const token of plan.reasoningTokens || []) {
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { reasoning_content: token } }],
          })}\n\n`,
        );
      }
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

describe('wrapCliDetectAllToolCalls — malformed signal (Rule 1 source)', () => {
  it('maps CLI parser malformations into droppedCandidates for kernel recovery', () => {
    const detected = wrapCliDetectAllToolCalls(
      '```json\n{"tool": "read_file", "args": {oops}}\n```',
    );

    assert.equal(detected.droppedCandidates.length, 1);
    // Name is intentionally blank: feeding a CLI-local name (e.g. read_file)
    // into the kernel's shared hint builder resolves to the wrong (GitHub)
    // tool, so we drop it and let the kernel emit its generic envelope hint.
    assert.equal(detected.droppedCandidates[0].rawToolName, '');
    assert.equal(detected.droppedCandidates[0].resolvedToolName, null);
    assert.match(detected.droppedCandidates[0].sample, /read_file/);
  });

  it('leaves droppedCandidates empty for a clean tool call', () => {
    const detected = wrapCliDetectAllToolCalls(
      '```json\n{"tool": "read_file", "args": {"path": "a"}}\n```',
    );

    assert.equal(detected.droppedCandidates.length, 0);
    assert.equal(detected.readOnly.length, 1);
  });
});

describe('runLeadKernelTurn — leadMode run of the shared kernel', needsLoopback, () => {
  it('sends the lead identity and commits the kernel summary as the assistant turn', async () => {
    await withTempWorkspace(async (cwd) => {
      const server = await startSequencedProviderServer([{ tokens: ['Direct kernel reply.'] }]);

      try {
        const providerConfig = makeProviderConfig(server.url);
        const state = makeState(cwd);
        const emitted = [];

        const result = await runLeadKernelTurn(
          state,
          providerConfig,
          'mock-key',
          'What does notes.txt say?',
          5,
          { emit: (event) => emitted.push(event) },
        );

        assert.equal(result.outcome, 'success');
        assert.ok(result.finalAssistantText.includes('Direct kernel reply.'));

        // The kernel's lead framing reached the provider — not the CLI
        // engine's local identity, not the delegated implementer prompt.
        const requestText = JSON.stringify(server.requests[0]);
        assert.ok(
          requestText.includes(
            'You are `mock-model`, served via Ollama. You are the lead in this chat',
          ),
          'lead identity missing from provider request',
        );
        assert.ok(
          !requestText.includes('You are the Coder agent'),
          'delegated Coder identity leaked into a lead turn',
        );
        assert.ok(
          !requestText.includes('coding assistant running in a local workspace'),
          'CLI engine identity leaked into a kernel-lane turn',
        );

        // The user turn rides the task preamble.
        assert.ok(requestText.includes('Task: What does notes.txt say?'));

        // The turn is committed to the session transcript.
        const lastMessage = state.messages[state.messages.length - 1];
        assert.equal(lastMessage.role, 'assistant');
        assert.ok(lastMessage.content.includes('Direct kernel reply.'));

        // Engine event vocabulary only — streaming, commit, completion.
        const eventTypes = emitted.map((e) => e.type);
        assert.ok(eventTypes.includes('assistant_token'));
        assert.ok(eventTypes.includes('assistant_done'));
        const runComplete = emitted.find((e) => e.type === 'run_complete');
        assert.ok(runComplete);
        assert.equal(runComplete.payload.outcome, 'success');
        assert.ok(
          !eventTypes.some((t) => t.startsWith('subagent.') || t.startsWith('task_graph.')),
          `org-chart envelopes emitted by the lead lane (got ${eventTypes.join(', ')})`,
        );
      } finally {
        await server.stop();
      }
    });
  });

  it('persists plain reasoning and replays it at the serializer boundary after resume (#1537)', async () => {
    await withTempWorkspace(async (cwd) => {
      const reasoning = 'first line of thought\nsecond line with exact spacing';
      const server = await startSequencedProviderServer([
        { reasoningTokens: [reasoning], tokens: ['Two plus two is four.'] },
        { tokens: ['I said that two plus two is four.'] },
      ]);

      try {
        // A reasoning-replay route (`kimi` always replays `reasoning_content`);
        // the route gate below only promotes the structured seed for these.
        const providerConfig = { ...PROVIDER_CONFIGS.kimi, url: server.url };
        const state = makeState(cwd, {
          provider: 'kimi',
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'What is two plus two?' },
          ],
        });

        await runLeadKernelTurn(state, providerConfig, 'mock-key', 'What is two plus two?', 5, {
          emit: () => {},
        });

        const resumed = await loadSessionState(state.sessionId);
        const persistedAssistant = resumed.messages.find(
          (message) =>
            message?.role === 'assistant' && message?.content === 'Two plus two is four.',
        );
        assert.ok(persistedAssistant, 'first assistant turn was not persisted');
        assert.equal(persistedAssistant.reasoningContent, reasoning);

        resumed.messages.push({ role: 'user', content: 'What did you just say?' });
        await runLeadKernelTurn(resumed, providerConfig, 'mock-key', 'What did you just say?', 5, {
          emit: () => {},
        });

        assert.equal(server.requests.length, 2);
        const replayRequest = server.requests[1];
        const replayedAssistant = replayRequest.messages.find(
          (message) => message.role === 'assistant' && message.content === 'Two plus two is four.',
        );
        assert.ok(replayedAssistant, 'resumed assistant turn did not reach the provider body');
        assert.equal(replayedAssistant.reasoning_content, reasoning);
        assert.ok(
          replayRequest.messages.some(
            (message) =>
              message.role === 'user' && message.content.includes('Task: What did you just say?'),
          ),
          'current task preamble missing from resumed request',
        );
        assert.ok(
          !JSON.stringify(replayRequest).includes('Prior conversation in this chat'),
          'structured replay duplicated the same history inside the text preamble',
        );
      } finally {
        await server.stop();
      }
    });
  });

  it('does NOT structurally replay reasoning on a route that does not want it (#1537 review)', async () => {
    await withTempWorkspace(async (cwd) => {
      const reasoning = 'thoughts that must not reach a non-reasoning route';
      const server = await startSequencedProviderServer([
        { reasoningTokens: [reasoning], tokens: ['Two plus two is four.'] },
        { tokens: ['I said that two plus two is four.'] },
      ]);

      try {
        // `ollama`/`mock-model` is not a reasoning-replay route — the reasoning is
        // still persisted, but the resumed turn must fall back to the text
        // preamble rather than replaying `reasoning_content` to a route that
        // never asked for it.
        const providerConfig = makeProviderConfig(server.url);
        const state = makeState(cwd, {
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'What is two plus two?' },
          ],
        });

        await runLeadKernelTurn(state, providerConfig, 'mock-key', 'What is two plus two?', 5, {
          emit: () => {},
        });

        const resumed = await loadSessionState(state.sessionId);
        const persistedAssistant = resumed.messages.find(
          (message) =>
            message?.role === 'assistant' && message?.content === 'Two plus two is four.',
        );
        // Persistence still happens regardless of route — only replay is gated.
        assert.equal(persistedAssistant?.reasoningContent, reasoning);

        resumed.messages.push({ role: 'user', content: 'What did you just say?' });
        await runLeadKernelTurn(resumed, providerConfig, 'mock-key', 'What did you just say?', 5, {
          emit: () => {},
        });

        const replayRequest = server.requests[1];
        assert.ok(
          !replayRequest.messages.some((message) => message.reasoning_content),
          'reasoning_content leaked to a non-replay route',
        );
        // Falls back to the text preamble, so prior history rides there instead.
        assert.ok(
          JSON.stringify(replayRequest).includes('Prior conversation in this chat'),
          'non-replay route should use the text preamble history path',
        );
      } finally {
        await server.stop();
      }
    });
  });

  it('keeps the reasoning replay seed strictly role-alternating (#1537 review)', () => {
    // Prior window ends on a user turn (no assistant reply after "follow-up"),
    // and the appended taskPreamble is also a user message — without alternation
    // repair the seed sends `user, user` to a strict reasoner and 400s.
    const messages = [
      { role: 'user', content: 'What is two plus two?' },
      { role: 'assistant', content: 'Four.', reasoningContent: 'add the two twos' },
      { role: 'user', content: 'unanswered follow-up' },
      { role: 'user', content: 'current question' },
    ];
    const seed = buildLeadReasoningReplaySeed(
      'current question',
      messages,
      'Task: current question',
    );
    assert.ok(seed, 'seed should be built when prior reasoning exists');
    for (let i = 1; i < seed.length; i++) {
      assert.notEqual(
        seed[i].role,
        seed[i - 1].role,
        `consecutive ${seed[i].role} messages at ${i - 1}/${i}`,
      );
    }
    // The reasoning-bearing assistant turn survives normalization untouched.
    const assistant = seed.find((m) => m.role === 'assistant' && m.reasoningContent);
    assert.ok(assistant, 'assistant reasoning turn was dropped by normalization');
    assert.equal(assistant.reasoningContent, 'add the two twos');
  });

  it('keeps task-shaped lead turns on strict completion grounding', async () => {
    await withTempWorkspace(async (cwd) => {
      const server = await startSequencedProviderServer([
        { tokens: ['Recovered after adaptation.'] },
        { tokens: ['I modified the notes.txt file and verified the requested fix.'] },
      ]);

      try {
        const result = await runLeadKernelTurn(
          makeState(cwd),
          makeProviderConfig(server.url),
          'mock-key',
          'Fix notes.txt',
          5,
          { emit: () => {} },
        );

        assert.equal(result.outcome, 'success');
        assert.equal(server.requests.length, 2);
        assert.ok(JSON.stringify(server.requests[1]).includes('INCOMPLETE_COMPLETION'));
        assert.ok(result.finalAssistantText.includes('I modified the notes.txt'));
      } finally {
        await server.stop();
      }
    });
  });

  it('surfaces a max_rounds outcome when the round cap is hit (headless parity, #942)', async () => {
    await withTempWorkspace(async (cwd) => {
      // Round 0 emits a non-terminal state-update tool call so the kernel does
      // not complete; with maxRounds=1, round 1 hits the cap and stops. The
      // lane must report `max_rounds`, not flatten the graceful stop to success.
      const server = await startSequencedProviderServer([
        {
          tokens: [
            '{"tool":"coder_update_state","args":{"plan":"keep going","currentPhase":"investigation"}}',
          ],
        },
      ]);
      try {
        const providerConfig = makeProviderConfig(server.url);
        const state = makeState(cwd);
        const emitted = [];

        const result = await runLeadKernelTurn(
          state,
          providerConfig,
          'mock-key',
          'Do the thing',
          1,
          // Explicit cap → the adaptive harness is off, so round 1
          // deterministically hits the cap instead of growing past it.
          { emit: (event) => emitted.push(event), explicitMaxRounds: true },
        );

        assert.equal(result.outcome, 'max_rounds');
        const runComplete = emitted.find((e) => e.type === 'run_complete');
        assert.equal(runComplete.payload.outcome, 'max_rounds');
      } finally {
        await server.stop();
      }
    });
  });

  it('emits and persists harness.adaptation when adaptive max rounds changes', async () => {
    await withTempWorkspace(async (cwd) => {
      const malformedCall = '```json\n{"tool": "read_file", "args": {oops}}\n```';
      const server = await startSequencedProviderServer([
        { tokens: [malformedCall] },
        { tokens: [malformedCall] },
        { tokens: [malformedCall] },
        { tokens: ['I read the notes.txt file after recovery.'] },
      ]);

      try {
        const providerConfig = makeProviderConfig(server.url);
        const state = makeState(cwd);
        const emitted = [];

        const result = await runLeadKernelTurn(
          state,
          providerConfig,
          'mock-key',
          'Read notes.txt',
          30,
          { emit: (event) => emitted.push(event) },
        );

        assert.equal(result.outcome, 'success');
        assert.equal(server.requests.length, 4, 'expected three recovery rounds plus final answer');

        const emittedAdaptations = emitted.filter((e) => e.type === 'harness.adaptation');
        assert.equal(emittedAdaptations.length, 1);
        assert.deepEqual(emittedAdaptations[0].payload, {
          round: 3,
          fromMaxRounds: 30,
          toMaxRounds: 20,
          reasons: ['Reduce max rounds to 20: 3 malformed tool calls'],
        });

        const events = await loadSessionEventsEventually(state.sessionId, (loaded) =>
          loaded.some((event) => event.type === 'harness.adaptation'),
        );
        const persistedAdaptations = events.filter((event) => event.type === 'harness.adaptation');
        assert.equal(persistedAdaptations.length, 1);
        assert.deepEqual(persistedAdaptations[0].payload, emittedAdaptations[0].payload);
      } finally {
        await server.stop();
      }
    });
  });

  it('injects persisted workspace memory into the task preamble', async () => {
    await withTempWorkspace(async (cwd) => {
      // Same store the engine loop's `[MEMORY]` prompt section reads
      // (loadMemory). The default lane must not drop saved project
      // conventions — Codex P2 on PR #905.
      await fs.mkdir(path.join(cwd, '.push'), { recursive: true });
      await fs.writeFile(
        path.join(cwd, '.push', 'memory.md'),
        'Always run `npm run typecheck:tsgo` before committing.\n',
      );

      const server = await startSequencedProviderServer([{ tokens: ['Understood.'] }]);
      try {
        const providerConfig = makeProviderConfig(server.url);
        const state = makeState(cwd);

        const result = await runLeadKernelTurn(
          state,
          providerConfig,
          'mock-key',
          'What does notes.txt say?',
          5,
          { emit: () => {} },
        );

        assert.equal(result.outcome, 'success');
        const requestText = JSON.stringify(server.requests[0]);
        assert.ok(requestText.includes('[MEMORY]'), 'memory block missing from kernel-lane prompt');
        assert.ok(
          requestText.includes('Always run `npm run typecheck:tsgo` before committing.'),
          'persisted memory content did not reach the provider',
        );
      } finally {
        await server.stop();
      }
    });
  });

  it('loads the user-owned goal file after compaction and injects it near the task', async () => {
    await withTempWorkspace(async (cwd) => {
      await fs.mkdir(path.join(cwd, '.push'), { recursive: true });
      await fs.writeFile(
        path.join(cwd, '.push', 'goal.md'),
        '# Goal\n\n## Initial ask\n\nUnify the runtime.\n\n## Current working goal\n\nFinish phase 4.\n\n## Constraints\n\n- Keep shell storage local.\n\n## Do not\n\n- Add a hook framework.\n\n## Last refreshed\n\n2026-07-17T00:00:00.000Z\n',
      );
      const server = await startSequencedProviderServer([
        { tokens: ['The current working goal is to finish phase 4.'] },
      ]);
      try {
        const providerConfig = makeProviderConfig(server.url);
        const state = makeState(cwd, {
          messages: [
            { role: 'user', content: 'Unify the runtime.' },
            { role: 'user', content: buildHandoffBlock('Phases 1 through 3 are complete.') },
            { role: 'user', content: 'What is the current goal?' },
          ],
        });
        await runLeadKernelTurn(state, providerConfig, 'mock-key', 'What is the current goal?', 5, {
          emit: () => {},
        });
        const requestText = JSON.stringify(server.requests[0]);
        assert.ok(requestText.includes('[USER_GOAL]'));
        assert.ok(requestText.includes('Current working goal: Finish phase 4.'));
        assert.ok(requestText.includes('Do not: Add a hook framework.'));
        assert.ok(
          requestText.indexOf('[/USER_GOAL]') <
            requestText.indexOf('Task: What is the current goal?'),
        );
      } finally {
        await server.stop();
      }
    });
  });

  it('round-trips a read_file tool call through executeToolCall', async () => {
    await withTempWorkspace(async (cwd) => {
      await fs.writeFile(path.join(cwd, 'notes.txt'), 'hello from notes\n');

      const toolCall = JSON.stringify({ tool: 'read_file', args: { path: 'notes.txt' } });

      const server = await startSequencedProviderServer([
        // The opening brace arrives before the `tool` key is recognizable.
        // An append-only client must not receive that ambiguous byte.
        { tokens: ['{', toolCall.slice(1)] },
        { tokens: ['notes.txt says: hello from notes'] },
      ]);

      try {
        const providerConfig = makeProviderConfig(server.url);
        const state = makeState(cwd);
        const emitted = [];

        const result = await runLeadKernelTurn(
          state,
          providerConfig,
          'mock-key',
          'What does notes.txt say?',
          5,
          { emit: (event) => emitted.push(event) },
        );

        assert.equal(result.outcome, 'success');
        assert.ok(result.finalAssistantText.includes('hello from notes'));
        assert.equal(server.requests.length, 2, 'expected tool round + answer round');

        // The real file content flowed back into the kernel's next round.
        const secondRequest = JSON.stringify(server.requests[1]);
        assert.ok(
          secondRequest.includes('hello from notes'),
          'tool result missing from follow-up request',
        );

        // The synthesized start precedes the kernel's complete (Codex P2,
        // PR #904): the TUI creates the transcript tool entry + its
        // file-awareness args queue on start and only updates it on
        // the completion carrying the same stable execution id.
        const startIdx = emitted.findIndex((e) => e.type === 'tool.execution_start');
        const completeIdx = emitted.findIndex((e) => e.type === 'tool.execution_complete');
        assert.ok(startIdx >= 0, 'missing tool.execution_start event');
        assert.ok(completeIdx > startIdx, 'tool.execution_start must precede complete');
        const streamedBeforeTool = emitted
          .slice(0, startIdx)
          .filter((event) => event.type === 'assistant_token')
          .map((event) => event.payload.text)
          .join('');
        assert.equal(streamedBeforeTool, '');
        assert.equal(streamedBeforeTool.includes('{'), false, 'raw tool prefix leaked');
        const startEvent = emitted[startIdx];
        assert.equal(startEvent.payload.toolName, 'read_file');
        assert.deepEqual(startEvent.payload.args, { path: 'notes.txt' });

        // The kernel's tool event reaches the engine event stream.
        const toolEvent = emitted[completeIdx];
        assert.equal(toolEvent.payload.toolName, 'read_file');
        assert.equal(toolEvent.payload.isError, false);
        assert.equal(toolEvent.payload.executionId, startEvent.payload.executionId);
      } finally {
        await server.stop();
      }
    });
  });
});

function fencedCall(tool, args) {
  return `\`\`\`json\n${JSON.stringify({ tool, args })}\n\`\`\``;
}

describe('wrapCliDetectAllToolCalls — lead Explorer fan-out bucket', () => {
  it('keeps delegate_explorer in the trailing slot by default (delegated nodes unchanged)', () => {
    const detected = wrapCliDetectAllToolCalls(
      [
        fencedCall('read_file', { path: 'a.txt' }),
        fencedCall('delegate_explorer', { task: 'Trace flow A' }),
      ].join('\n'),
    );

    assert.equal(detected.readOnly.length, 1);
    assert.equal((detected.parallelDelegations ?? []).length, 0);
    assert.equal(detected.sideEffects[0]?.call.tool, 'delegate_explorer');
  });

  it('rides delegations alongside reads when the lead cap is enabled', () => {
    const detected = wrapCliDetectAllToolCalls(
      [
        fencedCall('delegate_explorer', { task: 'Trace flow A' }),
        fencedCall('read_file', { path: 'a.txt' }),
        fencedCall('delegate_explorer', { task: 'Trace flow B' }),
      ].join('\n'),
      { maxParallelDelegations: LEAD_MAX_PARALLEL_EXPLORERS },
    );

    assert.equal(detected.readOnly.length, 1);
    assert.equal(detected.parallelDelegations.length, 2);
    assert.deepEqual(detected.sideEffects, []);
    assert.equal(detected.extraMutations.length, 0);
  });

  it('rejects fan-out past the cap into extraMutations (no silent drop)', () => {
    const detected = wrapCliDetectAllToolCalls(
      [
        fencedCall('delegate_explorer', { task: 'A' }),
        fencedCall('delegate_explorer', { task: 'B' }),
        fencedCall('delegate_explorer', { task: 'C' }),
      ].join('\n'),
      { maxParallelDelegations: LEAD_MAX_PARALLEL_EXPLORERS },
    );

    assert.equal(detected.parallelDelegations.length, 2);
    assert.equal(detected.extraMutations.length, 1);
    assert.equal(detected.extraMutations[0].call.args.task, 'C');
  });

  it('treats a delegation after a mutation as an ordering violation', () => {
    const detected = wrapCliDetectAllToolCalls(
      [
        fencedCall('write_file', { path: 'a.txt', content: 'x' }),
        fencedCall('delegate_explorer', { task: 'A' }),
      ].join('\n'),
      { maxParallelDelegations: LEAD_MAX_PARALLEL_EXPLORERS },
    );

    assert.equal(detected.fileMutations.length, 1);
    assert.equal(detected.parallelDelegations.length, 0);
    assert.equal(detected.extraMutations.length, 1);
    assert.equal(detected.extraMutations[0].call.tool, 'delegate_explorer');
  });
});

describe('LEAD_EXPLORER_DELEGATION_PROTOCOL — advertise/executor drift pins', () => {
  it('parses into a native function schema from the same block the prompt advertises', () => {
    const schemas = getCliNativeToolSchemas({
      extraProtocolBlocks: [LEAD_EXPLORER_DELEGATION_PROTOCOL],
    });
    const schema = schemas.find((s) => s.name === 'delegate_explorer');
    assert.ok(schema, 'delegate_explorer schema missing from extraProtocolBlocks parse');
    assert.deepEqual(schema.input_schema.required, ['task']);
    assert.equal(schema.input_schema.properties.files.type, 'array');
    assert.equal(schema.input_schema.properties.knownContext.type, 'array');
  });

  it('is absent from the default schema set (delegated nodes advertise no delegation)', () => {
    const schemas = getCliNativeToolSchemas();
    assert.ok(!schemas.some((s) => s.name === 'delegate_explorer'));
  });

  it('matches the shared capability table: lead-capable coder yes, explorer no', () => {
    // The lead runs under the `coder` grant, which carries `delegate:explorer`
    // (lib/capabilities.ts). Explorer itself must NOT be able to fan out
    // further Explorers — the runner hands sub-runs the default detectors and
    // the capability gate refuses the call.
    assert.equal(roleCanUseTool('coder', 'delegate_explorer'), true);
    assert.equal(roleCanUseTool('explorer', 'delegate_explorer'), false);
  });

  it('states the fan-out cap it enforces', () => {
    assert.ok(
      LEAD_EXPLORER_DELEGATION_PROTOCOL.includes(
        `up to ${LEAD_MAX_PARALLEL_EXPLORERS} delegate_explorer calls`,
      ),
      'protocol text must state the cap the classifier enforces',
    );
  });
});

describe('runLeadKernelTurn — Explorer fan-out (§10 lead delegation arc)', needsLoopback, () => {
  it('fans out two Explorers in one turn and feeds their reports back to the lead', async () => {
    await withTempWorkspace(async (cwd) => {
      await fs.writeFile(path.join(cwd, 'notes.txt'), 'fan-out sentinel', 'utf8');
      const fanOut = [
        fencedCall('delegate_explorer', { task: 'Trace flow A', files: ['notes.txt'] }),
        fencedCall('delegate_explorer', { task: 'Trace flow B' }),
      ].join('\n');
      // Request order: lead round 1 → two concurrent Explorer runs (one
      // provider request each; interchangeable plans) → lead round 2.
      const server = await startSequencedProviderServer([
        { tokens: [fanOut] },
        { tokens: ['Findings: alpha beta'] },
        { tokens: ['Findings: alpha beta'] },
        { tokens: ['Both flows traced in the notes.txt file. All done.'] },
      ]);

      try {
        const providerConfig = makeProviderConfig(server.url);
        const state = makeState(cwd);
        const emitted = [];

        const result = await runLeadKernelTurn(
          state,
          providerConfig,
          'mock-key',
          'Investigate both flows',
          5,
          { emit: (event) => emitted.push(event) },
        );

        assert.equal(result.outcome, 'success');
        assert.ok(result.finalAssistantText.includes('All done.'));
        assert.equal(server.requests.length, 4, 'expected lead + 2 explorers + lead');

        // The lead advertises the fan-out arc it executes.
        assert.ok(
          JSON.stringify(server.requests[0]).includes('[DELEGATE_EXPLORER]'),
          'Explorer delegation protocol missing from the lead prompt',
        );

        // Both Explorer runs hit the provider under the Explorer identity,
        // each with its own delegation brief.
        const explorerRequests = [server.requests[1], server.requests[2]].map((r) =>
          JSON.stringify(r),
        );
        for (const requestText of explorerRequests) {
          assert.ok(
            requestText.includes('You are the Explorer agent'),
            'Explorer identity missing from delegated request',
          );
        }
        assert.ok(explorerRequests.some((r) => r.includes('Task: Trace flow A')));
        assert.ok(explorerRequests.some((r) => r.includes('Task: Trace flow B')));

        // The lead's next round sees both compact reports.
        const leadRound2 = JSON.stringify(server.requests[3]);
        assert.ok(leadRound2.includes('EXPLORER_RESULT'));
        assert.ok(leadRound2.includes('Findings: alpha beta'));

        // Delegation lifecycle events, one pair per Explorer — the TUI/REPL
        // delegation renderers key on these.
        const started = emitted.filter((e) => e.type === 'subagent.started');
        const completed = emitted.filter((e) => e.type === 'subagent.completed');
        assert.equal(started.length, 2);
        assert.equal(completed.length, 2);
        for (const event of [...started, ...completed]) {
          assert.equal(event.payload.agent, 'explorer');
          assert.ok(event.payload.executionId);
        }
        for (const event of completed) {
          assert.equal(event.payload.status, 'complete');
          assert.ok(event.payload.summary.includes('Findings'));
        }
        const delegationCards = emitted
          .filter((event) => event.type === 'tool.execution_complete')
          .map((event) => event.payload.card)
          .filter((card) => card?.type === 'delegation-result');
        assert.equal(delegationCards.length, 2);
        assert.ok(delegationCards.every((card) => card.data.status === 'complete'));

        // Lifecycle events are persisted to the session log too.
        const events = await loadSessionEventsEventually(
          state.sessionId,
          (loaded) => loaded.filter((e) => e.type === 'subagent.completed').length === 2,
        );
        assert.equal(events.filter((e) => e.type === 'subagent.started').length, 2);
        assert.equal(events.filter((e) => e.type === 'subagent.completed').length, 2);
      } finally {
        await server.stop();
      }
    });
  });

  it('honors disabledTools: no advertise, no spawn, canonical TOOL_DISABLED denial (Codex P2 #1370)', async () => {
    await withTempWorkspace(async (cwd) => {
      const server = await startSequencedProviderServer([
        { tokens: [fencedCall('delegate_explorer', { task: 'Trace flow A' })] },
        {
          tokens: [
            'I cannot delegate because it is disabled by user config; no Explorer was spawned.',
          ],
        },
      ]);

      try {
        const providerConfig = makeProviderConfig(server.url);
        const state = makeState(cwd);
        const emitted = [];

        const result = await runLeadKernelTurn(state, providerConfig, 'mock-key', 'Go', 5, {
          emit: (event) => emitted.push(event),
          disabledTools: ['delegate_explorer'],
        });

        assert.equal(result.outcome, 'success');
        // Advertising stays aligned with executor support: the disabled arc
        // is not in the prompt.
        assert.ok(
          !JSON.stringify(server.requests[0]).includes('[DELEGATE_EXPLORER]'),
          'disabled Explorer arc still advertised in the lead prompt',
        );
        // No Explorer provider request — the call fell through to
        // executeToolCall's dispatch gate.
        assert.equal(server.requests.length, 2);
        assert.ok(
          JSON.stringify(server.requests[1]).includes('disabled by user config'),
          'TOOL_DISABLED denial not fed back to the lead',
        );
        assert.ok(!emitted.some((e) => e.type.startsWith('subagent.')));
      } finally {
        await server.stop();
      }
    });
  });

  it('keeps the never-throw contract when the event sink throws on subagent events', async () => {
    await withTempWorkspace(async (cwd) => {
      const server = await startSequencedProviderServer([
        { tokens: [fencedCall('delegate_explorer', { task: 'Trace flow A' })] },
        { tokens: ['Findings: alpha beta'] },
        { tokens: ['Investigated the notes.txt file and summarized the findings.'] },
      ]);

      try {
        const providerConfig = makeProviderConfig(server.url);
        const state = makeState(cwd);

        // A client emit callback that throws on the delegation lifecycle
        // events — previously the unguarded subagent.started emit rejected
        // the kernel's fan-out batch before the runner's try (fugu review on
        // #1370); now lifecycle emission is best-effort.
        const result = await runLeadKernelTurn(
          state,
          providerConfig,
          'mock-key',
          'Investigate the flow',
          5,
          {
            emit: (event) => {
              if (event.type.startsWith('subagent.')) {
                throw new Error('sink exploded');
              }
            },
          },
        );

        assert.equal(result.outcome, 'success');
        assert.ok(result.finalAssistantText.includes('summarized the findings'));
        // The Explorer still ran and its report still reached the lead.
        assert.equal(server.requests.length, 3);
        assert.ok(JSON.stringify(server.requests[2]).includes('Findings: alpha beta'));
      } finally {
        await server.stop();
      }
    });
  });

  it('rejects a task-less delegation with a tool error and no Explorer spawn', async () => {
    await withTempWorkspace(async (cwd) => {
      const server = await startSequencedProviderServer([
        { tokens: [fencedCall('delegate_explorer', {})] },
        {
          tokens: [
            'I was unable to delegate because the required task argument was empty, so no Explorer was spawned.',
          ],
        },
      ]);

      try {
        const providerConfig = makeProviderConfig(server.url);
        const state = makeState(cwd);
        const emitted = [];

        const result = await runLeadKernelTurn(state, providerConfig, 'mock-key', 'Go', 5, {
          emit: (event) => emitted.push(event),
        });

        assert.equal(result.outcome, 'success');
        // Only the two lead rounds — no Explorer provider request was made.
        assert.equal(server.requests.length, 2);
        // (JSON.stringify escapes the quotes around "task" in the body.)
        assert.ok(
          JSON.stringify(server.requests[1]).includes('delegate_explorer requires a non-empty'),
          'validation error not fed back to the lead',
        );
        assert.ok(!emitted.some((e) => e.type.startsWith('subagent.')));
      } finally {
        await server.stop();
      }
    });
  });
});

describe(
  'runAssistantTurn — runs the lead turn on the shared kernel (§10 step 2)',
  needsLoopback,
  () => {
    it('routes every turn to the kernel lane (engine-loop opt-out retired)', async () => {
      await withTempWorkspace(async (cwd) => {
        const server = await startSequencedProviderServer([{ tokens: ['Kernel-lane reply.'] }]);
        try {
          const providerConfig = makeProviderConfig(server.url);
          const state = makeState(cwd);

          const result = await runAssistantTurn(
            state,
            providerConfig,
            'mock-key',
            'What does notes.txt say?',
            5,
            { emit: () => {} },
          );

          assert.equal(result.outcome, 'success');
          const requestText = JSON.stringify(server.requests[0]);
          assert.ok(
            requestText.includes(
              'You are `mock-model`, served via Ollama. You are the lead in this chat',
            ),
            'kernel lane not engaged',
          );
        } finally {
          await server.stop();
        }
      });
    });
  },
);

describe('buildLeadTurnPreamble', () => {
  it('places the user-goal anchor immediately before the current task', () => {
    const preamble = buildLeadTurnPreamble(
      'finish phase 4',
      [{ role: 'user', content: 'finish phase 4' }],
      '',
      null,
      {
        initialAsk: 'complete runtime unification',
        currentWorkingGoal: 'finish phase 4',
        branchLabel: 'owner/repo@feature',
      },
    );
    assert.match(preamble, /\[USER_GOAL\]/);
    assert.match(preamble, /Current working goal: finish phase 4/);
    assert.ok(preamble.indexOf('[/USER_GOAL]') < preamble.indexOf('Task: finish phase 4'));
  });

  it('bounds prior turns, drops the trailing user turn, and carries the snapshot', () => {
    const messages = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: '[TOOL_RESULT] noise [/TOOL_RESULT]' },
      { role: 'user', content: 'current question' },
    ];
    const preamble = buildLeadTurnPreamble(
      'current question',
      messages,
      '[Workspace Snapshot]\nBranch: main',
    );

    assert.ok(preamble.includes('[Workspace Snapshot]'));
    assert.ok(preamble.includes('[user] first question'));
    assert.ok(preamble.includes('[assistant] first answer'));
    assert.ok(!preamble.includes('TOOL_RESULT'), 'tool results leaked into preamble');
    assert.ok(preamble.endsWith('Task: current question'));
    // The trailing user turn is the task — it must not be duplicated as history.
    assert.ok(!preamble.includes('[user] current question'));
  });

  it('carries the latest [CONTEXT HANDOFF] even when it falls outside the last PRIOR_TURNS_MAX', () => {
    // Compaction replaces the old span in state.messages with a handoff, but the
    // token-based tail can preserve more than PRIOR_TURNS_MAX (6) turns, pushing
    // the handoff out of the slice(-6) window. Since the raw turns it summarizes
    // are already gone, dropping it would silently lose all compacted history —
    // so it must be carried forward un-clipped (Codex P1 on #1065).
    const summaryBody = 'SUMMARY-LINE '.repeat(120); // > PRIOR_TURN_MAX_CHARS (700)
    // Use the real engine helper so the content carries the full handoff prefix
    // that `isHandoffBlock` matches (not just the bare `[CONTEXT HANDOFF]` tag).
    const handoff = { role: 'user', content: buildHandoffBlock(summaryBody) };
    const messages = [
      handoff,
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' },
      { role: 'assistant', content: 'a3' },
      { role: 'user', content: 'current task' },
    ];
    const preamble = buildLeadTurnPreamble('current task', messages, '');

    assert.ok(preamble.includes('[CONTEXT HANDOFF]'), 'handoff dropped from preamble');
    // Un-clipped: the full summary body survives, not just the first 700 chars.
    assert.ok(preamble.includes(summaryBody.trim()), 'handoff summary was clipped or dropped');
    // The recent turns still ride along.
    assert.ok(preamble.includes('[assistant] a3'));
  });

  it('carries a trailing [REFERENCED_FILES] block into the task section un-clipped', () => {
    // `appendUserMessageWithFileReferences` pushes the raw line then a separate
    // [REFERENCED_FILES] block. The block must ride the task verbatim, not get
    // clipped to PRIOR_TURN_MAX_CHARS (700) as prior conversation (Codex P2, #936).
    const bigFileBody = 'X'.repeat(2000);
    const refsBlock = `[REFERENCED_FILES]\n{"version":1}\n[FILE_REFERENCE]\n{"reference":"@util.ts"}\n${bigFileBody}\n[/FILE_REFERENCE]\n[/REFERENCED_FILES]`;
    const messages = [
      { role: 'user', content: 'explain @util.ts' },
      { role: 'user', content: refsBlock },
    ];
    const preamble = buildLeadTurnPreamble('explain @util.ts', messages, '');

    // Full file content rides the preamble verbatim — not clipped/dropped.
    assert.ok(preamble.includes(bigFileBody), 'referenced file content was clipped or dropped');
    assert.ok(preamble.includes('[REFERENCED_FILES]'));
    // The current turn (line + refs block) is not duplicated as prior history.
    assert.ok(!preamble.includes('[user] explain @util.ts'));
    assert.ok(!preamble.includes('[user] [REFERENCED_FILES]'));
    // The task line precedes the carried reference block.
    assert.ok(preamble.includes('Task: explain @util.ts'));
    assert.ok(preamble.indexOf('Task: explain @util.ts') < preamble.indexOf(bigFileBody));
  });
});

describe('resolveDefaultExecMode', () => {
  let savedExecMode;

  function withSavedExecMode(fn) {
    savedExecMode = process.env.PUSH_EXEC_MODE;
    try {
      return fn();
    } finally {
      if (savedExecMode === undefined) delete process.env.PUSH_EXEC_MODE;
      else process.env.PUSH_EXEC_MODE = savedExecMode;
    }
  }

  it('reads the live daemon setting when set (Codex P1 on #1318)', () => {
    withSavedExecMode(() => {
      process.env.PUSH_EXEC_MODE = 'yolo';
      assert.equal(resolveDefaultExecMode(), 'yolo');

      process.env.PUSH_EXEC_MODE = 'strict';
      assert.equal(resolveDefaultExecMode(), 'strict');
    });
  });

  it('falls back to auto when unset', () => {
    withSavedExecMode(() => {
      delete process.env.PUSH_EXEC_MODE;
      assert.equal(resolveDefaultExecMode(), 'auto');
    });
  });
});

describe('runLeadKernelTurn — transcript noise (status durability)', needsLoopback, () => {
  it('keeps loop mechanics out of the permanent transcript, and lets tool rows group', async () => {
    await withTempWorkspace(async (cwd) => {
      await fs.writeFile(path.join(cwd, 'a.txt'), 'alpha\n', 'utf8');
      await fs.writeFile(path.join(cwd, 'b.txt'), 'beta\n', 'utf8');
      // Three rounds: read, read, then a plain answer.
      const server = await startSequencedProviderServer([
        { tokens: ['{"tool":"read_file","args":{"path":"a.txt"}}'] },
        { tokens: ['{"tool":"read_file","args":{"path":"b.txt"}}'] },
        { tokens: ['Both files read.'] },
      ]);

      try {
        const state = makeState(cwd);
        const emitted = [];
        const result = await runLeadKernelTurn(
          state,
          makeProviderConfig(server.url),
          'mock-key',
          'Read both files',
          5,
          { emit: (event) => emitted.push(event) },
        );
        assert.equal(result.outcome, 'success');

        const statuses = emitted.filter((e) => e.type === 'status');
        const texts = statuses.map((e) => `${e.payload?.phase} · ${e.payload?.detail}`);

        // The two that flooded every real transcript. 'Coder working...' is pure
        // round bookkeeping; 'Coder executing...' duplicates the tool card
        // rendered directly beneath it.
        assert.deepEqual(
          texts.filter((t) => /^Coder (working|executing|reasoning|resuming)/.test(t)),
          [],
          `loop mechanics reached the transcript: ${texts.join(' | ')}`,
        );

        // The real point: with the noise gone, consecutive tool rows are
        // ACTUALLY consecutive, so the grouping projection can fire. It never
        // could before — a status row sat between every pair, so the run length
        // was always 1 and `groupSilveryTranscriptRows` folded nothing.
        const { groupSilveryTranscriptRows } = await import('../silvery/transcript-groups.ts');
        const rows = emitted
          .filter((e) => e.type === 'tool.execution_complete')
          .map((e, i) => ({
            id: `t${i}`,
            kind: 'tool',
            role: 'assistant',
            text: '',
            pending: false,
            toolName: e.payload?.toolName,
            target: e.payload?.target,
          }));
        assert.equal(rows.length, 2, 'precondition: two settled tool calls');
        const display = groupSilveryTranscriptRows(rows);
        assert.equal(display.length, 1, 'two consecutive reads did not fold into one row');
        assert.equal(display[0].kind, 'tool_group');
        assert.equal(display[0].summary, 'Read 2 files');
      } finally {
        await server.stop();
      }
    });
  });

  it('still surfaces a status that outlives the moment it describes', async () => {
    await withTempWorkspace(async (cwd) => {
      // maxRounds=1 with an unfinished plan → the kernel halts on the cap and
      // emits 'Coder stopped'. That is a fact about the run, not a heartbeat:
      // dropping it would make a silent halt look like a normal end.
      const server = await startSequencedProviderServer([
        {
          tokens: [
            '{"tool":"coder_update_state","args":{"plan":"keep going","currentPhase":"investigation"}}',
          ],
        },
      ]);
      try {
        const state = makeState(cwd);
        const emitted = [];
        await runLeadKernelTurn(
          state,
          makeProviderConfig(server.url),
          'mock-key',
          'Do the thing',
          1,
          { emit: (event) => emitted.push(event), explicitMaxRounds: true },
        );
        const stops = emitted.filter(
          (e) => e.type === 'status' && /stopped/i.test(String(e.payload?.phase)),
        );
        assert.ok(
          stops.length > 0,
          'the round-limit halt was filtered out with the loop noise — a silent stop',
        );
        assert.match(String(stops[0].payload?.detail), /round limit/i);
      } finally {
        await server.stop();
      }
    });
  });
});
