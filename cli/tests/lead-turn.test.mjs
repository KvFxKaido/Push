// Integration tests for the lead-kernel lane (cli/lead-turn.ts) — §10 step 2.
//
// Pins that the opt-in lane runs the terminal turn as a `leadMode: true` run
// of the shared coder kernel: the lead identity reaches the provider (not the
// CLI engine's local identity, not the delegated Coder implementer prompt),
// tools round-trip through the real `executeToolCall` against the workspace,
// and the lane speaks the engine's existing event vocabulary so the TUI /
// daemon clients render it unchanged. Routing pins live at the
// `runAssistantTurn` seam: `PUSH_LEAD_RUNTIME=kernel` opts in, default stays
// on the engine loop.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runLeadKernelTurn, buildLeadTurnPreamble } from '../lead-turn.ts';
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

        // The kernel's tool event reaches the engine event stream.
        const toolEvent = emitted.find((e) => e.type === 'tool.execution_complete');
        assert.ok(toolEvent, 'missing tool.execution_complete event');
        assert.equal(toolEvent.payload.toolName, 'read_file');
        assert.equal(toolEvent.payload.isError, false);
      } finally {
        await server.stop();
      }
    });
  });
});

describe('runAssistantTurn — lead-runtime routing (§10 step 2)', needsLoopback, () => {
  it('PUSH_LEAD_RUNTIME=kernel routes the turn onto the shared kernel', async () => {
    await withTempWorkspace(async (cwd) => {
      const server = await startSequencedProviderServer([{ tokens: ['Kernel-lane reply.'] }]);

      const prevLead = process.env.PUSH_LEAD_RUNTIME;
      const prevMode = process.env.PUSH_DELEGATION_MODE;
      process.env.PUSH_LEAD_RUNTIME = 'kernel';
      delete process.env.PUSH_DELEGATION_MODE;
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
          'kernel lane not engaged via PUSH_LEAD_RUNTIME',
        );
      } finally {
        if (prevLead === undefined) delete process.env.PUSH_LEAD_RUNTIME;
        else process.env.PUSH_LEAD_RUNTIME = prevLead;
        if (prevMode === undefined) delete process.env.PUSH_DELEGATION_MODE;
        else process.env.PUSH_DELEGATION_MODE = prevMode;
        await server.stop();
      }
    });
  });

  it('defaults to the engine loop when no opt-in is present', async () => {
    await withTempWorkspace(async (cwd) => {
      const server = await startSequencedProviderServer([{ tokens: ['Engine reply.'] }]);

      const prevLead = process.env.PUSH_LEAD_RUNTIME;
      const prevMode = process.env.PUSH_DELEGATION_MODE;
      delete process.env.PUSH_LEAD_RUNTIME;
      delete process.env.PUSH_DELEGATION_MODE;
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
        // The engine loop sends the session's own system message verbatim;
        // the kernel lane would have replaced it with the lead identity.
        const requestText = JSON.stringify(server.requests[0]);
        assert.ok(
          requestText.includes('You are a helpful assistant.'),
          'session system prompt missing — default runtime changed unexpectedly',
        );
        assert.ok(
          !requestText.includes('You are the lead in this chat'),
          'kernel lane engaged without opt-in',
        );
      } finally {
        if (prevLead === undefined) delete process.env.PUSH_LEAD_RUNTIME;
        else process.env.PUSH_LEAD_RUNTIME = prevLead;
        if (prevMode === undefined) delete process.env.PUSH_DELEGATION_MODE;
        else process.env.PUSH_DELEGATION_MODE = prevMode;
        await server.stop();
      }
    });
  });
});

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
});
