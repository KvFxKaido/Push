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

import { runLeadKernelTurn, buildLeadTurnPreamble, resolveDefaultExecMode } from '../lead-turn.ts';
import { buildHandoffBlock } from '../../lib/llm-compaction.ts';
import { runAssistantTurn } from '../engine.ts';
import { PROVIDER_CONFIGS } from '../provider.ts';
import { makeSessionId } from '../session-store.ts';
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
          requestText.includes('You are the lead in this chat'),
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
          { emit: (event) => emitted.push(event) },
        );

        assert.equal(result.outcome, 'max_rounds');
        const runComplete = emitted.find((e) => e.type === 'run_complete');
        assert.equal(runComplete.payload.outcome, 'max_rounds');
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

  it('round-trips a read_file tool call through executeToolCall', async () => {
    await withTempWorkspace(async (cwd) => {
      await fs.writeFile(path.join(cwd, 'notes.txt'), 'hello from notes\n');

      const toolCall = [
        '```json',
        JSON.stringify({ tool: 'read_file', args: { path: 'notes.txt' } }),
        '```',
      ].join('\n');

      const server = await startSequencedProviderServer([
        { tokens: [toolCall] },
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
        // complete, name-keyed.
        const startIdx = emitted.findIndex((e) => e.type === 'tool.execution_start');
        const completeIdx = emitted.findIndex((e) => e.type === 'tool.execution_complete');
        assert.ok(startIdx >= 0, 'missing tool.execution_start event');
        assert.ok(completeIdx > startIdx, 'tool.execution_start must precede complete');
        const startEvent = emitted[startIdx];
        assert.equal(startEvent.payload.toolName, 'read_file');
        assert.deepEqual(startEvent.payload.args, { path: 'notes.txt' });

        // The kernel's tool event reaches the engine event stream.
        const toolEvent = emitted[completeIdx];
        assert.equal(toolEvent.payload.toolName, 'read_file');
        assert.equal(toolEvent.payload.isError, false);
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
            requestText.includes('You are the lead in this chat'),
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
