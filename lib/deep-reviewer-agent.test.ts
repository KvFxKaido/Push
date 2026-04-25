import { describe, it, expect } from 'vitest';
import { runDeepReviewer, type DeepReviewerOptions } from './deep-reviewer-agent.js';
import type { PushStream, PushStreamEvent } from './provider-contract.js';

type Call = { call: { tool: string; args: Record<string, unknown> } };

function makeAddedFileDiff(path: string, addedContent: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    `+${addedContent}`,
    '',
  ].join('\n');
}

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

function baseOptions(overrides: {
  stream: PushStream;
  detectAllToolCalls?: DeepReviewerOptions<Call, never>['detectAllToolCalls'];
  detectAnyToolCall?: DeepReviewerOptions<Call, never>['detectAnyToolCall'];
}): DeepReviewerOptions<Call, never> {
  return {
    provider: 'openrouter',
    stream: overrides.stream,
    modelId: 'deep-review-model',
    sandboxId: undefined,
    allowedRepo: 'kvfxkaido/push',
    userProfile: null,
    resolveRuntimeContext: async () => '',
    toolExec: async () => ({ resultText: 'ok' }),
    detectAllToolCalls:
      overrides.detectAllToolCalls ??
      (() => ({ readOnly: [], mutating: null, fileMutations: [], extraMutations: [] })),
    detectAnyToolCall: overrides.detectAnyToolCall ?? (() => null),
    webSearchToolProtocol: '',
  };
}

describe('runDeepReviewer (PushStream consumer)', () => {
  it('parses the structured review JSON when the model emits the completion marker', async () => {
    const reportJson = JSON.stringify({
      summary: 'Looks reasonable.',
      comments: [{ file: 'src/auth.ts', line: 1, severity: 'note', comment: 'Looks fine' }],
    });
    const { stream, capturedRequests } = makePushStream([
      // Need a tool call in round 1 to bypass the no-investigation guard.
      [
        { type: 'text_delta', text: 'Investigating...' },
        { type: 'done', finishReason: 'stop' },
      ],
      [
        { type: 'text_delta', text: `[REVIEW_COMPLETE]\n${reportJson}` },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);

    let toolCallReturn: { call: { tool: string; args: Record<string, unknown> } } | null = {
      call: { tool: 'sandbox_read_file', args: {} },
    };

    const result = await runDeepReviewer(
      makeAddedFileDiff('src/auth.ts', 'const x = 1;'),
      baseOptions({
        stream,
        detectAnyToolCall: () => {
          const next = toolCallReturn;
          toolCallReturn = null;
          return next;
        },
      }),
      { onStatus: () => {} },
    );

    expect(result.summary).toBe('Looks reasonable.');
    expect(result.comments).toHaveLength(1);

    const req0 = capturedRequests[0] as { model: string; systemPromptOverride?: string };
    expect(req0.model).toBe('deep-review-model');
    expect(req0.systemPromptOverride).toContain('Deep Reviewer agent');
  });

  it('throws AbortError when callbacks.signal aborts before round 1', async () => {
    const controller = new AbortController();
    controller.abort();
    const { stream } = makePushStream([[{ type: 'done', finishReason: 'stop' }]]);

    await expect(
      runDeepReviewer(makeAddedFileDiff('src/app.ts', 'const x = 1;'), baseOptions({ stream }), {
        onStatus: () => {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('ignores reasoning_delta events while accumulating text', async () => {
    const reportJson = JSON.stringify({ summary: 'OK', comments: [] });
    let toolCallReturn: { call: { tool: string; args: Record<string, unknown> } } | null = {
      call: { tool: 'sandbox_read_file', args: {} },
    };
    const { stream } = makePushStream([
      [
        { type: 'reasoning_delta', text: 'thinking...' },
        { type: 'reasoning_end' },
        { type: 'text_delta', text: 'Investigating...' },
        { type: 'done', finishReason: 'stop' },
      ],
      [
        { type: 'text_delta', text: `[REVIEW_COMPLETE]\n${reportJson}` },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);

    const result = await runDeepReviewer(
      makeAddedFileDiff('src/app.ts', 'const x = 1;'),
      baseOptions({
        stream,
        detectAnyToolCall: () => {
          const next = toolCallReturn;
          toolCallReturn = null;
          return next;
        },
      }),
      { onStatus: () => {} },
    );

    expect(result.summary).toBe('OK');
  });
});
