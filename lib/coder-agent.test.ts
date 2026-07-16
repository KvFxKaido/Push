import { describe, it, expect, vi } from 'vitest';
import {
  generateCheckpointAnswer,
  resolveLeadRoundOptions,
  runCoderAgent,
  SandboxUnreachableError,
  type CoderAgentOptions,
  type CoderLoopMessage,
} from './coder-agent.js';
import { toGeminiGenerateContent } from './gemini-bridge.js';
import { ANNOUNCED_NO_ACTION_POLICY_MARKER } from './tool-call-recovery.js';
import type {
  LlmContentPart,
  PushStream,
  PushStreamEvent,
  ToolFunctionSchema,
} from './provider-contract.js';
import type { RunEventInput } from './runtime-contract.js';
import type { ToolCard } from './tool-cards.js';

type Call = { call: { tool: string; args: Record<string, unknown> }; thoughtSignature?: string };

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
  detectAnyToolCall?: CoderAgentOptions<Call>['detectAnyToolCall'];
  detectAllToolCalls?: CoderAgentOptions<Call>['detectAllToolCalls'];
  evaluateAfterModel?: CoderAgentOptions<Call>['evaluateAfterModel'];
  leadMode?: boolean;
  leadToolGuidance?: boolean;
  leadToolScope?: CoderAgentOptions<Call>['leadToolScope'];
  harnessMaxRounds?: number;
  initialMessages?: CoderAgentOptions<Call>['initialMessages'];
  initialUserContentParts?: LlmContentPart[];
  linkedLibraryContent?: string;
  sessionDigestRecords?: CoderAgentOptions<Call>['sessionDigestRecords'];
  priorSessionDigest?: CoderAgentOptions<Call>['priorSessionDigest'];
  onSessionDigestEmitted?: CoderAgentOptions<Call>['onSessionDigestEmitted'];
  resumeState?: CoderAgentOptions<Call>['resumeState'];
  repeatExemptTools?: CoderAgentOptions<Call>['repeatExemptTools'];
  adaptMaxRounds?: CoderAgentOptions<Call>['adaptMaxRounds'];
  toolExec?: CoderAgentOptions<Call>['toolExec'];
}): CoderAgentOptions<Call> {
  return {
    provider: 'openrouter',
    stream: overrides.stream,
    modelId: 'coder-model',
    persona: overrides.leadMode ? 'lead' : 'coder',
    leadToolGuidance: overrides.leadToolGuidance,
    leadToolScope: overrides.leadToolScope,
    harnessMaxRounds: overrides.harnessMaxRounds,
    sandboxId: 'sb-1',
    allowedRepo: 'kvfxkaido/push',
    userProfile: null,
    taskPreamble: 'Implement the auth fix.',
    initialMessages: overrides.initialMessages,
    initialUserContentParts: overrides.initialUserContentParts,
    linkedLibraryContent: overrides.linkedLibraryContent,
    sessionDigestRecords: overrides.sessionDigestRecords,
    priorSessionDigest: overrides.priorSessionDigest,
    onSessionDigestEmitted: overrides.onSessionDigestEmitted,
    symbolSummary: null,
    resumeState: overrides.resumeState,
    repeatExemptTools: overrides.repeatExemptTools,
    adaptMaxRounds: overrides.adaptMaxRounds,
    toolExec: overrides.toolExec ?? (async () => ({ kind: 'executed', resultText: 'tool ok' })),
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

describe('runCoderAgent — adaptMaxRounds seam', () => {
  const loopingRounds = (): PushStreamEvent[][] =>
    Array.from({ length: 10 }, () => [
      { type: 'text_delta', text: 'working' },
      { type: 'done', finishReason: 'stop' },
    ]);
  const repeatedRead = { call: { tool: 'sandbox_read_file', args: { path: 'a' } } };
  const detectRepeatedRead = () => ({
    readOnly: [repeatedRead],
    mutating: null,
    fileMutations: [],
    extraMutations: [],
    droppedCandidates: [],
  });

  it('stops at an adapted cap that shrinks below harnessMaxRounds', async () => {
    const { stream } = makePushStream(loopingRounds());
    const seen: Array<{ round: number; currentMaxRounds: number }> = [];
    const result = await runCoderAgent(
      baseCoderOptions({
        stream,
        leadMode: false,
        harnessMaxRounds: 50,
        detectAllToolCalls: detectRepeatedRead,
        detectAnyToolCall: () => repeatedRead,
        evaluateAfterModel: async () => null,
        adaptMaxRounds: (ctx) => {
          seen.push(ctx);
          return 3;
        },
      }),
      { onStatus: () => {} },
    );
    // The hook's 3 wins over harnessMaxRounds: 50.
    expect(result.stopReason).toBe('max_rounds');
    expect(result.rounds).toBe(3);
    // Called every round; round 0 sees the initial (pre-adaptation) cap.
    expect(seen[0]).toEqual({ round: 0, currentMaxRounds: 50 });
    expect(seen.map((s) => s.round)).toEqual([0, 1, 2, 3]);
  });

  it('runs to an adapted cap that grows above harnessMaxRounds', async () => {
    const { stream } = makePushStream(loopingRounds());
    const result = await runCoderAgent(
      baseCoderOptions({
        stream,
        leadMode: false,
        harnessMaxRounds: 2,
        detectAllToolCalls: detectRepeatedRead,
        detectAnyToolCall: () => repeatedRead,
        evaluateAfterModel: async () => null,
        adaptMaxRounds: () => 6,
      }),
      { onStatus: () => {} },
    );
    // Without the hook this stops at 2; grown to 6, it runs to 6.
    expect(result.stopReason).toBe('max_rounds');
    expect(result.rounds).toBe(6);
  });
});

describe('resolveLeadRoundOptions', () => {
  it('gives a lead turn no explicit cap, with the surface tool scope', () => {
    expect(resolveLeadRoundOptions({ isLead: true, maxCoderRounds: 30, surface: 'full' })).toEqual({
      persona: 'lead',
      harnessMaxRounds: undefined,
      leadToolScope: 'full',
    });
    expect(
      resolveLeadRoundOptions({ isLead: true, maxCoderRounds: 30, surface: 'sandbox' }),
    ).toEqual({
      persona: 'lead',
      harnessMaxRounds: undefined,
      leadToolScope: 'sandbox',
    });
  });

  it('defaults a lead surface to the full tool scope', () => {
    expect(resolveLeadRoundOptions({ isLead: true }).leadToolScope).toBe('full');
  });

  it('keeps the configured cap for a delegated sub-Coder, no tool scope', () => {
    expect(resolveLeadRoundOptions({ isLead: false, maxCoderRounds: 30 })).toEqual({
      persona: 'coder',
      harnessMaxRounds: 30,
      leadToolScope: undefined,
    });
    expect(resolveLeadRoundOptions({ isLead: false })).toEqual({
      persona: 'coder',
      harnessMaxRounds: undefined,
      leadToolScope: undefined,
    });
  });

  it('keeps the foreground and background lead lanes in lockstep on cap + persona', () => {
    // Same intent, different surfaces (inline 'full' vs background DO 'sandbox')
    // → identical persona + cap; only the tool scope differs.
    const foreground = resolveLeadRoundOptions({
      isLead: true,
      maxCoderRounds: 30,
      surface: 'full',
    });
    const background = resolveLeadRoundOptions({
      isLead: true,
      maxCoderRounds: 30,
      surface: 'sandbox',
    });
    expect(foreground.persona).toBe(background.persona);
    expect(foreground.harnessMaxRounds).toBe(background.harnessMaxRounds);
    expect(foreground.leadToolScope).not.toBe(background.leadToolScope);
  });
});

describe('runCoderAgent (PushStream consumer) — forceToolChoiceNextRound escalation', () => {
  // A model that announces a tool action but never emits one (the "let me
  // actually run the tools now" symptom) keeps dead-ending even after a
  // text-only nudge — the model just re-announces. When
  // `evaluateAfterModel` signals `forceToolChoiceNextRound` (the
  // announced-no-action nudge), the NEXT round's request must force
  // `tool_choice: 'required'` so the API itself can't return prose-only,
  // then clear the escalation so it doesn't stick on every later round.
  const NATIVE_TOOLS: ToolFunctionSchema[] = [
    { name: 'sandbox_read_file', description: 'Read a file', input_schema: { type: 'object' } },
  ];

  it('forces tool_choice: required on the round after the announced-no-action nudge, then clears it', async () => {
    const { stream, capturedRequests } = makePushStream([
      [
        { type: 'text_delta', text: 'let me actually run the tools now' },
        { type: 'done', finishReason: 'stop' },
      ],
      [
        { type: 'text_delta', text: 'let me actually run the tools now, again' },
        { type: 'done', finishReason: 'stop' },
      ],
      [
        { type: 'text_delta', text: 'Done, no further action needed.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);

    let calls = 0;
    const evaluateAfterModel = async () => {
      calls += 1;
      if (calls <= 2) {
        return {
          action: 'inject' as const,
          content: `${ANNOUNCED_NO_ACTION_POLICY_MARKER}\nEmit the tool call now.`,
          forceToolChoiceNextRound: true,
        };
      }
      return { action: 'halt' as const, summary: 'done' };
    };

    await runCoderAgent(
      { ...baseCoderOptions({ stream, evaluateAfterModel }), nativeToolSchemas: NATIVE_TOOLS },
      { onStatus: () => {} },
    );

    const requests = capturedRequests as Array<{ toolChoice?: string }>;
    expect(requests).toHaveLength(3);
    // Round 0: nothing to force yet.
    expect(requests[0]?.toolChoice).toBeUndefined();
    // Round 1: forced after round 0's nudge fired.
    expect(requests[1]?.toolChoice).toBe('required');
    // Round 2: round 1 re-triggered the nudge, so still forced.
    expect(requests[2]?.toolChoice).toBe('required');
  });

  it('does not force tool_choice when no native tools are attached (nothing to force)', async () => {
    const { stream, capturedRequests } = makePushStream([
      [
        { type: 'text_delta', text: 'let me actually run the tools now' },
        { type: 'done', finishReason: 'stop' },
      ],
      [
        { type: 'text_delta', text: 'Done.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);

    let calls = 0;
    const evaluateAfterModel = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          action: 'inject' as const,
          content: `${ANNOUNCED_NO_ACTION_POLICY_MARKER}\nEmit the tool call now.`,
          forceToolChoiceNextRound: true,
        };
      }
      return { action: 'halt' as const, summary: 'done' };
    };

    await runCoderAgent(baseCoderOptions({ stream, evaluateAfterModel }), { onStatus: () => {} });

    const requests = capturedRequests as Array<{ toolChoice?: string }>;
    expect(requests[1]?.toolChoice).toBeUndefined();
  });

  it('does not force tool_choice for unrelated inject nudges (e.g. drift correction)', async () => {
    const { stream, capturedRequests } = makePushStream([
      [
        { type: 'text_delta', text: 'drifting response' },
        { type: 'done', finishReason: 'stop' },
      ],
      [
        { type: 'text_delta', text: 'Done.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);

    let calls = 0;
    const evaluateAfterModel = async () => {
      calls += 1;
      if (calls === 1) {
        return {
          action: 'inject' as const,
          content: '[POLICY: DRIFT_DETECTED]\nRe-read your task.',
          forceToolChoiceNextRound: false,
        };
      }
      return { action: 'halt' as const, summary: 'done' };
    };

    await runCoderAgent(
      { ...baseCoderOptions({ stream, evaluateAfterModel }), nativeToolSchemas: NATIVE_TOOLS },
      { onStatus: () => {} },
    );

    const requests = capturedRequests as Array<{ toolChoice?: string }>;
    expect(requests[1]?.toolChoice).toBeUndefined();
  });
});

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

  it('sets multipart content on the initial user turn only for fresh runs', async () => {
    const initialUserContentParts: LlmContentPart[] = [
      { type: 'text', text: 'Implement the auth fix.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
    ];
    const { stream, capturedRequests } = makePushStream([
      [
        { type: 'text_delta', text: 'I am done.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);

    await runCoderAgent(baseCoderOptions({ stream, initialUserContentParts }), {
      onStatus: () => {},
    });

    const freshReq = capturedRequests[0] as {
      messages: Array<{ id: string; content: string; contentParts?: LlmContentPart[] }>;
    };
    expect(freshReq.messages[0]).toMatchObject({
      id: 'coder-task',
      content: 'Implement the auth fix.',
      contentParts: initialUserContentParts,
    });

    const resumed = makePushStream([
      [
        { type: 'text_delta', text: 'Resumed.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);
    await runCoderAgent(
      baseCoderOptions({
        stream: resumed.stream,
        initialUserContentParts,
        resumeState: {
          round: 0,
          messages: [{ id: 'resume-user', role: 'user', content: 'Resume text', timestamp: 1 }],
          workingMemory: {},
          cards: [],
        },
      }),
      { onStatus: () => {} },
    );

    const resumeReq = resumed.capturedRequests[0] as {
      messages: Array<{ id: string; content: string; contentParts?: LlmContentPart[] }>;
    };
    expect(resumeReq.messages[0]).toMatchObject({
      id: 'resume-user',
      content: 'Resume text',
    });
    expect(resumeReq.messages[0]?.contentParts).toBeUndefined();
  });

  it('seeds fresh conversational runs from initialMessages and renders library context', async () => {
    const { stream, capturedRequests } = makePushStream([
      [
        { type: 'text_delta', text: 'I am done.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);
    const initialMessages = [
      { id: 'u1', role: 'user' as const, content: 'earlier question', timestamp: 1 },
      { id: 'a1', role: 'assistant' as const, content: 'earlier answer', timestamp: 2 },
      { id: 'u2', role: 'user' as const, content: 'current question', timestamp: 3 },
    ];

    const onSessionDigestEmitted = () => {};
    await runCoderAgent(
      baseCoderOptions({
        stream,
        leadMode: true,
        initialMessages,
        linkedLibraryContent: '# Linked libraries\n\n## Library: Design notes',
        sessionDigestRecords: [],
        priorSessionDigest: undefined,
        onSessionDigestEmitted,
      }),
      { onStatus: () => {} },
    );

    const req = capturedRequests[0] as {
      messages: Array<{ content: string }>;
      systemPromptOverride?: string;
      sessionDigestRecords?: unknown;
      onSessionDigestEmitted?: unknown;
    };
    expect(req.messages.slice(0, 3).map((m) => m.content)).toEqual([
      'earlier question',
      'earlier answer',
      'current question',
    ]);
    expect(req.messages.some((m) => m.content === 'Implement the auth fix.')).toBe(false);
    expect(req.systemPromptOverride).toContain('# Linked libraries');
    expect(req.systemPromptOverride).toContain('Design notes');
    // The digest inputs are forwarded on the request so the stream's
    // toLLMMessages runs the single context transform (no pre-transform).
    expect(req.sessionDigestRecords).toEqual([]);
    expect(req.onSessionDigestEmitted).toBe(onSessionDigestEmitted);
  });

  it('swaps the implementer prompt for lead-mode framing when leadMode is set', async () => {
    const promptFor = async (leadMode: boolean, leadToolGuidance = false): Promise<string> => {
      const { stream, capturedRequests } = makePushStream([
        [
          { type: 'text_delta', text: 'ok' },
          { type: 'done', finishReason: 'stop' },
        ],
      ]);
      await runCoderAgent(baseCoderOptions({ stream, leadMode, leadToolGuidance }), {
        onStatus: () => {},
      });
      return (capturedRequests[0] as { systemPromptOverride?: string }).systemPromptOverride ?? '';
    };

    // Web lead: leadMode + the web tool-guidance opt-in.
    const lead = await promptFor(true, true);
    expect(lead).toContain(
      'You are `coder-model`, served via OpenRouter, working as the lead in this chat',
    );
    expect(lead).toContain('do NOT use that Done/Changed/Verified/Open template');
    expect(lead).not.toContain('Read the delegation brief');
    expect(lead).not.toContain('the Orchestrator');
    // Ported-from-Orchestrator sections the inline lead regained.
    expect(lead).toContain('Voice:');
    expect(lead).toContain('Vary your openings');
    expect(lead).toContain('Never mention other repos');
    expect(lead).toContain('## Tool Call Placement');
    expect(lead).toContain('## Tool Routing');
    expect(lead).toContain('## Error Handling');
    expect(lead).toContain('SANDBOX_UNREACHABLE → treat sandbox loss as recoverable');
    expect(lead).toContain('inspect the current tree');
    expect(lead).not.toContain('the sandbox likely expired; tell the user');
    expect(lead).toContain('GIT_GUARD_BLOCKED');

    // CLI-style lead: leadMode without the web tool-guidance opt-in. The
    // name-free placement boundary + voice still apply, but the web-named
    // routing/error block is withheld so it can't steer toward unknown tools.
    const cliLead = await promptFor(true, false);
    expect(cliLead).toContain('Voice:');
    expect(cliLead).toContain('## Tool Call Placement');
    expect(cliLead).not.toContain('## Tool Routing');
    expect(cliLead).not.toContain('## Error Handling');

    const coder = await promptFor(false);
    expect(coder).toContain('You are the Coder agent');
    expect(coder).toContain('Read the delegation brief');
    // The delegated Coder keeps its narrower prompt — none of the lead-only
    // sections leak into it (full scoping, not just the voice/routing headers).
    expect(coder).not.toContain('Voice:');
    expect(coder).not.toContain('## Tool Routing');
    expect(coder).not.toContain('## Tool Call Placement');
    expect(coder).not.toContain('## Error Handling');
  });

  it('scopes lead guidance to the sandbox surface — no PR/CI/merge tool steering', async () => {
    const promptFor = async (leadToolScope: 'full' | 'sandbox'): Promise<string> => {
      const { stream, capturedRequests } = makePushStream([
        [
          { type: 'text_delta', text: 'ok' },
          { type: 'done', finishReason: 'stop' },
        ],
      ]);
      await runCoderAgent(baseCoderOptions({ stream, leadMode: true, leadToolScope }), {
        onStatus: () => {},
      });
      return (capturedRequests[0] as { systemPromptOverride?: string }).systemPromptOverride ?? '';
    };

    const full = await promptFor('full');
    // The web inline lead keeps the GitHub PR/CI references.
    expect(full).toContain('inspect PRs / commits / CI');
    expect(full).toMatch(/Avoid .*unless the user explicitly asks to open or merge a PR/);

    const sandbox = await promptFor('sandbox');
    // Still the lead — conversational framing + the closing template stay.
    expect(sandbox).toContain(
      'You are `coder-model`, served via OpenRouter, working as the lead in this chat',
    );
    expect(sandbox).toContain('do NOT use that Done/Changed/Verified/Open template');
    // …but the surface can't run GitHub PR/CI/merge/promote tools, so the
    // guidance must not steer the model toward them.
    expect(sandbox).not.toContain('inspect PRs / commits / CI');
    expect(sandbox).not.toMatch(/open or merge a PR/);
    expect(sandbox).toContain('cannot open or merge PRs, promote to GitHub, create artifacts');
    expect(sandbox).toContain('after a meaningful verified edit');
    expect(sandbox).not.toContain('session likely expired');
  });

  it('lead hitting the round cap closes gracefully — no Coder / round count / tool name', async () => {
    const rounds: PushStreamEvent[][] = Array.from({ length: 4 }, () => [
      { type: 'text_delta', text: 'working' },
      { type: 'done', finishReason: 'stop' },
    ]);
    const { stream } = makePushStream(rounds);
    // Keep emitting read-only calls and never halt, so the loop runs to the cap.
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
    const result = await runCoderAgent(
      baseCoderOptions({
        stream,
        leadMode: true,
        harnessMaxRounds: 2,
        detectAllToolCalls,
        evaluateAfterModel: async () => null,
      }),
      {
        onStatus: () => {},
        fetchSandboxStateSummary: async () => '\n\n[Sandbox State] 1 file changed',
      },
    );
    expect(result.summary).toContain("I'm stopping here");
    expect(result.summary).toContain('[Sandbox State] 1 file changed');
    expect(result.summary).not.toContain('Coder');
    expect(result.summary).not.toContain('sandbox_diff');
    expect(result.summary).not.toMatch(/\d+\s*round/i);
  });

  it('lead cap close has no dangling tail when no sandbox-state callback is wired', async () => {
    const rounds: PushStreamEvent[][] = Array.from({ length: 4 }, () => [
      { type: 'text_delta', text: 'working' },
      { type: 'done', finishReason: 'stop' },
    ]);
    const { stream } = makePushStream(rounds);
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
    // No fetchSandboxStateSummary (the CLI lead path) → sandboxState is ''.
    const result = await runCoderAgent(
      baseCoderOptions({
        stream,
        leadMode: true,
        harnessMaxRounds: 2,
        detectAllToolCalls,
        evaluateAfterModel: async () => null,
      }),
      { onStatus: () => {} },
    );
    expect(result.summary).toContain('looping further.');
    // The "here's where things stand:" tail is dropped, so no dangling colon.
    expect(result.summary).not.toContain('stand:');
    expect(result.summary.trimEnd().endsWith(':')).toBe(false);
  });

  it('delegated Coder hitting the round cap keeps its Orchestrator-facing marker', async () => {
    const rounds: PushStreamEvent[][] = Array.from({ length: 4 }, () => [
      { type: 'text_delta', text: 'working' },
      { type: 'done', finishReason: 'stop' },
    ]);
    const { stream } = makePushStream(rounds);
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
    const result = await runCoderAgent(
      baseCoderOptions({
        stream,
        leadMode: false,
        harnessMaxRounds: 2,
        detectAllToolCalls,
        evaluateAfterModel: async () => null,
      }),
      { onStatus: () => {} },
    );
    expect(result.summary).toContain('[Coder stopped after 2 rounds');
    expect(result.summary).toContain('sandbox_diff');
  });

  it('lead aborts on a consecutive identical tool call (exact-repeat breaker)', async () => {
    const rounds: PushStreamEvent[][] = Array.from({ length: 6 }, () => [
      { type: 'text_delta', text: 'working' },
      { type: 'done', finishReason: 'stop' },
    ]);
    const { stream } = makePushStream(rounds);
    // The SAME single read every round, nothing intervening — the
    // consecutive-identical streak accrues until the oracle aborts. (A
    // multi-call batch would reset the streak; see the round-cap tests above.)
    // A lone call routes through the single-call path, so `detectAnyToolCall`
    // must return it too or the loop halts at round 0 with no call to run.
    const call = { call: { tool: 'sandbox_read_file', args: { path: 'a' } } };
    const detectAllToolCalls = () => ({
      readOnly: [call],
      mutating: null,
      fileMutations: [],
      extraMutations: [],
      droppedCandidates: [],
    });
    const result = await runCoderAgent(
      baseCoderOptions({
        stream,
        leadMode: true,
        // Higher than EXACT_REPEAT_LIMIT so the loop breaker fires before the cap.
        harnessMaxRounds: 10,
        detectAllToolCalls,
        detectAnyToolCall: () => call,
        evaluateAfterModel: async () => null,
      }),
      { onStatus: () => {} },
    );
    expect(result.stopReason).toBe('loop');
    expect(result.summary).toContain('Detected repeated tool call loop');
    // Aborts on the 4th identical call (limit 3), not at the round cap.
    expect(result.rounds).toBe(4);
  });

  it('delegated Coder does not take the lead-only exact-repeat breaker', async () => {
    const rounds: PushStreamEvent[][] = Array.from({ length: 6 }, () => [
      { type: 'text_delta', text: 'working' },
      { type: 'done', finishReason: 'stop' },
    ]);
    const { stream } = makePushStream(rounds);
    const call = { call: { tool: 'sandbox_read_file', args: { path: 'a' } } };
    const detectAllToolCalls = () => ({
      readOnly: [call],
      mutating: null,
      fileMutations: [],
      extraMutations: [],
      droppedCandidates: [],
    });
    const result = await runCoderAgent(
      baseCoderOptions({
        stream,
        leadMode: false,
        harnessMaxRounds: 3,
        detectAllToolCalls,
        detectAnyToolCall: () => call,
        evaluateAfterModel: async () => null,
      }),
      { onStatus: () => {} },
    );
    // Same repeated call, but the exact-repeat breaker is lead-only — the
    // delegated Coder runs to the round cap instead of aborting on the loop.
    expect(result.stopReason).toBe('max_rounds');
  });

  it('lead does not abort on a repeated poll-exempt call (e.g. exec_poll)', async () => {
    const rounds: PushStreamEvent[][] = Array.from({ length: 8 }, () => [
      { type: 'text_delta', text: 'working' },
      { type: 'done', finishReason: 'stop' },
    ]);
    const { stream } = makePushStream(rounds);
    // Polling a quiet long-running command: the SAME exec_poll every round.
    // Without the exemption this would abort as a loop on the 4th poll; with
    // it, the lead keeps polling until the round cap.
    const call = { call: { tool: 'exec_poll', args: { session_id: 's1', from_seq: 0 } } };
    const detectAllToolCalls = () => ({
      readOnly: [call],
      mutating: null,
      fileMutations: [],
      extraMutations: [],
      droppedCandidates: [],
    });
    const result = await runCoderAgent(
      baseCoderOptions({
        stream,
        leadMode: true,
        harnessMaxRounds: 6,
        detectAllToolCalls,
        detectAnyToolCall: () => call,
        repeatExemptTools: new Set(['exec_poll']),
        evaluateAfterModel: async () => null,
      }),
      { onStatus: () => {} },
    );
    // No loop abort — exec_poll is exempt, so it runs to the round cap.
    expect(result.stopReason).toBe('max_rounds');
  });

  it('surfaces overflowed calls (extraMutations) to the model instead of dropping them silently', async () => {
    const rounds: PushStreamEvent[][] = Array.from({ length: 3 }, () => [
      { type: 'text_delta', text: 'working' },
      { type: 'done', finishReason: 'stop' },
    ]);
    const { stream } = makePushStream(rounds);
    // Two parallel reads (so the batch path runs) plus one call the grouper
    // rejected into extraMutations — e.g. a third parallel Explorer past the
    // cap-of-2. The executable batch never runs it, so the kernel must surface
    // it rather than silently drop it.
    const detectAllToolCalls = () => ({
      readOnly: [
        { call: { tool: 'sandbox_read_file', args: { path: 'a' } } },
        { call: { tool: 'sandbox_read_file', args: { path: 'b' } } },
      ],
      parallelDelegations: [],
      mutating: null,
      fileMutations: [],
      extraMutations: [{ call: { tool: 'delegate_explorer', args: { task: 'third thread' } } }],
      droppedCandidates: [],
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runCoderAgent(
        baseCoderOptions({
          stream,
          leadMode: true,
          harnessMaxRounds: 5,
          detectAllToolCalls,
          // Halt on the second round, after round 0 ran the batch + the notice.
          evaluateAfterModel: async (_response: string, round: number) =>
            round >= 1 ? ({ action: 'halt', summary: 'done' } as const) : null,
        }),
        { onStatus: () => {} },
      );
      const overflowLog = logSpy.mock.calls
        .map((c) => String(c[0]))
        .find((line) => line.includes('coder_turn_overflow_dropped'));
      expect(overflowLog).toBeTruthy();
      expect(JSON.parse(overflowLog as string)).toMatchObject({
        event: 'coder_turn_overflow_dropped',
        count: 1,
        tools: 'delegate_explorer',
      });
    } finally {
      logSpy.mockRestore();
    }
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

  it('writes linked tool_use/tool_result sidecars for handled batched calls', async () => {
    const { stream } = makePushStream(
      Array.from({ length: 2 }, () => [
        { type: 'text_delta' as const, text: 'reading files' },
        { type: 'done' as const, finishReason: 'stop' as const },
      ]),
    );
    const readA = { call: { tool: 'sandbox_read_file', args: { path: 'a.ts' } } };
    const readB = { call: { tool: 'sandbox_read_file', args: { path: 'b.ts' } } };
    const detectAllToolCalls = () => ({
      readOnly: [readA, readB],
      mutating: null,
      fileMutations: [],
      extraMutations: [],
      droppedCandidates: [],
    });
    const toolExec = async (call: Call) => ({
      kind: 'executed' as const,
      resultText: `contents:${call.call.args.path}`,
    });
    const evaluateAfterModel = async (_response: string, round: number) =>
      round >= 1 ? ({ action: 'halt', summary: 'done' } as const) : null;
    const checkpointMessages: CoderLoopMessage[][] = [];

    const result = await runCoderAgent(
      {
        ...baseCoderOptions({ stream, detectAllToolCalls, evaluateAfterModel }),
        toolExec,
        checkpointCadenceRounds: 1,
      },
      {
        onStatus: () => {},
        onCheckpoint: async (state) => {
          checkpointMessages.push(state.messages.map((m) => ({ ...m })));
        },
      },
    );

    const messages = checkpointMessages[0] ?? [];
    expect(messages.length).toBeGreaterThan(0);
    const assistant = messages.find((m) => m.isToolCall);
    const results = messages.filter((m) => m.isToolResult);

    expect(assistant?.toolUses).toEqual([
      expect.objectContaining({
        type: 'tool_use',
        name: 'sandbox_read_file',
        input: { path: 'a.ts' },
      }),
      expect.objectContaining({
        type: 'tool_use',
        name: 'sandbox_read_file',
        input: { path: 'b.ts' },
      }),
    ]);
    expect(results).toHaveLength(2);
    expect(results[0].toolResults).toEqual([
      {
        type: 'tool_result',
        tool_use_id: assistant?.toolUses?.[0]?.id,
        content: 'contents:a.ts',
      },
    ]);
    expect(results[1].toolResults).toEqual([
      {
        type: 'tool_result',
        tool_use_id: assistant?.toolUses?.[1]?.id,
        content: 'contents:b.ts',
      },
    ]);
  });

  it('carries the round reasoning onto the tool-call turn as reasoningContent (DeepSeek replay)', async () => {
    // DeepSeek thinking mode 400s the tool-result continuation unless the
    // assistant tool-call turn echoes its `reasoning_content`. The kernel
    // accumulates the round's plain reasoning from `reasoning_delta`; it must land
    // on the committed `coder-response` message — which `markLatestAssistantToolUse`
    // spreads into the tool-call turn — so the wire serializer emits
    // `reasoning_content` on replay. Regression for the live web-inline + CLI 400.
    const reasoning = 'I should list the recent commits before answering.';
    const { stream } = makePushStream([
      [
        { type: 'reasoning_delta' as const, text: reasoning },
        { type: 'reasoning_end' as const },
        { type: 'text_delta' as const, text: 'Checking the commit history.' },
        { type: 'done' as const, finishReason: 'stop' as const },
      ],
      [
        { type: 'text_delta' as const, text: 'All set.' },
        { type: 'done' as const, finishReason: 'stop' as const },
      ],
    ]);
    // Two read-only calls so round 0 runs the parallel-batch path (which marks the
    // assistant tool-call turn) and advances to a checkpointed round 1.
    const detectAllToolCalls = () => ({
      readOnly: [
        { call: { tool: 'list_commits', args: {} } },
        { call: { tool: 'sandbox_read_file', args: { path: 'a.ts' } } },
      ],
      mutating: null,
      fileMutations: [],
      extraMutations: [],
      droppedCandidates: [],
    });
    const toolExec = async () => ({ kind: 'executed' as const, resultText: 'ok' });
    // Halt after round 1; only round 0 emits reasoning_delta.
    const evaluateAfterModel = async (_response: string, round: number) =>
      round >= 1 ? ({ action: 'halt', summary: 'done' } as const) : null;
    const checkpointMessages: CoderLoopMessage[][] = [];

    await runCoderAgent(
      {
        ...baseCoderOptions({ stream, detectAllToolCalls, evaluateAfterModel }),
        toolExec,
        checkpointCadenceRounds: 1,
      },
      {
        onStatus: () => {},
        onCheckpoint: async (state) => {
          checkpointMessages.push(state.messages.map((m) => ({ ...m })));
        },
      },
    );

    // The first checkpoint snapshots round 0, including the assistant tool-call
    // turn that the next round replays to DeepSeek.
    const toolCallTurn = (checkpointMessages[0] ?? []).find((m) => m.isToolCall);
    expect(toolCallTurn?.toolUses?.length).toBeGreaterThan(0);
    // The round's reasoning rides onto that turn → serializes to reasoning_content.
    expect(toolCallTurn?.reasoningContent).toBe(reasoning);
  });

  it('carries signed reasoning blocks onto the tool-call turn for Anthropic replay', async () => {
    const reasoningBlock = {
      type: 'thinking' as const,
      text: 'Need the file contents before editing.',
      signature: 'sig-thinking-1',
    };
    const { stream } = makePushStream([
      [
        { type: 'reasoning_delta' as const, text: reasoningBlock.text },
        { type: 'reasoning_block' as const, block: reasoningBlock },
        { type: 'text_delta' as const, text: 'Reading the target files.' },
        { type: 'done' as const, finishReason: 'stop' as const },
      ],
      [
        { type: 'text_delta' as const, text: 'Done.' },
        { type: 'done' as const, finishReason: 'stop' as const },
      ],
    ]);
    const detectAllToolCalls = () => ({
      readOnly: [
        { call: { tool: 'sandbox_read_file', args: { path: 'a.ts' } } },
        { call: { tool: 'sandbox_read_file', args: { path: 'b.ts' } } },
      ],
      mutating: null,
      fileMutations: [],
      extraMutations: [],
      droppedCandidates: [],
    });
    const toolExec = async () => ({ kind: 'executed' as const, resultText: 'ok' });
    const evaluateAfterModel = async (_response: string, round: number) =>
      round >= 1 ? ({ action: 'halt', summary: 'done' } as const) : null;
    const checkpointMessages: CoderLoopMessage[][] = [];

    await runCoderAgent(
      {
        ...baseCoderOptions({ stream, detectAllToolCalls, evaluateAfterModel }),
        toolExec,
        checkpointCadenceRounds: 1,
      },
      {
        onStatus: () => {},
        onCheckpoint: async (state) => {
          checkpointMessages.push(state.messages.map((m) => ({ ...m })));
        },
      },
    );

    const toolCallTurn = (checkpointMessages[0] ?? []).find((m) => m.isToolCall);
    expect(toolCallTurn?.toolUses?.length).toBeGreaterThan(0);
    expect(toolCallTurn?.reasoningBlocks).toEqual([reasoningBlock]);
  });

  it('round-trips Gemini thoughtSignature through delegated Coder tool_use sidecars', async () => {
    const { stream } = makePushStream(
      Array.from({ length: 2 }, () => [
        { type: 'text_delta' as const, text: 'reading files' },
        { type: 'done' as const, finishReason: 'stop' as const },
      ]),
    );
    const signedRead: Call = {
      call: { tool: 'sandbox_read_file', args: { path: 'signed.ts' } },
      thoughtSignature: 'AgQKAabc123==',
    };
    const unsignedRead: Call = {
      call: { tool: 'sandbox_read_file', args: { path: 'unsigned.ts' } },
    };
    const detectAllToolCalls = () => ({
      readOnly: [signedRead, unsignedRead],
      mutating: null,
      fileMutations: [],
      extraMutations: [],
      droppedCandidates: [],
    });
    const toolExec = async (call: Call) => ({
      kind: 'executed' as const,
      resultText: `contents:${call.call.args.path}`,
    });
    const evaluateAfterModel = async (_response: string, round: number) =>
      round >= 1 ? ({ action: 'halt', summary: 'done' } as const) : null;
    const checkpointMessages: CoderLoopMessage[][] = [];

    await runCoderAgent(
      {
        ...baseCoderOptions({ stream, detectAllToolCalls, evaluateAfterModel }),
        toolExec,
        checkpointCadenceRounds: 1,
      },
      {
        onStatus: () => {},
        onCheckpoint: async (state) => {
          checkpointMessages.push(state.messages.map((m) => ({ ...m })));
        },
      },
    );

    const messages = checkpointMessages[0] ?? [];
    const assistant = messages.find((m) => m.isToolCall);
    expect(assistant?.toolUses?.[0]).toEqual(
      expect.objectContaining({
        type: 'tool_use',
        name: 'sandbox_read_file',
        input: { path: 'signed.ts' },
        thoughtSignature: 'AgQKAabc123==',
      }),
    );
    expect(assistant?.toolUses?.[1]).toEqual(
      expect.objectContaining({
        type: 'tool_use',
        name: 'sandbox_read_file',
        input: { path: 'unsigned.ts' },
      }),
    );
    expect(assistant?.toolUses?.[1]).not.toHaveProperty('thoughtSignature');

    const body = toGeminiGenerateContent({
      provider: 'google',
      model: 'gemini-3.1-pro-preview',
      messages,
    });
    const contents = body.contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    const parts =
      contents.find(
        (content) =>
          content.role === 'model' &&
          content.parts.some((part) => Object.hasOwn(part, 'functionCall')),
      )?.parts ?? [];
    expect(parts).toEqual([
      {
        functionCall: {
          id: assistant?.toolUses?.[0]?.id,
          name: 'sandbox_read_file',
          args: { path: 'signed.ts' },
        },
        thoughtSignature: 'AgQKAabc123==',
      },
      {
        functionCall: {
          id: assistant?.toolUses?.[1]?.id,
          name: 'sandbox_read_file',
          args: { path: 'unsigned.ts' },
        },
      },
    ]);
    expect(parts[1]).not.toHaveProperty('thoughtSignature');
  });

  it('round-trips a Gemini thoughtSignature nested under .call (CLI CliKernelCall shape)', async () => {
    // On the CLI, the shared dispatcher attaches `thoughtSignature` to the inner
    // matched call, which the lead binding re-wraps as `{ source, call }` — so the
    // signature sits at `.call.thoughtSignature`, not top-level like the web shape.
    // The kernel must read both positions. (#1162 / Gemini signature CLI path.)
    const { stream } = makePushStream(
      Array.from({ length: 2 }, () => [
        { type: 'text_delta' as const, text: 'reading' },
        { type: 'done' as const, finishReason: 'stop' as const },
      ]),
    );
    // Nested shape: thoughtSignature under `.call`, not top-level.
    const signedRead = {
      call: {
        tool: 'sandbox_read_file',
        args: { path: 'cli-signed.ts' },
        thoughtSignature: 'CLIsig789==',
      },
    } as unknown as Call;
    const unsignedRead = {
      call: { tool: 'sandbox_read_file', args: { path: 'cli-unsigned.ts' } },
    } as unknown as Call;
    const detectAllToolCalls = () => ({
      readOnly: [signedRead, unsignedRead],
      mutating: null,
      fileMutations: [],
      extraMutations: [],
      droppedCandidates: [],
    });
    const toolExec = async (call: Call) => ({
      kind: 'executed' as const,
      resultText: `contents:${call.call.args.path}`,
    });
    const evaluateAfterModel = async (_response: string, round: number) =>
      round >= 1 ? ({ action: 'halt', summary: 'done' } as const) : null;
    const checkpointMessages: CoderLoopMessage[][] = [];

    await runCoderAgent(
      {
        ...baseCoderOptions({ stream, detectAllToolCalls, evaluateAfterModel }),
        toolExec,
        checkpointCadenceRounds: 1,
      },
      {
        onStatus: () => {},
        onCheckpoint: async (state) => {
          checkpointMessages.push(state.messages.map((m) => ({ ...m })));
        },
      },
    );

    const assistant = (checkpointMessages[0] ?? []).find((m) => m.isToolCall);
    expect(assistant?.toolUses?.[0]).toEqual(
      expect.objectContaining({
        type: 'tool_use',
        name: 'sandbox_read_file',
        input: { path: 'cli-signed.ts' },
        thoughtSignature: 'CLIsig789==',
      }),
    );
    expect(assistant?.toolUses?.[1]).not.toHaveProperty('thoughtSignature');
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

  it('throws SandboxUnreachableError on the FIRST fatal-flagged SANDBOX_UNREACHABLE (bypasses threshold)', async () => {
    // Models that gracefully summarize after one tool error never make the
    // second consecutive failing call the threshold-of-2 needs. When the
    // executor adapter marks a result as `fatal: true` (e.g. `/cleanup`
    // killed the sandbox → auth gate returns NOT_FOUND), the kernel must
    // throw immediately so the host's resume catch-arm fires before the
    // model has a chance to wrap up gracefully.
    //
    // Single-call path here: one tool call from `detectAnyToolCall`,
    // one fatal=true result → throw must propagate without waiting for
    // a second call to land.
    const { stream } = makePushStream([
      [
        { type: 'text_delta', text: 'reading' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);
    const detectAnyToolCall = () =>
      ({ call: { tool: 'sandbox_read_file', args: { path: 'a' } } }) as Call;
    const toolExec = async () => ({
      kind: 'executed' as const,
      resultText: 'sandbox gone',
      errorType: 'SANDBOX_UNREACHABLE',
      fatal: true,
    });

    await expect(
      runCoderAgent(
        {
          ...baseCoderOptions({ stream, detectAnyToolCall, evaluateAfterModel: async () => null }),
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

  it('emits assistant turn start/end events around each model round', async () => {
    const { stream } = makePushStream([
      [
        { type: 'text_delta', text: 'First round' },
        { type: 'done', finishReason: 'stop' },
      ],
      [
        { type: 'text_delta', text: 'Final round' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);
    const events: Array<{ type: string; round?: number; outcome?: string }> = [];
    let policyCalls = 0;

    await runCoderAgent(
      baseCoderOptions({
        stream,
        evaluateAfterModel: async () => {
          policyCalls += 1;
          return policyCalls === 1
            ? { action: 'inject', content: '[POLICY: TEST]\ncontinue\n[/POLICY]' }
            : { action: 'halt', summary: 'done' };
        },
      }),
      { onStatus: () => {}, onRunEvent: (event) => events.push(event) },
    );

    expect(events.filter((e) => e.type === 'assistant.turn_start')).toEqual([
      { type: 'assistant.turn_start', round: 0 },
      { type: 'assistant.turn_start', round: 1 },
    ]);
    expect(events.filter((e) => e.type === 'assistant.turn_end')).toEqual([
      { type: 'assistant.turn_end', round: 0, outcome: 'continued' },
      { type: 'assistant.turn_end', round: 1, outcome: 'completed' },
    ]);
  });

  it('emits a balanced turn_end for a single-tool-call round (natural fall-through)', async () => {
    // Round 0 runs ONE tool call through the single-call path (empty batch
    // buckets + a non-null detectAnyToolCall), so it loops back via the natural
    // fall-through rather than an early continue/return. That path must still
    // finish the round — the regression was a turn_start with no turn_end.
    const { stream, capturedRequests } = makePushStream([
      [
        {
          type: 'text_delta',
          text: 'I’ll inspect the README.\n{"tool":"sandbox_read_file","args":{"path":"README.md"}}',
        },
        { type: 'done', finishReason: 'stop' },
      ],
      [
        { type: 'text_delta', text: 'Done reading.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);
    const events: Array<{
      type: string;
      round?: number;
      outcome?: string;
      toolName?: string;
      target?: string;
      text?: string;
    }> = [];

    await runCoderAgent(
      baseCoderOptions({
        stream,
        // No policy halt/inject, so round 0 reaches the single-tool path.
        evaluateAfterModel: async () => null,
        // Text-based so it's robust to how many times the loop probes per round.
        detectAnyToolCall: (text: string) =>
          text.includes('sandbox_read_file')
            ? ({
                source: 'sandbox',
                call: { tool: 'sandbox_read_file', args: { path: 'README.md' } },
              } as never)
            : null,
      }),
      { onStatus: () => {}, onRunEvent: (event) => events.push(event) },
    );

    expect(events.filter((e) => e.type === 'assistant.turn_start').map((e) => e.round)).toEqual([
      0, 1,
    ]);
    expect(events.filter((e) => e.type === 'assistant.turn_end')).toEqual([
      { type: 'assistant.turn_end', round: 0, outcome: 'continued' },
      { type: 'assistant.turn_end', round: 1, outcome: 'completed' },
    ]);
    expect(events.find((e) => e.type === 'tool.execution_complete')).toEqual(
      expect.objectContaining({
        toolName: 'sandbox_read_file',
        target: 'README.md',
      }),
    );
    expect(events.find((e) => e.type === 'assistant.tool_prose')).toEqual({
      type: 'assistant.tool_prose',
      round: 0,
      text: 'I’ll inspect the README.',
    });
    expect(events.findIndex((e) => e.type === 'assistant.tool_prose')).toBeLessThan(
      events.findIndex((e) => e.type === 'tool.execution_complete'),
    );

    // The event is render-only. Round 1 sees the original assistant tool-call
    // message plus its result, never an extra synthetic narration message.
    const secondRequest = capturedRequests[1] as {
      messages: Array<{ role: string; content: string }>;
    };
    const roundZeroAssistants = secondRequest.messages.filter(
      (message) => message.role === 'assistant' && message.content.includes('inspect the README'),
    );
    expect(roundZeroAssistants).toHaveLength(1);
  });

  it('nudges and continues when a tool call is buried in reasoning tokens', async () => {
    const { stream, capturedRequests } = makePushStream([
      [
        {
          type: 'reasoning_delta',
          text: '{"tool": "sandbox_read_file", "args": {"path": "README.md"}}',
        },
        { type: 'reasoning_end' },
        { type: 'done', finishReason: 'stop' },
      ],
      [
        { type: 'text_delta', text: 'I can answer directly now.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);
    const events: Array<{ type: string; reason?: string; toolName?: string }> = [];

    const result = await runCoderAgent(
      baseCoderOptions({
        stream,
        detectAnyToolCall: (text) =>
          text.includes('"tool"')
            ? { call: { tool: 'sandbox_read_file', args: { path: 'README.md' } } }
            : null,
        evaluateAfterModel: async (_response, round) =>
          round >= 1 ? { action: 'halt', summary: 'done' } : null,
      }),
      { onStatus: () => {}, onRunEvent: (event) => events.push(event) },
    );

    expect(result.rounds).toBe(2);
    expect(capturedRequests).toHaveLength(2);
    const secondReq = capturedRequests[1] as { messages: Array<{ content: string }> };
    expect(
      secondReq.messages.some((message) => message.content.includes('TOOL_CALL_IN_REASONING')),
    ).toBe(true);
    // The reasoning-only round leaves an empty assistant turn; the recovery
    // request must not forward empty content (CLI/daemon providers reject it).
    expect(secondReq.messages.every((message) => message.content.trim().length > 0)).toBe(true);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.call_malformed',
        reason: 'tool_call_in_reasoning',
        toolName: 'sandbox_read_file',
      }),
    );
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
    const events: Array<{ type: string; reason?: string; toolName?: string; preview?: string }> =
      [];
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
        onRunEvent: (event) => events.push(event),
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
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'tool.call_malformed',
        reason: 'validation_failed',
        toolName: 'edit_range',
      }),
    );
    expect(result.rounds).toBe(2);
  });
});

describe('runCoderAgent — run-cost receipt (coder_run_cost)', () => {
  // Capture into a local array — `mockRestore()` clears `spy.mock.calls`, so
  // reading it after restore would see nothing.
  const parseReceipts = (lines: string[]) =>
    lines
      .map((arg) => {
        try {
          return JSON.parse(arg);
        } catch {
          return null;
        }
      })
      .filter((p) => p && p.event === 'coder_run_cost');

  it('accounts provider usage into the receipt even when uncapped (no budget)', async () => {
    // Regression pin for the Codex P2: the ledger.record used to be gated on
    // `tokenBudget !== null`, so an uncapped run — the default — reported
    // usedTokens: 0 despite the provider returning usage. The receipt exists to
    // expose exactly this case, so it must reflect reported usage with no budget.
    const { stream } = makePushStream([
      [
        { type: 'text_delta', text: 'I am done.' },
        {
          type: 'done',
          finishReason: 'stop',
          usage: { inputTokens: 1200, outputTokens: 300, totalTokens: 1500 },
        },
      ],
    ]);
    const logged: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((arg) => {
      if (typeof arg === 'string') logged.push(arg);
    });
    try {
      await runCoderAgent(baseCoderOptions({ stream }), { onStatus: () => {} });
    } finally {
      logSpy.mockRestore();
    }

    const receipts = parseReceipts(logged);
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0];
    // Default evaluateAfterModel halts → the after-model policy-halt path.
    expect(receipt.stopReason).toBe('policy_halt');
    expect(receipt.model).toBe('coder-model');
    expect(receipt.leadMode).toBe(false);
    // No budget passed → uncapped.
    expect(receipt.limitTokens).toBeNull();
    // The core of the regression: real provider usage, counted as reported,
    // NOT zero.
    expect(receipt.usedTokens).toBe(1500);
    expect(receipt.reportedRounds).toBe(1);
    expect(receipt.estimatedRounds).toBe(0);
  });

  it('emits exactly one receipt with stopReason max_rounds when the round cap is hit', async () => {
    const rounds = Array.from({ length: 6 }, () => [
      { type: 'text_delta', text: 'working' },
      { type: 'done', finishReason: 'stop' },
    ]);
    const { stream } = makePushStream(rounds);
    const repeatedRead = { call: { tool: 'sandbox_read_file', args: { path: 'a' } } };
    const logged: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((arg) => {
      if (typeof arg === 'string') logged.push(arg);
    });
    let result;
    try {
      result = await runCoderAgent(
        baseCoderOptions({
          stream,
          harnessMaxRounds: 2,
          detectAllToolCalls: () => ({
            readOnly: [repeatedRead],
            mutating: null,
            fileMutations: [],
            extraMutations: [],
            droppedCandidates: [],
          }),
          detectAnyToolCall: () => repeatedRead,
          evaluateAfterModel: async () => null,
        }),
        { onStatus: () => {} },
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(result.stopReason).toBe('max_rounds');
    // The top-of-loop guard emits directly and finishRound never fires a second
    // receipt — the idempotency guard must hold at exactly one.
    const receipts = parseReceipts(logged);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].stopReason).toBe('max_rounds');
  });

  it('labels a loop halt as loop, not completed', async () => {
    // A loop halt calls finishRound('completed') but returns stopReason 'loop';
    // the receipt must reflect the run-level reason so a defensive halt does not
    // read as a clean completion (fugu NOTE). Setup mirrors the exact-repeat
    // breaker test above.
    const rounds = Array.from({ length: 6 }, () => [
      { type: 'text_delta', text: 'working' },
      { type: 'done', finishReason: 'stop' },
    ]);
    const { stream } = makePushStream(rounds);
    const call = { call: { tool: 'sandbox_read_file', args: { path: 'a' } } };
    const logged: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((arg) => {
      if (typeof arg === 'string') logged.push(arg);
    });
    let result;
    try {
      result = await runCoderAgent(
        baseCoderOptions({
          stream,
          leadMode: true,
          harnessMaxRounds: 10,
          detectAllToolCalls: () => ({
            readOnly: [call],
            mutating: null,
            fileMutations: [],
            extraMutations: [],
            droppedCandidates: [],
          }),
          detectAnyToolCall: () => call,
          evaluateAfterModel: async () => null,
        }),
        { onStatus: () => {} },
      );
    } finally {
      logSpy.mockRestore();
    }

    expect(result.stopReason).toBe('loop');
    const receipts = parseReceipts(logged);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].stopReason).toBe('loop');
  });

  it('still emits the receipt when a host onRunEvent callback throws', async () => {
    // The receipt must survive a misbehaving host callback (fugu WARNING): it is
    // emitted before onRunEvent in finishRound, so a throwing turn_end handler
    // unwinds the run but the cost line is already out.
    const { stream } = makePushStream([
      [
        { type: 'text_delta', text: 'I am done.' },
        { type: 'done', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } },
      ],
    ]);
    const logged: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((arg) => {
      if (typeof arg === 'string') logged.push(arg);
    });
    let threw = false;
    try {
      await runCoderAgent(baseCoderOptions({ stream }), {
        onStatus: () => {},
        onRunEvent: (e: { type: string }) => {
          if (e.type === 'assistant.turn_end') throw new Error('host callback boom');
        },
      });
    } catch {
      threw = true;
    } finally {
      logSpy.mockRestore();
    }

    expect(threw).toBe(true);
    const receipts = parseReceipts(logged);
    expect(receipts).toHaveLength(1);
    // Default halt path — emitted (explicitly, before finishRound's onRunEvent)
    // even though the turn_end handler threw.
    expect(receipts[0].stopReason).toBe('policy_halt');
  });
});

describe('runCoderAgent — tool render payload (`card`) on tool.execution_complete', () => {
  // A card is what the USER sees; `resultText` is what the MODEL reads. The
  // card must ride the run event (so both shells can render it) and must NEVER
  // be serialized into an LlmMessage. Slice 1 of the render-payload track.
  // See `docs/decisions/Tool Render Payload — Cards Are Declared, Not Sniffed.md`.
  const CARD_MARKER = 'CARD_ONLY_NEVER_SHOW_THE_MODEL';

  const typeCheckCard = {
    type: 'type-check',
    data: {
      tool: 'tsc',
      errors: [{ file: CARD_MARKER, line: 1, column: 1, message: CARD_MARKER }],
      errorCount: 1,
      warningCount: 0,
      exitCode: 2,
      truncated: false,
    },
  } as const satisfies ToolCard;

  async function runWithCard() {
    const { stream, capturedRequests } = makePushStream([
      [
        { type: 'text_delta', text: '{"tool":"sandbox_read_file","args":{"path":"README.md"}}' },
        { type: 'done', finishReason: 'stop' },
      ],
      [
        { type: 'text_delta', text: 'Done.' },
        { type: 'done', finishReason: 'stop' },
      ],
    ]);
    const events: RunEventInput[] = [];

    await runCoderAgent(
      baseCoderOptions({
        stream,
        evaluateAfterModel: async () => null,
        detectAnyToolCall: (text: string) =>
          text.includes('sandbox_read_file')
            ? ({
                source: 'sandbox',
                call: { tool: 'sandbox_read_file', args: { path: 'README.md' } },
              } as never)
            : null,
        // The model-facing text is deliberately boring; everything rich is in the card.
        toolExec: async () => ({
          kind: 'executed' as const,
          resultText: 'typecheck failed with 1 error',
          card: typeCheckCard,
        }),
      }),
      { onStatus: () => {}, onRunEvent: (event) => events.push(event) },
    );

    return { events, capturedRequests };
  }

  it('forwards the card onto the run event, verbatim', async () => {
    const { events } = await runWithCard();
    const complete = events.find((e) => e.type === 'tool.execution_complete');
    expect(complete).toEqual(expect.objectContaining({ card: typeCheckCard }));
  });

  it('NEVER lets the card reach an LlmMessage', async () => {
    // The load-bearing invariant of the whole track. If this fails, the card is
    // being paid for in tokens and the model is reading render data.
    const { capturedRequests } = await runWithCard();
    expect(capturedRequests.length).toBeGreaterThan(0);
    for (const req of capturedRequests) {
      const wire = JSON.stringify((req as { messages: unknown[] }).messages);
      expect(wire).not.toContain(CARD_MARKER);
      expect(wire).not.toContain('type-check');
    }
  });

  it('still gives the model the tool result text', async () => {
    // Guard against "passing" the invariant above by dropping the result entirely.
    const { capturedRequests } = await runWithCard();
    const wire = JSON.stringify(
      (capturedRequests[capturedRequests.length - 1] as { messages: unknown[] }).messages,
    );
    expect(wire).toContain('typecheck failed with 1 error');
  });
});
