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
  mockExecuteSandboxToolCall,
  mockGetSandboxDiff,
  mockHandleCoderAuditor,
  mockWriteDecisionMemory,
  mockExecInSandbox,
} = vi.hoisted(() => ({
  mockRunCoderAgentLib: vi.fn(),
  mockGenerateCheckpointAnswerLib: vi.fn(),
  mockGetProviderPushStream: vi.fn(),
  mockGetModelForRole: vi.fn(),
  mockReadFilesForCoderPreload: vi.fn(),
  mockExecuteSandboxToolCall: vi.fn(),
  mockGetSandboxDiff: vi.fn(),
  mockHandleCoderAuditor: vi.fn(),
  mockWriteDecisionMemory: vi.fn(),
  mockExecInSandbox: vi.fn(),
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
  executeSandboxToolCall: (...args: unknown[]) => mockExecuteSandboxToolCall(...args),
}));

vi.mock('./sandbox-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./sandbox-client')>()),
  getSandboxDiff: (...args: unknown[]) => mockGetSandboxDiff(...args),
  execInSandbox: (...args: unknown[]) => mockExecInSandbox(...args),
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
  LEAD_EXPLORER_DELEGATION_PROTOCOL,
  runCoderAuditorGate,
  runInlineVerificationCriteria,
  runInPageCoderKernel,
  teePushStream,
} from './inline-coder-run';
import type { VerificationPolicy } from './verification-policy';
import type { CoderAgentOptions, CoderAgentCallbacks } from '@push/lib/coder-agent';
import type { AnyToolCall } from './tool-dispatch';
import { buildGitHubToolProtocol } from './github-tools';
import { ASK_USER_TOOL_PROTOCOL } from './ask-user-tools';
import { ARTIFACT_TOOL_PROTOCOL } from './artifact-tools';
import { SCRATCHPAD_TOOL_PROTOCOL } from './scratchpad-tools';
import { TODO_TOOL_PROTOCOL } from './todo-tools';
import { WEB_SEARCH_TOOL_PROTOCOL } from './web-search-tools';
import type { ActiveProvider } from './orchestrator';
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
  mockExecuteSandboxToolCall.mockReset().mockResolvedValue({ text: 'ok' });
  mockGetSandboxDiff.mockReset();
  mockHandleCoderAuditor.mockReset();
  mockWriteDecisionMemory.mockReset().mockResolvedValue(undefined);
  mockExecInSandbox.mockReset();
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
        // Parity decision: native tool-call dispatch is wired on BOTH arcs —
        // the web inline lead (`detectNativeToolCalls` with the parallel-explorer
        // cap) and the CLI lead (`wrapCliDetectNativeToolCalls`). The delegated
        // sub-Coder stays text-dispatch on both (native schemas are lead-surface
        // only), so the slot is present here in lockstep. See #1162.
        'detectNativeToolCalls',
        'evaluateAfterModel',
        // Parity decision: the delegated arc threads `extraToolProtocols:
        // undefined` (the inline lane sets it; the delegated Coder keeps its
        // narrow sandbox/web/memory surface — no extra tools advertised).
        'extraToolProtocols',
        'harnessContextResetsEnabled',
        'harnessMaxRounds',
        // Per-run token budget — null here (delegated arc inherits the
        // envelope's harness setting; the inline lead folds in the user pref).
        'harnessTokenBudget',
        // Parity decision: delegated Coders do not seed from chat history.
        // The inline conversational lead sets this; task-shaped runs keep the
        // single task preamble.
        'initialMessages',
        'initialUserContentParts',
        'instructionFilename',
        'persona',
        // Parity decision: the delegated arc threads `leadToolGuidance:
        // undefined` (only the web inline lead opts into the web-named
        // tool-routing/error block; the CLI lead and delegated Coder leave it
        // off so they aren't steered toward tool names they don't advertise).
        'leadToolGuidance',
        // Parity decision: the delegated arc threads `leadToolScope: undefined`
        // (the shared resolver only sets a scope for a lead turn; the delegated
        // Coder uses the non-lead guidelines, which ignore it). The inline lead
        // sets 'full'; the background DO lead sets 'sandbox'.
        'leadToolScope',
        'memoryToolProtocol',
        'modelId',
        // Parity decision: the delegated arc threads `nativeToolSchemas:
        // undefined` here — the profile returns text-dispatch for this
        // openrouter model, and native tool calling is scoped to supported lead
        // routes. Additive regardless: native tool_calls dispatch through
        // structured stream events.
        'nativeToolSchemas',
        // Parity decision: only the web inline lane resolves linked libraries.
        // Delegated Coders receive all context through their brief/preload.
        'linkedLibraryContent',
        // Parity decision: the inline conversational lead threads digest inputs
        // for the stream's single context transform; the delegated arc leaves
        // them undefined (the key is present, the value isn't set).
        'sessionDigestRecords',
        'priorSessionDigest',
        'onSessionDigestEmitted',
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
    expect(options.persona).toBe('coder');
    expect(callbacks.onCheckpoint).toBeUndefined();
    // Lead tool surface is inline-only: the delegated Coder advertises no
    // GitHub/ask_user/artifact protocols (narrow sandbox/web/memory surface).
    expect(options.extraToolProtocols).toBeUndefined();
  });

  it('builds the brief preamble and threads the delegated option values', async () => {
    mockReadFilesForCoderPreload.mockResolvedValue('[PRELOADED-FILES]');
    await runDelegatedStyleCall({ repoFullName: 'KvFxKaido/Push' });
    const { options } = lastKernelCall();

    expect(options.taskPreamble).toContain('Task: Implement the fix');
    expect(options.taskPreamble).toContain('[PRELOADED-FILES]');

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
    const initialMessages = [
      { id: 'u1', role: 'user' as const, content: 'prior question', timestamp: 1 },
      { id: 'a1', role: 'assistant' as const, content: 'prior answer', timestamp: 2 },
    ];
    const initialUserContentParts = [
      { type: 'text' as const, text: 'RAW-USER-TURN-PREAMBLE' },
      { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,abc123' } },
    ];

    await runInPageCoderKernel(
      {
        provider: 'openrouter',
        modelId: 'm',
        sandboxId: 'sb-2',
        taskPreamble: 'RAW-USER-TURN-PREAMBLE',
        initialMessages,
        initialUserContentParts,
        linkedLibraryContent: '# Linked libraries\n\n## Library: Design notes',
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
    expect(options.initialMessages).toBe(initialMessages);
    expect(options.initialUserContentParts).toBe(initialUserContentParts);
    expect(options.linkedLibraryContent).toContain('Design notes');
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

  it('tees branchSwitch payloads before the kernel result narrows them away', async () => {
    const payload = {
      name: 'main',
      kind: 'switched' as const,
      from: 'feat/x',
      previous: 'feat/x',
      source: 'sandbox_switch_branch' as const,
    };
    mockExecuteSandboxToolCall.mockResolvedValueOnce({
      text: '[Tool Result — sandbox_switch_branch]',
      branchSwitch: payload,
    });
    const onBranchSwitchPayload = vi.fn();

    await runInPageCoderKernel(
      {
        provider: 'openrouter',
        modelId: 'm',
        sandboxId: 'sb-2',
        taskPreamble: 'RAW-USER-TURN-PREAMBLE',
      },
      { onStatus: () => {}, onBranchSwitchPayload },
    );

    const { options } = lastKernelCall();
    const result = await options.toolExec(
      {
        source: 'sandbox',
        call: { tool: 'sandbox_switch_branch', args: { branch: 'main' } },
      } as AnyToolCall,
      { round: 1, executionId: 'exec-switch-branch' },
    );

    expect(onBranchSwitchPayload).toHaveBeenCalledWith(payload);
    expect(result).toMatchObject({
      kind: 'executed',
      resultText: '[Tool Result — sandbox_switch_branch]',
    });
  });

  it('leaves branchSwitch payloads as a no-op when the delegated arc omits the callback', async () => {
    mockExecuteSandboxToolCall.mockResolvedValueOnce({
      text: '[Tool Result — sandbox_switch_branch]',
      branchSwitch: {
        name: 'main',
        kind: 'switched',
        source: 'sandbox_switch_branch',
      },
    });

    await runInPageCoderKernel(
      {
        provider: 'openrouter',
        modelId: 'm',
        sandboxId: 'sb-2',
        taskPreamble: 'RAW-USER-TURN-PREAMBLE',
      },
      { onStatus: () => {} },
    );

    const { options } = lastKernelCall();
    const result = await options.toolExec(
      {
        source: 'sandbox',
        call: { tool: 'sandbox_switch_branch', args: { branch: 'main' } },
      } as AnyToolCall,
      { round: 1, executionId: 'exec-switch-branch' },
    );

    expect(result).toMatchObject({
      kind: 'executed',
      resultText: '[Tool Result — sandbox_switch_branch]',
    });
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
        scratchpad: {
          content: 'Remember the release train constraint.',
          replace: vi.fn(),
          append: vi.fn(),
        },
        todo: {
          todos: [
            {
              id: 'inspect-history',
              content: 'Inspect recent history',
              activeForm: 'Inspecting recent history',
              status: 'pending',
            },
          ],
          replace: vi.fn(),
          clear: vi.fn(),
        },
        leadToolSurface,
      },
      { onStatus: () => {} },
    );
    return lastKernelCall().options;
  }

  it('advertises GitHub (delegation-free), ask_user, artifact, and explorer-delegation protocols', async () => {
    const options = await runLeadCall(true);
    expect(options.extraToolProtocols).toEqual([
      buildGitHubToolProtocol({ includeDelegation: false }),
      SCRATCHPAD_TOOL_PROTOCOL,
      TODO_TOOL_PROTOCOL,
      ASK_USER_TOOL_PROTOCOL,
      ARTIFACT_TOOL_PROTOCOL,
      LEAD_EXPLORER_DELEGATION_PROTOCOL,
    ]);
    // Read-only Explorer delegation IS advertised — the lead offloads
    // investigation but still does its own coding. delegate_coder / plan_tasks
    // stay out (the GitHub block is delegation-free and the explorer protocol
    // is explorer-only).
    const joined = options.extraToolProtocols!.join('\n');
    expect(joined).toContain('DELEGATE_EXPLORER');
    expect(joined).not.toContain('delegate_coder');
    expect(joined).not.toContain('plan_tasks');
    // Lead mode also swaps the kernel prompt (implementer → lead voice).
    expect(options.persona).toBe('lead');
    // The web lead opts into the web-named tool-routing/error guidance.
    expect(options.leadToolGuidance).toBe(true);
    expect(options.linkedLibraryContent).toContain('[SCRATCHPAD]');
    expect(options.linkedLibraryContent).toContain('Remember the release train constraint.');
    expect(options.linkedLibraryContent).toContain('[TODO]');
    expect(options.linkedLibraryContent).toContain('Inspect recent history');
  });

  it('executes scratchpad and todo calls through inline chat-state handlers', async () => {
    await runInPageCoderKernel(
      {
        provider: 'openrouter',
        modelId: 'coder-model-x',
        sandboxId: 'sb-1',
        taskPreamble: 'Task: plan',
        memoryScope: { repoFullName: 'KvFxKaido/Push', branch: 'main', chatId: 'chat-1' },
        scratchpad: {
          content: 'old',
          replace: vi.fn(),
          append: vi.fn(),
        },
        todo: {
          todos: [],
          replace: vi.fn(),
          clear: vi.fn(),
        },
        leadToolSurface: true,
      },
      { onStatus: () => {} },
    );
    const { options } = lastKernelCall();

    const scratchResult = await options.toolExec(
      {
        source: 'scratchpad',
        call: { tool: 'append_scratchpad', content: 'new note' },
      } as AnyToolCall,
      { round: 0, executionId: 'exec-scratchpad' },
    );
    const todoResult = await options.toolExec(
      {
        source: 'todo',
        call: {
          tool: 'todo_write',
          todos: [
            {
              id: 'a',
              content: 'Do A',
              activeForm: 'Doing A',
              status: 'in_progress',
            },
          ],
        },
      } as AnyToolCall,
      { round: 0, executionId: 'exec-todo' },
    );

    expect(scratchResult.kind).toBe('executed');
    if (scratchResult.kind !== 'executed') throw new Error('scratchpad should execute');
    expect(scratchResult.resultText).toContain('Scratchpad updated');
    expect(todoResult.kind).toBe('executed');
    if (todoResult.kind !== 'executed') throw new Error('todo should execute');
    expect(todoResult.resultText).toContain('Todo updated');
  });

  it('fans out up to two Explorer delegations into the parallel bucket, rejecting a third', async () => {
    const options = await runLeadCall(true);
    const explorer = (task: string) =>
      `{"tool":"explorer","args":{"task":"${task} — trace this flow across modules"}}`;
    // Two independent threads → both run concurrently in the read-phase batch.
    const two = options.detectAllToolCalls(`${explorer('auth')}\n${explorer('billing')}`);
    expect(two.parallelDelegations?.map((c) => c.call.tool)).toEqual([
      'delegate_explorer',
      'delegate_explorer',
    ]);
    expect(two.mutating).toBeNull();
    // A third in the same turn overflows to extraMutations (re-issue next turn),
    // not silently dropped.
    const three = options.detectAllToolCalls(
      `${explorer('auth')}\n${explorer('billing')}\n${explorer('search')}`,
    );
    expect(three.parallelDelegations).toHaveLength(2);
    expect(three.extraMutations).toHaveLength(1);
  });

  it('keeps Explorer delegation in the single trailing slot when the lead surface is off', async () => {
    const options = await runLeadCall(false);
    // No leadRuntime → no `delegate` source wired and no parallel-delegation
    // opt-in; a delegated Coder never reaches the explorer arc. The detector
    // filters it out of every executable bucket.
    const detected = options.detectAllToolCalls(
      '{"tool":"explorer","args":{"task":"trace the flow across modules"}}',
    );
    expect(detected.parallelDelegations ?? []).toHaveLength(0);
    expect(detected.readOnly).toHaveLength(0);
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
    expect(options.persona).toBe('coder');
    expect(options.leadToolGuidance).toBeFalsy();
    expect(options.branchContext?.repoFullName).toBeUndefined();
    const githubCall = '{"tool":"fetch_pr","args":{"repo":"KvFxKaido/Push","pr":1}}';
    const detected = options.detectAllToolCalls(githubCall);
    expect(detected.readOnly).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Inline verification criteria (post-kernel gate, delegated-arc parity)
// ---------------------------------------------------------------------------

describe('runInlineVerificationCriteria', () => {
  const policy: VerificationPolicy = {
    name: 'Standard',
    rules: [
      {
        id: 'typecheck',
        label: 'Type check',
        scope: 'always',
        kind: 'command',
        command: 'npm run typecheck',
      },
      { id: 'test', label: 'Tests', scope: 'always', kind: 'command', command: 'npm test' },
      { id: 'diff', label: 'Diff evidence', scope: 'always', kind: 'evidence' },
    ],
  };

  it('runs the command rules, building results + the command map + a pass/fail block', async () => {
    mockExecInSandbox
      .mockResolvedValueOnce({ stdout: 'ok', stderr: '', exitCode: 0 })
      .mockResolvedValueOnce({ stdout: '', stderr: 'boom', exitCode: 1 });

    const result = await runInlineVerificationCriteria('sbx', policy);

    // The evidence rule is not a command — only the two command rules ran.
    expect(mockExecInSandbox).toHaveBeenCalledTimes(2);
    expect(mockExecInSandbox).toHaveBeenCalledWith('sbx', 'npm run typecheck');
    expect(mockExecInSandbox).toHaveBeenCalledWith('sbx', 'npm test');

    expect(result.criteriaResults).toEqual([
      { id: 'verification:typecheck', passed: true, exitCode: 0, output: 'ok' },
      { id: 'verification:test', passed: false, exitCode: 1, output: 'boom' },
    ]);
    expect(result.verificationCommandsById.get('verification:typecheck')).toBe('npm run typecheck');
    expect(result.verificationCommandsById.get('verification:test')).toBe('npm test');
    expect(result.summaryLine).toContain('[Acceptance Criteria] 1/2 passed');
    expect(result.summaryLine).toContain('✓ verification:typecheck');
    expect(result.summaryLine).toContain('✗ verification:test');
  });

  it('records a thrown check as a failure (exit -1) without aborting the turn', async () => {
    mockExecInSandbox.mockRejectedValue(new Error('sandbox gone'));
    const result = await runInlineVerificationCriteria('sbx', {
      name: 'one',
      rules: [{ id: 'typecheck', label: 'tc', scope: 'always', kind: 'command', command: 'tsc' }],
    });
    expect(result.criteriaResults).toEqual([
      { id: 'verification:typecheck', passed: false, exitCode: -1, output: 'sandbox gone' },
    ]);
  });

  it('runs nothing for an evidence-only policy or no policy', async () => {
    const noCommands = await runInlineVerificationCriteria('sbx', {
      name: 'evidence-only',
      rules: [{ id: 'diff', label: 'diff', scope: 'always', kind: 'evidence' }],
    });
    expect(mockExecInSandbox).not.toHaveBeenCalled();
    expect(noCommands.criteriaResults).toEqual([]);
    expect(noCommands.summaryLine).toBe('');

    const noPolicy = await runInlineVerificationCriteria('sbx', undefined);
    expect(noPolicy.criteriaResults).toEqual([]);
    expect(mockExecInSandbox).not.toHaveBeenCalled();
  });

  it('stops before running anything when the abort signal is already set', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runInlineVerificationCriteria('sbx', policy, controller.signal);
    expect(mockExecInSandbox).not.toHaveBeenCalled();
    expect(result.criteriaResults).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Prompt-engineered web-search gate (mirrors orchestrator.ts)
// ---------------------------------------------------------------------------

describe('inline lane web-search protocol gating', () => {
  const harnessSettings = {
    profile: 'frontier',
    maxCoderRounds: 24,
    contextResetsEnabled: true,
    evaluateAfterCoder: true,
  } as unknown as HarnessProfileSettings;

  // Test env has no localStorage, so `getWebSearchMode()` resolves to its
  // 'auto' default — native-capable providers suppress the prompt-engineered
  // protocol, native-less ones keep it.
  async function runWithProvider(provider: ActiveProvider): Promise<LibOptions> {
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
      provider,
      'model-x',
      { intent: 'fix', deliverable: 'patch', harnessSettings, chatId: 'chat-1' },
    );
    return lastKernelCall().options;
  }

  it('suppresses the prompt-engineered protocol when native search is active', async () => {
    // OpenAI + Sakana (this PR's Responses-native additions) + a pre-existing
    // native provider. Fireworks is excluded — it has no built-in web_search.
    const nativeProviders: ActiveProvider[] = ['openai', 'sakana', 'openrouter'];
    for (const provider of nativeProviders) {
      const options = await runWithProvider(provider);
      expect(options.webSearchToolProtocol).toBe('');
    }
  });

  it('keeps the prompt-engineered protocol for native-less providers', async () => {
    // Fireworks speaks the Responses API but has no built-in web_search, so it
    // stays on the prompt-engineered path like Ollama.
    for (const provider of ['fireworks', 'ollama'] as ActiveProvider[]) {
      const options = await runWithProvider(provider);
      expect(options.webSearchToolProtocol).toBe(WEB_SEARCH_TOOL_PROTOCOL);
    }
  });
});
