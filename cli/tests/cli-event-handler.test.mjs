import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ATTACH_CLIENT_CAPABILITIES,
  buildAttachSessionPayload,
  buildAttachSessionPayloadForSession,
  makeCLIEventHandler,
} from '../cli.ts';
import { saveSessionState } from '../session-store.ts';

// The CLI event handler writes directly to `process.stdout` (and
// `process.stderr`). These tests patch the underlying `.write` methods
// for the duration of a single handler call so we can capture exactly
// what a `push attach` transcript would see — without actually running
// the attach loop or spinning up a daemon socket. Fields we care about:
//
//   - subagent.*           → renders through delegationEventToTranscript
//   - task_graph.*         → same
//   - core tool/assistant  → renders via the original switch statement
//
// The regression this test guards against is the attach client silently
// dropping delegation events (pre-PR #278 behavior, where makeCLIEventHandler
// had no branch for `subagent.*` / `task_graph.*` types and the delegation
// lifecycle of a running task graph was invisible in the transcript).

function capture(fn) {
  const stdoutChunks = [];
  const stderrChunks = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, ...rest) => {
    stdoutChunks.push(String(chunk));
    // Return true to preserve the Writable contract; the handler doesn't
    // care about backpressure but the type is expected.
    return true;
  };
  process.stderr.write = (chunk, ...rest) => {
    stderrChunks.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }
  return { stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
}

