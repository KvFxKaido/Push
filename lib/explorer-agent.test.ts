import { describe, it, expect, vi } from 'vitest';
import { runExplorerAgent, type ExplorerAgentOptions } from './explorer-agent.js';
import type { PushStream, PushStreamEvent } from './provider-contract.js';

type Call = { call: { tool: string; args: Record<string, unknown> } };

function makePushStream(events: PushStreamEvent[][]): {
  stream: PushStream;
  capturedRequests: unknown[];
} {
  let invocation = 0;
  const capturedRequests: unknown[] = [];
  const stream: PushStream = (req) => {
    capturedRequests.push(req);
    const batch = events[invocation] ?? [];
    invocation += 1;
    return (async function* () {
      for (const event of batch) {
        yield event;
      }
    })();
  };
  return { stream, capturedRequests };
}

function baseOptions(overrides: {
  stream: PushStream;
  toolExec?: ExplorerAgentOptions<Call, never>['toolExec'];
  detectAllToolCalls?: ExplorerAgentOptions<Call, never>['detectAllToolCalls'];
  detectAnyToolCall?: ExplorerAgentOptions<Call, never>['detectAnyToolCall'];
  evaluateAfterModel?: ExplorerAgentOptions<Call, never>['evaluateAfterModel'];
  nativeToolSchemas?: ExplorerAgentOptions<Call, never>['nativeToolSchemas'];
}): ExplorerAgentOptions<Call, never> {
  return {
    provider: 'openrouter',
    stream: overrides.stream,
    modelId: 'explorer-model',
    sandboxId: null,
    allowedRepo: 'kvfxkaido/push',
    userProfile: null,
    taskPreamble: 'Investigate the auth flow.',
    symbolSummary: null,
    toolExec:
      overrides.toolExec ??
      (async () => ({
        resultText: 'tool-result',
      })),
    detectAllToolCalls:
      overrides.detectAllToolCalls ??
      (() => ({
        readOnly: [],
        sideEffects: [],
        fileMutations: [],
        extraMutations: [],
        droppedCandidates: [],
      })),
    detectAnyToolCall: overrides.detectAnyToolCall ?? (() => null),
    webSearchToolProtocol: '',
    nativeToolSchemas: overrides.nativeToolSchemas,
    evaluateAfterModel: overrides.evaluateAfterModel ?? (async () => null),
  };
}

