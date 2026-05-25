import { describe, it, expect } from 'vitest';
import {
  generateCheckpointAnswer,
  runCoderAgent,
  SandboxUnreachableError,
  type CoderAgentOptions,
} from './coder-agent.js';
import type { PushStream, PushStreamEvent } from './provider-contract.js';

type Call = { call: { tool: string; args: Record<string, unknown> } };

function makePushStream(rounds: PushStreamEvent[][]): {
  stream: PushStream;
  capturedRequests: unknown[];
} {
  let invocation = 0;
  const capturedRequests: unknown[] = [];
  const stream: PushStream = (req) => {
    capturedRequests.push(req);
    const batch = rounds[invocation] ?? [];
    invocation += 1;
    return (async function* () {
      for (const event of batch) {
        yield event;
      }
    })();
  };
  return { stream, capturedRequests };
}

describe('generateCheckpointAnswer (PushStream consumer)', () => {
  it('accumulates text_delta events and trims the response', async () => {
    const { stream, capturedRequests } = makePushStream([
      [
        { type: 'text_delta', text: 'Decision: continue.' },
        { type: 'text_delta', text: '\nWhy: it is fine.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);

    const answer = await generateCheckpointAnswer('What now?', 'context', {
      stream,
      provider: 'openrouter',
      modelId: 'orchestrator-model',
    });

    expect(answer).toContain('Decision: continue.');
    expect(answer).toContain('Why: it is fine.');

    const req = capturedRequests[0] as { systemPromptOverride?: string };
    expect(req.systemPromptOverride).toContain('Orchestrator agent');
  });

  it('returns the fallback string on stream error', async () => {
    const stream: PushStream = () =>
      (async function* () {
        throw new Error('upstream went away');
      })();

    const answer = await generateCheckpointAnswer('What now?', 'context', {
      stream,
      provider: 'openrouter',
      modelId: 'orchestrator-model',
    });

    expect(answer).toContain('could not generate a response');
  });

  it('ignores reasoning_delta events while accumulating text', async () => {
    const { stream } = makePushStream([
      [
        { type: 'reasoning_delta', text: 'thinking...' },
        { type: 'reasoning_end' },
        { type: 'text_delta', text: 'Decision: ship.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);

    const answer = await generateCheckpointAnswer('What now?', 'context', {
      stream,
      provider: 'openrouter',
      modelId: 'orchestrator-model',
    });

    expect(answer).toContain('Decision: ship.');
  });
});

function baseCoderOptions(overrides: {
  stream: PushStream;
  detectAnyToolCall?: CoderAgentOptions<Call, never>['detectAnyToolCall'];
  detectAllToolCalls?: CoderAgentOptions<Call, never>['detectAllToolCalls'];
  evaluateAfterModel?: CoderAgentOptions<Call, never>['evaluateAfterModel'];
}): CoderAgentOptions<Call, never> {
  return {
    provider: 'openrouter',
    stream: overrides.stream,
    modelId: 'coder-model',
    sandboxId: 'sb-1',
    allowedRepo: 'kvfxkaido/push',
    userProfile: null,
    taskPreamble: 'Implement the auth fix.',
    symbolSummary: null,
    toolExec: async () => ({ kind: 'executed', resultText: 'tool ok' }),
    detectAllToolCalls:
      overrides.detectAllToolCalls ??
      (() => ({
        readOnly: [],
        mutating: null,
        fileMutations: [],
        extraMutations: [],
        droppedCandidates: [],
      })),
    detectAnyToolCall: overrides.detectAnyToolCall ?? (() => null),
    webSearchToolProtocol: '',
    sandboxToolProtocol: '',
    verificationPolicyBlock: null,
    approvalModeBlock: null,
    evaluateAfterModel:
      overrides.evaluateAfterModel ?? (async () => ({ action: 'halt', summary: 'done' })),
  };
}

describe('runCoderAgent (PushStream consumer)', () => {
  it('passes the assembled request through to the PushStream and halts when policy halts', async () => {
    const { stream, capturedRequests } = makePushStream([
      [
        { type: 'text_delta', text: 'I am done.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);

    const result = await runCoderAgent(baseCoderOptions({ stream }), {
      onStatus: () => {},
    });

    expect(result.summary).toBe('done');
    expect(result.rounds).toBe(1);

    const req = capturedRequests[0] as { model: string; hasSandbox?: boolean };
    expect(req.model).toBe('coder-model');
    expect(req.hasSandbox).toBe(true);
  });

  it('fires onCheckpoint at the cadence (every 5th round) with a consistent state snapshot', async () => {
    const rounds: PushStreamEvent[][] = Array.from({ length: 8 }, () => [
      { type: 'text_delta', text: 'working' },
      { type: 'done', finishReason: 'stop' },
    ]);
    const { stream } = makePushStream(rounds);

    // Each round emits a read-only tool call so the loop keeps iterating; the
    // after-model policy halts at round 6, stopping just past the round-5
    // checkpoint.
    // Two reads so the batch path (batchTotal >= 2) runs and the loop continues;
    // a single read would fall through to the detectAnyToolCall path.
    const detectAllToolCalls = () => ({
      readOnly: [
        { call: { tool: 'sandbox_read_file', args: { path: 'a' } } },
        { call: { tool: 'sandbox_read_file', args: { path: 'b' } } },
      ],
      mutating: null,
      fileMutations: [],
      extraMutations: [],
      droppedCandidates: [],
    });
    const evaluateAfterModel = async (_response: string, round: number) =>
      round >= 6 ? ({ action: 'halt', summary: 'done' } as const) : null;

    const checkpoints: Array<{ round: number; messageCount: number }> = [];
    await runCoderAgent(baseCoderOptions({ stream, detectAllToolCalls, evaluateAfterModel }), {
      onStatus: () => {},
      onCheckpoint: async (state) => {
        checkpoints.push({ round: state.round, messageCount: state.messages.length });
      },
    });

    // Cadence is 5, skipping round 0 → exactly one checkpoint at round index 5.
    expect(checkpoints.map((c) => c.round)).toEqual([5]);
    expect(checkpoints[0]?.messageCount).toBeGreaterThan(0);
  });

  it('throws SandboxUnreachableError after consecutive SANDBOX_UNREACHABLE tool results', async () => {
    const { stream } = makePushStream([
      [
        { type: 'text_delta', text: 'reading files' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);
    const detectAllToolCalls = () => ({
      readOnly: [
        { call: { tool: 'sandbox_read_file', args: { path: 'a' } } },
        { call: { tool: 'sandbox_read_file', args: { path: 'b' } } },
      ],
      mutating: null,
      fileMutations: [],
      extraMutations: [],
      droppedCandidates: [],
    });
    const toolExec = async () => ({
      kind: 'executed' as const,
      resultText: 'gone',
      errorType: 'SANDBOX_UNREACHABLE',
    });

    await expect(
      runCoderAgent(
        {
          ...baseCoderOptions({ stream, detectAllToolCalls, evaluateAfterModel: async () => null }),
          toolExec,
        },
        { onStatus: () => {} },
      ),
    ).rejects.toBeInstanceOf(SandboxUnreachableError);
  });

  it('does not throw on an isolated SANDBOX_UNREACHABLE blip (counter resets on success)', async () => {
    const { stream } = makePushStream(
      Array.from({ length: 4 }, () => [
        { type: 'text_delta' as const, text: 'work' },
        { type: 'done' as const, finishReason: 'stop' as const },
      ]),
    );
    const detectAllToolCalls = () => ({
      readOnly: [
        { call: { tool: 'sandbox_read_file', args: { path: 'a' } } },
        { call: { tool: 'sandbox_read_file', args: { path: 'b' } } },
      ],
      mutating: null,
      fileMutations: [],
      extraMutations: [],
      droppedCandidates: [],
    });
    // First call a blip, every later call succeeds → the consecutive counter
    // never reaches the threshold.
    let n = 0;
    const toolExec = async () => {
      n += 1;
      return n === 1
        ? { kind: 'executed' as const, resultText: 'blip', errorType: 'SANDBOX_UNREACHABLE' }
        : { kind: 'executed' as const, resultText: 'ok' };
    };
    const evaluateAfterModel = async (_r: string, round: number) =>
      round >= 2 ? ({ action: 'halt', summary: 'done' } as const) : null;

    await expect(
      runCoderAgent(
        { ...baseCoderOptions({ stream, detectAllToolCalls, evaluateAfterModel }), toolExec },
        { onStatus: () => {} },
      ),
    ).resolves.toMatchObject({ summary: 'done' });
  });

  it('seeds the loop from resumeState (restored messages + starting round)', async () => {
    const { stream, capturedRequests } = makePushStream([
      [
        { type: 'text_delta', text: 'I am done.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);
    const resumeState = {
      round: 7,
      messages: [
        { id: 'coder-task', role: 'user' as const, content: 'original task', timestamp: 1 },
        { id: 'prior', role: 'assistant' as const, content: 'prior progress', timestamp: 2 },
      ],
      workingMemory: { plan: 'restored plan' },
      cards: [] as never[],
    };

    const result = await runCoderAgent(
      { ...baseCoderOptions({ stream }), resumeState },
      { onStatus: () => {} },
    );

    // The first model call sees the restored history, not a fresh [taskPreamble].
    const req = capturedRequests[0] as { messages: Array<{ content: string }> };
    expect(req.messages.some((m) => m.content === 'prior progress')).toBe(true);
    // Resumes at round 7 → reported as 1-based rounds 8.
    expect(result.rounds).toBe(8);
  });

  it('throws AbortError when callbacks.signal aborts before round 1', async () => {
    const controller = new AbortController();
    controller.abort();
    const { stream } = makePushStream([[{ type: 'done', finishReason: 'stop' }]]);

    await expect(
      runCoderAgent(baseCoderOptions({ stream }), {
        onStatus: () => {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('ignores reasoning_delta events while accumulating round text', async () => {
    const { stream } = makePushStream([
      [
        { type: 'reasoning_delta', text: 'thinking...' },
        { type: 'reasoning_end' },
        { type: 'text_delta', text: 'Round one output.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);

    const result = await runCoderAgent(baseCoderOptions({ stream }), {
      onStatus: () => {},
    });

    expect(result.summary).toBe('done');
    expect(result.rounds).toBe(1);
  });

  it('emits exactly one assistant.prompt_snapshot run event tagged with the coder role', async () => {
    // Wire-through guard: the lib kernel must invoke `onRunEvent` once
    // with a snapshot of the assembled system prompt. If a future
    // refactor drops the emit, this test fails and the audit trail
    // silently breaks — exactly the silent-failure shape the OpenCode
    // audit closed elsewhere.
    const { stream } = makePushStream([[{ type: 'done', finishReason: 'stop' }]]);
    const events: Array<{ type: string }> = [];

    await runCoderAgent(baseCoderOptions({ stream }), {
      onStatus: () => {},
      onRunEvent: (event) => events.push(event),
    });

    const snapshots = events.filter((e) => e.type === 'assistant.prompt_snapshot');
    expect(snapshots).toHaveLength(1);
    const snap = snapshots[0] as {
      round: number;
      role: string;
      totalChars: number;
      sections: Record<string, { hash: number; size: number; volatile: boolean }>;
    };
    expect(snap.round).toBe(0);
    expect(snap.role).toBe('coder');
    expect(snap.totalChars).toBeGreaterThan(0);
    expect(Object.keys(snap.sections).length).toBeGreaterThan(0);
  });

  it('refuses to execute when detectAllToolCalls reports dropped candidates and surfaces the malformed name', async () => {
    // Reproduces the "Coder loops on sandbox_diff" bug: model emits a
    // malformed edit_range alongside a valid diff. Without this guard
    // the diff runs and the model infers from a clean diff that "my
    // edit silently failed" and tries again indefinitely.
    const { stream } = makePushStream([
      [
        { type: 'text_delta', text: 'try edit then diff' },
        { type: 'done', finishReason: 'stop' },
      ],
      [
        { type: 'text_delta', text: 'I am done.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);

    const statuses: Array<{ phase: string; detail?: string }> = [];
    let detectCallCount = 0;
    let policyCallCount = 0;
    const result = await runCoderAgent(
      baseCoderOptions({
        stream,
        // Round 1 must reach the dropped-candidate guard, so the policy
        // returns null. Round 2 halts so the test terminates.
        evaluateAfterModel: async () => {
          policyCallCount += 1;
          if (policyCallCount === 1) return null;
          return { action: 'halt', summary: 'done' };
        },
        detectAllToolCalls: () => {
          detectCallCount += 1;
          if (detectCallCount === 1) {
            return {
              readOnly: [{ call: { tool: 'sandbox_diff', args: {} } }] as never,
              mutating: null,
              fileMutations: [],
              extraMutations: [],
              droppedCandidates: [
                {
                  rawToolName: 'edit_range',
                  resolvedToolName: 'sandbox_edit_range',
                  sample:
                    '{"tool":"edit_range","args":{"path":"/workspace/README.md","content":"x"}}',
                },
              ],
            };
          }
          return {
            readOnly: [],
            mutating: null,
            fileMutations: [],
            extraMutations: [],
            droppedCandidates: [],
          };
        },
      }),
      {
        onStatus: (phase, detail) => statuses.push({ phase, detail }),
      },
    );

    // The valid sandbox_diff in the same turn must NOT have executed —
    // the parse-error guard short-circuits the round.
    expect(statuses.some((s) => s.phase === 'Coder executing...')).toBe(false);
    // The dropped candidate is surfaced via the status callback so the
    // operator sees what was rejected.
    const parseStatus = statuses.find((s) => s.phase === 'Coder parse error');
    expect(parseStatus).toBeDefined();
    expect(parseStatus?.detail).toContain('edit_range');
    expect(result.rounds).toBe(2);
  });
});
