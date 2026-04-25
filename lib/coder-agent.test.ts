import { describe, it, expect } from 'vitest';
import { generateCheckpointAnswer, runCoderAgent, type CoderAgentOptions } from './coder-agent.js';
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
      (() => ({ readOnly: [], mutating: null, fileMutations: [], extraMutations: [] })),
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
});
