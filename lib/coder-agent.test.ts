import { describe, it, expect, vi } from 'vitest';
import {
  generateCheckpointAnswer,
  resolveLeadRoundOptions,
  runCoderAgent,
  SandboxUnreachableError,
  type CoderAgentOptions,
} from './coder-agent.js';
import type { LlmContentPart, PushStream, PushStreamEvent } from './provider-contract.js';

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
  leadMode?: boolean;
  leadToolGuidance?: boolean;
  leadToolScope?: CoderAgentOptions<Call, never>['leadToolScope'];
  harnessMaxRounds?: number;
  initialMessages?: CoderAgentOptions<Call, never>['initialMessages'];
  initialUserContentParts?: LlmContentPart[];
  linkedLibraryContent?: string;
  sessionDigestRecords?: CoderAgentOptions<Call, never>['sessionDigestRecords'];
  priorSessionDigest?: CoderAgentOptions<Call, never>['priorSessionDigest'];
  onSessionDigestEmitted?: CoderAgentOptions<Call, never>['onSessionDigestEmitted'];
  resumeState?: CoderAgentOptions<Call, never>['resumeState'];
}): CoderAgentOptions<Call, never> {
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
    expect(lead).toContain('You are the lead in this chat');
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
    expect(sandbox).toContain('You are the lead in this chat');
    expect(sandbox).toContain('do NOT use that Done/Changed/Verified/Open template');
    // …but the surface can't run GitHub PR/CI/merge/promote tools, so the
    // guidance must not steer the model toward them.
    expect(sandbox).not.toContain('inspect PRs / commits / CI');
    expect(sandbox).not.toMatch(/open or merge a PR/);
    expect(sandbox).toContain('cannot open or merge PRs, promote to GitHub, create artifacts');
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