// The rendered transcript lines include ANSI color codes from cli/format.ts.
// Strip them so assertions are readable and locale-agnostic.
// Matches CSI SGR escape sequences like `\u001b[...m`.
// biome-ignore lint/suspicious/noControlCharactersInRegex: SGR stripper
const ANSI_RE = /\u001b\[[0-9;]*m/g;
function stripAnsi(text) {
  return text.replace(ANSI_RE, '');
}

describe('makeCLIEventHandler delegation rendering', () => {
  it('renders subagent.started as an info line', () => {
    const handler = makeCLIEventHandler();
    const { stdout } = capture(() => {
      handler({
        type: 'subagent.started',
        payload: { subagentId: 'sub_1', agent: 'explorer', detail: 'find the thing' },
      });
    });
    const clean = stripAnsi(stdout);
    assert.match(clean, /\[info\]/);
    assert.match(clean, /subagent started: explorer/);
    assert.match(clean, /find the thing/);
    assert.match(clean, /^\n\[info\]/);
  });

  it('renders subagent.failed as an error line', () => {
    const handler = makeCLIEventHandler();
    const { stdout } = capture(() => {
      handler({
        type: 'subagent.failed',
        payload: { subagentId: 'sub_1', agent: 'coder', error: 'boom' },
      });
    });
    const clean = stripAnsi(stdout);
    assert.match(clean, /\[error\]/);
    assert.match(clean, /subagent failed: coder/);
    assert.match(clean, /boom/);
    assert.match(clean, /\n$/);
  });

  it('renders task_graph.task_cancelled as a warning graph snapshot', () => {
    const handler = makeCLIEventHandler();
    const { stdout } = capture(() => {
      handler({
        type: 'task_graph.task_cancelled',
        payload: {
          executionId: 'graph_1',
          taskId: 'explore-a',
          agent: 'explorer',
          reason: 'parent aborted',
        },
      });
    });
    const clean = stripAnsi(stdout);
    assert.match(clean, /\[warn\]/);
    assert.match(clean, /task graph: graph_1/);
    assert.match(clean, /\[cancelled\] explore-a \(explorer\)/);
    assert.match(clean, /parent aborted/);
  });

  it('renders task_graph.graph_completed success with final graph stats', () => {
    const handler = makeCLIEventHandler();
    const { stdout } = capture(() => {
      handler({
        type: 'task_graph.graph_completed',
        payload: {
          executionId: 'graph_1',
          success: true,
          aborted: false,
          nodeCount: 3,
          totalRounds: 7,
          wallTimeMs: 1234,
          summary: 'all three explorer nodes finished',
        },
      });
    });
    const clean = stripAnsi(stdout);
    assert.match(clean, /\[info\]/);
    assert.match(clean, /task graph: graph_1 — completed/);
    assert.match(clean, /3 nodes \/ 7 rounds \/ 1234ms/);
    assert.match(clean, /result: completed/);
    assert.match(clean, /all three explorer nodes finished/);
  });

  it('renders task_graph.graph_completed failure as an error graph snapshot', () => {
    const handler = makeCLIEventHandler();
    const { stdout } = capture(() => {
      handler({
        type: 'task_graph.graph_completed',
        payload: {
          executionId: 'graph_1',
          success: false,
          aborted: false,
          nodeCount: 2,
          totalRounds: 4,
          wallTimeMs: 800,
          summary: 'build-1 FAILED: Coder delegation is not yet wired',
        },
      });
    });
    const clean = stripAnsi(stdout);
    assert.match(clean, /\[error\]/);
    assert.match(clean, /task graph: graph_1 — failed/);
  });

  it('still renders core tool lifecycle events', () => {
    const handler = makeCLIEventHandler();
    const { stdout } = capture(() => {
      handler({
        type: 'tool.execution_start',
        payload: { toolName: 'read_file', round: 1, executionId: 'exec_1', toolSource: 'fs' },
      });
      handler({
        type: 'tool.execution_complete',
        payload: {
          toolName: 'read_file',
          round: 1,
          executionId: 'exec_1',
          toolSource: 'fs',
          durationMs: 12,
          isError: false,
          preview: 'file contents',
        },
      });
    });
    const clean = stripAnsi(stdout);
    assert.match(clean, /\[tool\] read_file/);
    assert.match(clean, /\[tool:ok\]/);
  });

  it('routes an error tool result through the red error badge', () => {
    const handler = makeCLIEventHandler();
    const { stdout } = capture(() => {
      handler({
        type: 'tool_result',
        payload: {
          isError: true,
          text: 'file not found',
        },
      });
    });
    const clean = stripAnsi(stdout);
    assert.match(clean, /\[tool:error\]/);
    assert.match(clean, /file not found/);
  });

  it('silently ignores unrecognised event types', () => {
    const handler = makeCLIEventHandler();
    const { stdout } = capture(() => {
      handler({ type: 'totally.made.up.event', payload: { hello: 'world' } });
    });
    assert.equal(stdout, '');
  });
});

describe('buildAttachSessionPayload', () => {
  it('opts attach clients into raw v2 delegation events', () => {
    assert.deepEqual(ATTACH_CLIENT_CAPABILITIES, ['event_v2']);
    assert.deepEqual(
      buildAttachSessionPayload({
        sessionId: 'sess_alpha1_abcdef',
        lastSeenSeq: 12,
      }),
      {
        sessionId: 'sess_alpha1_abcdef',
        lastSeenSeq: 12,
        capabilities: ['event_v2'],
      },
    );
  });

  it('includes a local attach token when one is available', () => {
    assert.deepEqual(
      buildAttachSessionPayload({
        sessionId: 'sess_alpha1_abcdef',
        lastSeenSeq: 0,
        attachToken: 'att_secret',
      }),
      {
        sessionId: 'sess_alpha1_abcdef',
        lastSeenSeq: 0,
        attachToken: 'att_secret',
        capabilities: ['event_v2'],
      },
    );
  });

  it('omits empty attach tokens for legacy sessions', () => {
    const payload = buildAttachSessionPayload({
      sessionId: 'sess_alpha1_abcdef',
      lastSeenSeq: 0,
      attachToken: '   ',
    });
    assert.equal(Object.hasOwn(payload, 'attachToken'), false);
  });

  it('reads a persisted attach token from local session state', async () => {
    const originalSessionDir = process.env.PUSH_SESSION_DIR;
    const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'push-attach-payload-'));
    process.env.PUSH_SESSION_DIR = tmpRoot;
    try {
      await saveSessionState({
        sessionId: 'sess_alpha1_abcdef',
        messages: [],
        eventSeq: 0,
        updatedAt: 0,
        cwd: process.cwd(),
        provider: 'ollama',
        model: 'llama3',
        rounds: 0,
        sessionName: '',
        workingMemory: null,
        attachToken: 'att_local_secret',
      });

      assert.deepEqual(await buildAttachSessionPayloadForSession('sess_alpha1_abcdef', 4), {
        sessionId: 'sess_alpha1_abcdef',
        lastSeenSeq: 4,
        attachToken: 'att_local_secret',
        capabilities: ['event_v2'],
      });
    } finally {
      if (originalSessionDir === undefined) delete process.env.PUSH_SESSION_DIR;
      else process.env.PUSH_SESSION_DIR = originalSessionDir;
      await fs.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
