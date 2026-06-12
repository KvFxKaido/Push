/**
 * Option-parity + helper pins for the in-page Coder kernel-run builder
 * (PR 1 of the Inline Foreground Lane). The load-bearing suite is the
 * delegated-arc parity block: the options assembled at the lib-kernel
 * boundary for a delegated-style call must not drift when the assembly
 * moves or when the inline lane's knobs (stream override, onCheckpoint,
 * resume seeding) are threaded through. Serializer-option-parity
 * discipline — see the decision doc's PR 1 plan.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRunCoderAgentLib,
  mockGenerateCheckpointAnswerLib,
  mockGetProviderPushStream,
  mockGetModelForRole,
  mockReadFilesForCoderPreload,
  mockGetSandboxDiff,
  mockHandleCoderAuditor,
  mockWriteDecisionMemory,
} = vi.hoisted(() => ({
  mockRunCoderAgentLib: vi.fn(),
  mockGenerateCheckpointAnswerLib: vi.fn(),
  mockGetProviderPushStream: vi.fn(),
  mockGetModelForRole: vi.fn(),
  mockReadFilesForCoderPreload: vi.fn(),
  mockGetSandboxDiff: vi.fn(),
  mockHandleCoderAuditor: vi.fn(),
  mockWriteDecisionMemory: vi.fn(),
}));

vi.mock('@push/lib/coder-agent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@push/lib/coder-agent')>()),
  runCoderAgent: (...args: unknown[]) => mockRunCoderAgentLib(...args),
  generateCheckpointAnswer: (...args: unknown[]) => mockGenerateCheckpointAnswerLib(...args),
}));

vi.mock('@/hooks/useUserProfile', () => ({
  getUserProfile: vi.fn(() => ({ displayName: 'Shawn', bio: '', githubLogin: undefined })),
}));

vi.mock('./orchestrator', () => ({
  buildUserIdentityBlock: vi.fn(() => ''),
  getActiveProvider: vi.fn(() => 'openrouter'),
  isProviderAvailable: vi.fn(() => true),
  getProviderPushStream: (...args: unknown[]) => mockGetProviderPushStream(...args),
}));

vi.mock('./providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./providers')>()),
  getModelForRole: (...args: unknown[]) => mockGetModelForRole(...args),
}));

vi.mock('./sandbox-tools', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sandbox-tools')>()),
  readFilesForCoderPreload: (...args: unknown[]) => mockReadFilesForCoderPreload(...args),
}));

vi.mock('./sandbox-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sandbox-client')>()),
  getSandboxDiff: (...args: unknown[]) => mockGetSandboxDiff(...args),
}));

vi.mock('./auditor-delegation-handler', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auditor-delegation-handler')>()),
  handleCoderAuditor: (...args: unknown[]) => mockHandleCoderAuditor(...args),
}));

vi.mock('./context-memory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./context-memory')>()),
  writeDecisionMemory: (...args: unknown[]) => mockWriteDecisionMemory(...args),
}));

import { runCoderAgent } from './coder-agent';
import {
  capturePreCoderSnapshot,
  createCoderCheckpointAnswerer,
  runCoderAuditorGate,
  runInPageCoderKernel,
  teePushStream,
} from './inline-coder-run';
import type { CoderAgentOptions, CoderAgentCallbacks } from '@push/lib/coder-agent';
import type { AnyToolCall } from './tool-dispatch';
import { buildGitHubToolProtocol } from './github-tools';
import { ASK_USER_TOOL_PROTOCOL } from './ask-user-tools';
import { ARTIFACT_TOOL_PROTOCOL } from './artifact-tools';
import type { ChatCard, ChatMessage, HarnessProfileSettings } from '@/types';
import type {
  LlmMessage,
  PushStream,
  PushStreamEvent,
  PushStreamRequest,
} from '@push/lib/provider-contract';
import type { AuditorHandlerContext, HandleCoderAuditorInput } from './auditor-delegation-handler';
import type { CoderAuditorInput } from './coder-delegation-handler';

type LibOptions = CoderAgentOptions<AnyToolCall, ChatCard>;
type LibCallbacks = CoderAgentCallbacks<ChatCard>;

const providerStream: PushStream<LlmMessage> = async function* () {
  yield { type: 'done', finishReason: 'stop' } as PushStreamEvent;
} as unknown as PushStream<LlmMessage>;

function lastKernelCall(): { options: LibOptions; callbacks: LibCallbacks } {
  const call = mockRunCoderAgentLib.mock.calls.at(-1);
  if (!call) throw new Error('lib kernel was not invoked');
  return { options: call[0] as LibOptions, callbacks: call[1] as LibCallbacks };
}

beforeEach(() => {
  mockRunCoderAgentLib.mockReset().mockResolvedValue({
    summary: 'done',
    cards: [],
    rounds: 1,
    checkpoints: 0,
  });
  mockGenerateCheckpointAnswerLib.mockReset().mockResolvedValue('answer');
  mockGetProviderPushStream.mockReset().mockReturnValue(providerStream);
  mockGetModelForRole
    .mockReset()
    .mockImplementation((_p: string, role: string) => ({ id: `${role}-default-model` }));
  mockReadFilesForCoderPreload.mockReset().mockResolvedValue(null);
  mockGetSandboxDiff.mockReset();
  mockHandleCoderAuditor.mockReset();
  mockWriteDecisionMemory.mockReset().mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Delegated-arc option parity
// ---------------------------------------------------------------------------

describe('delegated-arc option parity (runCoderAgent → lib kernel)', () => {
  const harnessSettings = {
    profile: 'frontier',
    maxCoderRounds: 24,
    contextResetsEnabled: true,
    evaluateAfterCoder: true,
    plannerRequired: false,
  } as unknown as HarnessProfileSettings;

  async function runDelegatedStyleCall(opts?: { repoFullName?: string }) {
    await runCoderAgent(
      'Implement the fix',
      'sb-1',
      ['src/a.ts'],
      () => {},
      'AGENTS-MD-CONTENT',
      undefined,
      async () => 'checkpoint-answer',
      [{ id: 'tests', check: 'npm test', description: 'tests pass' }],
      () => {},
      'openrouter',
      'coder-model-x',
      {
        intent: 'fix',
        deliverable: 'patch',
        knownContext: ['ctx'],
        constraints: ['stay scoped'],
        branchContext: { activeBranch: 'feat/x', defaultBranch: 'main', protectMain: true },
        instructionFilename: 'AGENTS.md',
        harnessSettings,
        plannerBrief: 'PLANNER-BRIEF',
        repoFullName: opts?.repoFullName,
        chatId: 'chat-1',
      },
    );
  }

  it('pins the full option-key surface at the lib boundary', async () => {
    await runDelegatedStyleCall({ repoFullName: 'KvFxKaido/Push' });
    const { options, callbacks } = lastKernelCall();

    // Key-set drift pin: a new or dropped option slot must update this
    // list AND get a parity decision for the delegated arc.
    expect(Object.keys(options).sort()).toEqual(
      [
        'acceptanceCriteria',
        'allowedRepo',
        'approvalModeBlock',
        'branchContext',
        'checkpointCadenceRounds',
        'detectAllToolCalls',
        'detectAnyToolCall',
        'evaluateAfterModel',
        // Parity decision: the delegated arc threads `extraToolProtocols:
        // undefined` (the inline lane sets it; the delegated Coder keeps its
        // narrow sandbox/web/memory surface — no extra tools advertised).
        'extraToolProtocols',
        'harnessContextResetsEnabled',
        'harnessMaxRounds',
        'instructionFilename',
        'memoryToolProtocol',
        'modelId',
        'projectInstructions',
        'provider',
        'resumeState',
        'sandboxId',
        'stream',
        'symbolSummary',
        'taskPreamble',
        'toolExec',
        'userProfile',
        'verificationPolicyBlock',
        'webSearchToolProtocol',
        'sandboxToolProtocol',
      ].sort(),
    );
    expect(Object.keys(callbacks).sort()).toEqual(
      [
        'onStatus',
        'signal',
        'onCheckpointRequest',
        'onCheckpoint',
        'onWorkingMemoryUpdate',
        'onAdvanceRound',
        'getFileAwarenessSummary',
        'runAcceptanceCriterion',
        'fetchSandboxStateSummary',
        'onRunEvent',
      ].sort(),
    );
  });

  it('keeps the delegated arc on the provider stream with no inline knobs set', async () => {
    await runDelegatedStyleCall({ repoFullName: 'KvFxKaido/Push' });
    const { options, callbacks } = lastKernelCall();

    expect(mockGetProviderPushStream).toHaveBeenCalledWith('openrouter');
    expect(options.stream).toBe(providerStream);
    // The inline lane's knobs stay dormant on the delegated arc.
    expect(options.resumeState).toBeUndefined();
    expect(options.checkpointCadenceRounds).toBeUndefined();
    expect(callbacks.onCheckpoint).toBeUndefined();
    // Lead tool surface is inline-only: the delegated Coder advertises no
    // GitHub/ask_user/artifact protocols (narrow sandbox/web/memory surface).
    expect(options.extraToolProtocols).toBeUndefined();
  });

  it('builds the brief + planner preamble and threads the delegated option values', async () => {
    mockReadFilesForCoderPreload.mockResolvedValue('[PRELOADED-FILES]');
    await runDelegatedStyleCall({ repoFullName: 'KvFxKaido/Push' });
    const { options } = lastKernelCall();

    expect(options.taskPreamble).toContain('Task: Implement the fix');
    expect(options.taskPreamble).toContain('PLANNER-BRIEF');
    expect(options.taskPreamble).toContain('[PRELOADED-FILES]');
    expect(options.taskPreamble.indexOf('PLANNER-BRIEF')).toBeLessThan(
      options.taskPreamble.indexOf('[PRELOADED-FILES]'),
    );

    expect(options.provider).toBe('openrouter');
    expect(options.modelId).toBe('coder-model-x');
    expect(options.sandboxId).toBe('sb-1');
    expect(options.allowedRepo).toBe('');
    expect(options.branchContext).toEqual({
      activeBranch: 'feat/x',
      defaultBranch: 'main',
      protectMain: true,
    });
    expect(options.projectInstructions).toBe('AGENTS-MD-CONTENT');
    expect(options.instructionFilename).toBe('AGENTS.md');
    expect(options.harnessMaxRounds).toBe(24);
    expect(options.harnessContextResetsEnabled).toBe(true);
    expect(options.acceptanceCriteria).toEqual([
      { id: 'tests', check: 'npm test', description: 'tests pass' },
    ]);
    expect(
      typeof options.approvalModeBlock === 'string' || options.approvalModeBlock === null,
    ).toBe(true);
  });

  it('advertises memory tools iff a repo scope was threaded', async () => {
    await runDelegatedStyleCall({ repoFullName: 'KvFxKaido/Push' });
    expect(lastKernelCall().options.memoryToolProtocol).toBeTruthy();

    await runDelegatedStyleCall({ repoFullName: undefined });
    expect(lastKernelCall().options.memoryToolProtocol).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Inline-lane knobs on the builder
// ---------------------------------------------------------------------------

describe('runInPageCoderKernel inline knobs', () => {
  it('uses the stream override and forwards checkpoint wiring verbatim', async () => {
    const teed: PushStream<LlmMessage> = providerStream;
    const onCheckpoint = vi.fn(async () => {});
    const resumeState = { round: 3, messages: [], workingMemory: {}, cards: [] };

    await runInPageCoderKernel(
      {
        provider: 'openrouter',
        modelId: 'm',
        sandboxId: 'sb-2',
        taskPreamble: 'RAW-USER-TURN-PREAMBLE',
        stream: teed,
        resumeState: resumeState as never,
        checkpointCadenceRounds: 1,
      },
      { onStatus: () => {}, onCheckpoint },
    );

    const { options, callbacks } = lastKernelCall();
    expect(options.stream).toBe(teed);
    expect(mockGetProviderPushStream).not.toHaveBeenCalled();
    expect(options.taskPreamble).toBe('RAW-USER-TURN-PREAMBLE');
    expect(options.resumeState).toBe(resumeState);
    expect(options.checkpointCadenceRounds).toBe(1);
    expect(callbacks.onCheckpoint).toBe(onCheckpoint);
  });

  it('rejects the demo provider', async () => {
    await expect(
      runInPageCoderKernel(
        { provider: 'demo' as never, modelId: undefined, sandboxId: 's', taskPreamble: 't' },
        { onStatus: () => {} },
      ),
    ).rejects.toThrow(/No AI provider configured/);
  });
});

// ---------------------------------------------------------------------------
// Stream tee
// ---------------------------------------------------------------------------

describe('teePushStream', () => {
  const events: PushStreamEvent[] = [
    { type: 'text_delta', text: 'a' },
    { type: 'reasoning_delta', text: 'r' },
    { type: 'done', finishReason: 'stop' },
  ] as PushStreamEvent[];

  const source: PushStream<LlmMessage> = (() =>
    (async function* () {
      for (const e of events) yield e;
    })()) as unknown as PushStream<LlmMessage>;

  it('mirrors every event while yielding the identical sequence to the consumer', async () => {
    const seen: PushStreamEvent[] = [];
    const teed = teePushStream(source, (e) => seen.push(e));

    const consumed: PushStreamEvent[] = [];
    for await (const e of teed({} as PushStreamRequest<LlmMessage>)) consumed.push(e);

    expect(consumed).toEqual(events);
    expect(seen).toEqual(events);
  });

  it('keeps the kernel stream intact when the observer throws', async () => {
    const teed = teePushStream(source, () => {
      throw new Error('UI mirror exploded');
    });

    const consumed: PushStreamEvent[] = [];
    for await (const e of teed({} as PushStreamRequest<LlmMessage>)) consumed.push(e);
    expect(consumed).toEqual(events);
  });
});

// ---------------------------------------------------------------------------
// Pre-Coder snapshot
// ---------------------------------------------------------------------------

describe('capturePreCoderSnapshot', () => {
  it('captures HEAD and the untracked baseline', async () => {
    mockGetSandboxDiff.mockResolvedValue({
      diff: '',
      head_sha: 'abc123',
      git_status: '?? new-file.ts\n M tracked.ts\n?? another.md',
    });
    const snap = await capturePreCoderSnapshot('sb-1');
    expect(snap.preCoderHead).toBe('abc123');
    expect(snap.preCoderUntrackedFiles).toEqual(
      expect.arrayContaining(['new-file.ts', 'another.md']),
    );
    expect(snap.preCoderUntrackedFiles).toHaveLength(2);
  });

  it('degrades to undefineds on fetch failure (best-effort contract)', async () => {
    mockGetSandboxDiff.mockRejectedValue(new Error('sandbox gone'));
    const snap = await capturePreCoderSnapshot('sb-1');
    expect(snap).toEqual({ preCoderHead: undefined, preCoderUntrackedFiles: undefined });
  });
});

// ---------------------------------------------------------------------------
// Auditor-invocation gate
// ---------------------------------------------------------------------------

describe('runCoderAuditorGate', () => {
  const ctx = {} as AuditorHandlerContext;
  function gateInput(overrides: { evaluateAfterCoder: boolean; summaries: string[] }) {
    return {
      chatId: 'chat-1',
      baseCorrelation: { surface: 'web', chatId: 'chat-1' },
      lockedProviderForChat: 'openrouter',
      resolvedModelForChat: undefined,
      verificationPolicy: {},
      auditorInput: {
        harnessSettings: { evaluateAfterCoder: overrides.evaluateAfterCoder },
        summaries: overrides.summaries,
      } as unknown as CoderAuditorInput,
    } as unknown as HandleCoderAuditorInput;
  }

  it('returns null when the harness profile skips post-Coder evaluation', async () => {
    const result = await runCoderAuditorGate(
      ctx,
      gateInput({ evaluateAfterCoder: false, summaries: ['did things'] }),
    );
    expect(result).toBeNull();
    expect(mockHandleCoderAuditor).not.toHaveBeenCalled();
  });

  it('returns null when the Coder produced nothing to evaluate', async () => {
    const result = await runCoderAuditorGate(
      ctx,
      gateInput({ evaluateAfterCoder: true, summaries: [] }),
    );
    expect(result).toBeNull();
    expect(mockHandleCoderAuditor).not.toHaveBeenCalled();
  });

  it('invokes handleCoderAuditor when the gate fires and returns its result', async () => {
    const handlerResult = { evalResult: { verdict: 'complete' }, auditorSummaryLine: 'line' };
    mockHandleCoderAuditor.mockResolvedValue(handlerResult);
    const input = gateInput({ evaluateAfterCoder: true, summaries: ['did things'] });
    const result = await runCoderAuditorGate(ctx, input);
    expect(mockHandleCoderAuditor).toHaveBeenCalledWith(ctx, input);
    expect(result).toBe(handlerResult);
  });
});

// ---------------------------------------------------------------------------
// Checkpoint answerer
// ---------------------------------------------------------------------------

describe('createCoderCheckpointAnswerer', () => {
  const messages = Array.from({ length: 10 }, (_, i) => ({
    id: `m${i}`,
    role: 'user',
    content: `msg ${i}`,
    timestamp: i,
    status: 'done',
  })) as unknown as ChatMessage[];

  it('answers via the lead model over the last 6 turns and persists decision memory', async () => {
    const updateAgentStatus = vi.fn();
    const answerer = createCoderCheckpointAnswerer({
      chatId: 'chat-1',
      statusPrefix: '[2/3] ',
      apiMessages: messages,
      provider: 'openrouter',
      model: 'model-x',
      memoryScope: { repoFullName: 'KvFxKaido/Push', branch: 'feat/x', chatId: 'chat-1' },
      readLatestCoderState: () => null,
      getSignal: () => undefined,
      updateAgentStatus,
    });

    const answer = await answerer('Which approach?', 'tried A and B');
    expect(answer).toBe('answer');

    // Last-6 history slice reaches the lib answer generator.
    const libCall = mockGenerateCheckpointAnswerLib.mock.calls.at(-1);
    expect(libCall?.[0]).toBe('Which approach?');
    expect((libCall?.[2] as { recentChatHistory: unknown[] }).recentChatHistory).toHaveLength(6);

    expect(mockWriteDecisionMemory).toHaveBeenCalledWith({
      scope: { repoFullName: 'KvFxKaido/Push', branch: 'feat/x', chatId: 'chat-1' },
      question: 'Which approach?',
      answer: 'answer',
    });

    // Status arc: checkpoint → resuming, both with the multi-task prefix
    // and 'coder' attribution.
    expect(updateAgentStatus).toHaveBeenNthCalledWith(
      1,
      { active: true, phase: '[2/3] Coder checkpoint', detail: 'Which approach?' },
      { chatId: 'chat-1', source: 'coder' },
    );
    expect(updateAgentStatus).toHaveBeenNthCalledWith(
      2,
      { active: true, phase: '[2/3] Coder resuming...' },
      { chatId: 'chat-1', source: 'coder' },
    );
  });

  it('skips decision-memory persistence without a scope', async () => {
    const answerer = createCoderCheckpointAnswerer({
      chatId: 'chat-1',
      apiMessages: messages,
      provider: 'openrouter',
      memoryScope: null,
      readLatestCoderState: () => null,
      getSignal: () => undefined,
      updateAgentStatus: vi.fn(),
    });
    await answerer('Q', '');
    expect(mockWriteDecisionMemory).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Lead tool surface (Inline Foreground Lane → Orchestrator parity)
// ---------------------------------------------------------------------------

describe('lead tool surface (inline foreground lane)', () => {
  async function runLeadCall(leadToolSurface: boolean): Promise<LibOptions> {
    await runInPageCoderKernel(
      {
        provider: 'openrouter',
        modelId: 'coder-model-x',
        sandboxId: 'sb-1',
        taskPreamble: 'Task: what changed recently?',
        branchContext: { activeBranch: 'main', defaultBranch: 'main', protectMain: false },
        memoryScope: { repoFullName: 'KvFxKaido/Push', branch: 'main', chatId: 'chat-1' },
        leadToolSurface,
      },
      { onStatus: () => {} },
    );
    return lastKernelCall().options;
  }

  it('advertises the GitHub (delegation-free), ask_user, and artifact protocols', async () => {
    const options = await runLeadCall(true);
    expect(options.extraToolProtocols).toEqual([
      buildGitHubToolProtocol({ includeDelegation: false }),
      ASK_USER_TOOL_PROTOCOL,
      ARTIFACT_TOOL_PROTOCOL,
    ]);
    // Delegation stays out — the single lead has no delegation arc wired, so
    // delegate_* must not be advertised (the GitHub block is delegation-free).
    const joined = options.extraToolProtocols!.join('\n');
    expect(joined).not.toContain('delegate_explorer');
    expect(joined).not.toContain('EXPLORER-FIRST');
  });

  it('routes GitHub read calls into the parallel-read bucket', async () => {
    const options = await runLeadCall(true);
    const githubCall = '{"tool":"fetch_pr","args":{"repo":"KvFxKaido/Push","pr":1}}';
    const detected = options.detectAllToolCalls(githubCall);
    expect(detected.readOnly.map((c) => c.call.tool)).toContain('fetch_pr');
  });

  it('threads the repo name into the workspace block so GitHub tools have a repo arg', async () => {
    const options = await runLeadCall(true);
    expect(options.branchContext?.repoFullName).toBe('KvFxKaido/Push');
  });

  it('keeps the extra surface dormant when leadToolSurface is false', async () => {
    const options = await runLeadCall(false);
    expect(options.extraToolProtocols).toBeUndefined();
    expect(options.branchContext?.repoFullName).toBeUndefined();
    const githubCall = '{"tool":"fetch_pr","args":{"repo":"KvFxKaido/Push","pr":1}}';
    const detected = options.detectAllToolCalls(githubCall);
    expect(detected.readOnly).toHaveLength(0);
  });
});
