import { describe, it, expect } from 'vitest';
import {
  runDeepReviewer,
  stripToolScaffolding,
  type DeepReviewerOptions,
} from './deep-reviewer-agent.js';
import type { PushStream, PushStreamEvent } from './provider-contract.js';

const FENCE = '```';
// The exact shape of the leaked turn: narration + two fenced {tool,args} blocks,
// where the first block's closing fence is immediately followed by prose (no
// newline) — the boundary that defeats naive fence handling.
const LEAKED_TURN =
  'Let me check one more thing — whether the scratchpad/todo exampleJson fields use the args wrapper:' +
  FENCE +
  'json\n{"tool": "repo_grep", "args": {"repo": "a/b", "path": "x", "pattern": "y"}}' +
  FENCE +
  'Also check usage:' +
  FENCE +
  'json\n{"tool": "repo_search", "args": {"repo": "a/b", "query": "z"}}' +
  FENCE;

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
      (() => ({
        readOnly: [],
        mutating: null,
        fileMutations: [],
        extraMutations: [],
        droppedCandidates: [],
      })),
    detectAnyToolCall: overrides.detectAnyToolCall ?? (() => null),
    webSearchToolProtocol: '',
  };
}

describe('stripToolScaffolding', () => {
  it('removes fenced tool-call blocks even at an odd closing-fence boundary', () => {
    const out = stripToolScaffolding(LEAKED_TURN);
    expect(out).not.toContain(FENCE);
    expect(out).not.toMatch(/"tool"\s*:/);
    expect(out).not.toContain('repo_grep');
    // Genuine narration survives.
    expect(out).toContain('Let me check one more thing');
  });

  it('strips bare (unfenced) tool-call JSON and infra markers', () => {
    const out = stripToolScaffolding(
      'Result: {"tool": "read", "args": {"path": "a.ts"}} [TOOL_RESULT] noise [/TOOL_RESULT] [REVIEW_COMPLETE]',
    );
    expect(out).not.toMatch(/"tool"\s*:/);
    expect(out).not.toContain('TOOL_RESULT');
    expect(out).not.toContain('REVIEW_COMPLETE');
    expect(out).toContain('Result:');
  });

  it('leaves a clean prose review untouched (minus the completion marker)', () => {
    const prose = 'Summary: looks correct.\nFindings: no blocking issues.';
    expect(stripToolScaffolding(`${prose} [REVIEW_COMPLETE]`)).toBe(prose);
  });
});

describe('runDeepReviewer (PushStream consumer)', () => {
  it('does not post the final forced-output turn when it is still tool calls', async () => {
    // Loop to the round cap: every round emits two read-only calls so the
    // parallel-execution branch runs and the loop continues. The 8th stream
    // invocation is the forced-output turn, where the model ignores the
    // [REVIEW_COMPLETE] prompt and emits the leaked narration + tool JSON.
    const rounds: PushStreamEvent[][] = [];
    for (let i = 0; i < 7; i++) {
      rounds.push([
        { type: 'text_delta', text: `investigating ${i}` },
        { type: 'done', finishReason: 'stop' },
      ]);
    }
    rounds.push([
      { type: 'text_delta', text: LEAKED_TURN },
      { type: 'done', finishReason: 'stop' },
    ]);
    const { stream } = makePushStream(rounds);

    const twoReads = (): ReturnType<DeepReviewerOptions<Call, never>['detectAllToolCalls']> => ({
      readOnly: [
        { call: { tool: 'repo_grep', args: {} } },
        { call: { tool: 'repo_search', args: {} } },
      ],
      mutating: null,
      fileMutations: [],
      extraMutations: [],
      droppedCandidates: [],
    });

    const result = await runDeepReviewer(
      makeAddedFileDiff('src/app.ts', 'const x = 1;'),
      baseOptions({ stream, detectAllToolCalls: twoReads }),
      { onStatus: () => {} },
    );

    // The leak: the raw tool-call turn must never reach the posted summary.
    expect(result.summary).not.toContain(FENCE);
    expect(result.summary).not.toMatch(/"tool"\s*:/);
    expect(result.summary).not.toContain('repo_grep');
    // Still-investigating final turn → neutral fallback, not sliced narration.
    expect(result.summary).toBe('Deep review did not produce structured output.');
  });

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

  it('omits the Web tool from the prompt when webSearchAvailable is false', async () => {
    const reportJson = JSON.stringify({ summary: 'ok', comments: [] });
    const rounds = (): PushStreamEvent[][] => [
      [
        { type: 'text_delta', text: 'Investigating...' },
        { type: 'done', finishReason: 'stop' },
      ],
      [
        { type: 'text_delta', text: `[REVIEW_COMPLETE]\n${reportJson}` },
        { type: 'done', finishReason: 'stop' },
      ],
    ];
    // Returns one tool call (to clear the no-investigation guard), then null.
    const oneTool = () => {
      let next: Call | null = { call: { tool: 'sandbox_read_file', args: {} } };
      return () => {
        const v = next;
        next = null;
        return v;
      };
    };

    const enabled = makePushStream(rounds());
    await runDeepReviewer(
      makeAddedFileDiff('src/a.ts', 'const x = 1;'),
      baseOptions({ stream: enabled.stream, detectAnyToolCall: oneTool() }),
      { onStatus: () => {} },
    );
    const enabledPrompt = (enabled.capturedRequests[0] as { systemPromptOverride?: string })
      .systemPromptOverride;
    expect(enabledPrompt).toContain('- Web:');

    const disabled = makePushStream(rounds());
    await runDeepReviewer(
      makeAddedFileDiff('src/a.ts', 'const x = 1;'),
      {
        ...baseOptions({ stream: disabled.stream, detectAnyToolCall: oneTool() }),
        webSearchAvailable: false,
      },
      { onStatus: () => {} },
    );
    const disabledPrompt = (disabled.capturedRequests[0] as { systemPromptOverride?: string })
      .systemPromptOverride;
    expect(disabledPrompt).not.toContain('- Web:');
    // GitHub tools still listed — only the Web tool is dropped.
    expect(disabledPrompt).toContain('- GitHub:');
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