describe('runExplorerAgent (PushStream consumer)', () => {
  it('accumulates text_delta events into the final report when no tool calls detected', async () => {
    const { stream, capturedRequests } = makePushStream([
      [
        { type: 'text_delta', text: 'Summary:\nDone.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);

    const result = await runExplorerAgent(baseOptions({ stream }), {
      onStatus: () => {},
    });

    expect(result.summary).toBe('Summary:\nDone.');
    expect(result.rounds).toBe(1);

    const req = capturedRequests[0] as { model: string; systemPromptOverride?: string };
    expect(req.model).toBe('explorer-model');
    expect(req.systemPromptOverride).toContain('Explorer agent');
  });

  it('forwards native function schemas to the stream request when provided', async () => {
    const { stream, capturedRequests } = makePushStream([
      [
        { type: 'text_delta', text: 'Summary:\nDone.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);
    const nativeToolSchemas = [
      {
        name: 'read_file',
        description: 'Read file content',
        input_schema: {
          type: 'object' as const,
          properties: { path: { type: 'string' as const } },
          required: ['path'],
          additionalProperties: false,
        },
      },
    ];

    await runExplorerAgent(baseOptions({ stream, nativeToolSchemas }), {
      onStatus: () => {},
    });

    const req = capturedRequests[0] as { tools?: unknown };
    expect(req.tools).toBe(nativeToolSchemas);
  });

  it('stops the side-effect chain on the first [Tool Error] result (fail-fast contract)', async () => {
    // Round 1 emits a read + a two-call chain; the first chain call fails.
    // The second chain call must NOT execute (fugu WARNING on #1536).
    const readCall: Call = { call: { tool: 'read_file', args: { path: '/a' } } };
    const chain1: Call = { call: { tool: 'exec', args: { command: 'fails' } } };
    const chain2: Call = { call: { tool: 'exec', args: { command: 'never-runs' } } };
    const detector = vi.fn();
    detector
      .mockReturnValueOnce({
        readOnly: [readCall],
        sideEffects: [chain1, chain2],
        fileMutations: [],
        extraMutations: [],
        droppedCandidates: [],
      })
      .mockReturnValue({
        readOnly: [],
        sideEffects: [],
        fileMutations: [],
        extraMutations: [],
        droppedCandidates: [],
      });
    const executed: string[] = [];
    const { stream } = makePushStream([
      [
        { type: 'text_delta', text: 'calling tools' },
        { type: 'done', finishReason: 'stop' },
      ],
      [
        { type: 'text_delta', text: 'Summary:\nDone.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);

    await runExplorerAgent(
      baseOptions({
        stream,
        detectAllToolCalls: detector,
        toolExec: async (call) => {
          const cmd = String(call.call.args.command ?? call.call.args.path);
          executed.push(cmd);
          return {
            resultText: cmd === 'fails' ? '[Tool Error] exec failed: exit 1' : 'tool-result',
          };
        },
      }),
      { onStatus: () => {} },
    );

    expect(executed).toContain('fails');
    expect(executed).not.toContain('never-runs');
  });

  it('continues looping while tool calls are detected', async () => {
    const detector = vi.fn();
    detector
      .mockReturnValueOnce({
        readOnly: [],
        sideEffects: [{ call: { tool: 'sandbox_read_file', args: {} } }],
        fileMutations: [],
        extraMutations: [],
        droppedCandidates: [],
      })
      .mockReturnValueOnce({
        readOnly: [],
        sideEffects: [],
        fileMutations: [],
        extraMutations: [],
        droppedCandidates: [],
      });

    const { stream } = makePushStream([
      [
        { type: 'text_delta', text: '{"tool":"sandbox_read_file","args":{}}' },
        { type: 'done', finishReason: 'stop' },
      ],
      [
        { type: 'text_delta', text: 'Summary:\nDone after one tool call.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);

    const result = await runExplorerAgent(
      baseOptions({
        stream,
        detectAllToolCalls: detector,
        detectAnyToolCall: () => null,
        toolExec: async () => ({ resultText: 'file contents' }),
      }),
      { onStatus: () => {} },
    );

    expect(result.rounds).toBe(2);
    expect(result.summary).toBe('Summary:\nDone after one tool call.');
  });

  it('throws AbortError when callbacks.signal is already aborted before round 1', async () => {
    const controller = new AbortController();
    controller.abort();
    const { stream } = makePushStream([
      [
        { type: 'text_delta', text: 'Summary:\nNever runs.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);

    await expect(
      runExplorerAgent(baseOptions({ stream }), {
        onStatus: () => {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('ignores reasoning_delta and reasoning_end while accumulating text', async () => {
    const { stream } = makePushStream([
      [
        { type: 'reasoning_delta', text: 'thinking...' },
        { type: 'reasoning_end' },
        { type: 'text_delta', text: 'Summary:\nFinished.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);

    const result = await runExplorerAgent(baseOptions({ stream }), { onStatus: () => {} });
    expect(result.summary).toBe('Summary:\nFinished.');
  });

  it('emits exactly one assistant.prompt_snapshot run event tagged with the explorer role', async () => {
    // Wire-through guard: a future refactor that drops the emit
    // silently breaks the per-delegation audit trail.
    const { stream } = makePushStream([
      [
        { type: 'text_delta', text: 'Summary:\nDone.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);
    const events: Array<{ type: string }> = [];

    await runExplorerAgent(baseOptions({ stream }), {
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
    expect(snap.role).toBe('explorer');
    expect(snap.totalChars).toBeGreaterThan(0);
    expect(Object.keys(snap.sections).length).toBeGreaterThan(0);
  });
});
