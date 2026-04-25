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
      (() => ({ readOnly: [], mutating: null, fileMutations: [], extraMutations: [] })),
    detectAnyToolCall: overrides.detectAnyToolCall ?? (() => null),
    webSearchToolProtocol: '',
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

  it('continues looping while tool calls are detected', async () => {
    const detector = vi.fn();
    detector
      .mockReturnValueOnce({
        readOnly: [],
        mutating: { call: { tool: 'sandbox_read_file', args: {} } },
        fileMutations: [],
        extraMutations: [],
      })
      .mockReturnValueOnce({ readOnly: [], mutating: null, fileMutations: [], extraMutations: [] });

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
});
