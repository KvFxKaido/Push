/**
 * Inline Foreground Lane tests (PR 2 of the decision doc):
 *
 *  - preamble seeding (bounded recent-history block, open question 1),
 *  - the streaming bridge (placeholder mirroring with per-round reset),
 *  - the lane lifecycle (kernel spec wiring, auditor fold, measurement
 *    logs, abort/failure exits, the per-round checkpoint bridge),
 *  - the checkpoint-shape drift pin: a V1 checkpoint built from
 *    kernel-born state round-trips through
 *    `runCheckpointToCoderResumeState` with round/messages/working memory
 *    intact — the property adoption depends on.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockRunInPageCoderKernel,
  mockRunCoderAuditorGate,
  mockCapturePreCoderSnapshot,
  mockCreateCoderCheckpointAnswerer,
  mockTeePushStream,
  mockGetProviderPushStream,
  mockGetSandboxDiff,
  mockResolveHarnessSettings,
  mockInvalidateMemory,
} = vi.hoisted(() => ({
  mockRunInPageCoderKernel: vi.fn(),
  mockRunCoderAuditorGate: vi.fn(),
  mockCapturePreCoderSnapshot: vi.fn(),
  mockCreateCoderCheckpointAnswerer: vi.fn(),
  mockTeePushStream: vi.fn(),
  mockGetProviderPushStream: vi.fn(),
  mockGetSandboxDiff: vi.fn(),
  mockResolveHarnessSettings: vi.fn(),
  mockInvalidateMemory: vi.fn(),
}));

vi.mock('@/lib/inline-coder-run', () => ({
  runInPageCoderKernel: (...args: unknown[]) => mockRunInPageCoderKernel(...args),
  runCoderAuditorGate: (...args: unknown[]) => mockRunCoderAuditorGate(...args),
  capturePreCoderSnapshot: (...args: unknown[]) => mockCapturePreCoderSnapshot(...args),
  createCoderCheckpointAnswerer: (...args: unknown[]) => mockCreateCoderCheckpointAnswerer(...args),
  teePushStream: (...args: unknown[]) => mockTeePushStream(...args),
}));

vi.mock('@/lib/orchestrator', () => ({
  getProviderPushStream: (...args: unknown[]) => mockGetProviderPushStream(...args),
}));

vi.mock('@/lib/sandbox-client', () => ({
  getSandboxDiff: (...args: unknown[]) => mockGetSandboxDiff(...args),
}));

vi.mock('@/lib/model-capabilities', () => ({
  resolveHarnessSettings: (...args: unknown[]) => mockResolveHarnessSettings(...args),
}));

vi.mock('@/lib/context-memory', () => ({
  invalidateMemoryForChangedFiles: (...args: unknown[]) => mockInvalidateMemory(...args),
}));

import {
  buildInlineTurnPreamble,
  createInlineTranscriptMirror,
  startInlineCoderTurn,
} from './chat-send-inline';
import { buildRunCheckpointV1 } from '@/lib/run-checkpoint-capture';
import { validateRunCheckpoint } from '@push/lib/run-checkpoint';
import {
  runCheckpointToCoderResumeState,
  ADOPTION_RESUME_NOTE_MARKER,
} from '@push/lib/run-adoption-loop';
import type { PushStreamEvent } from '@push/lib/provider-contract';
import type { ChatMessage, Conversation } from '@/types';
import type { SendLoopContext } from './chat-send-types';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function msg(
  role: 'user' | 'assistant',
  content: string,
  extra?: Partial<ChatMessage>,
): ChatMessage {
  return {
    id: `m-${role}-${content.slice(0, 8)}`,
    role,
    content,
    timestamp: 1,
    status: 'done',
    ...extra,
  } as ChatMessage;
}

interface Harness {
  ctx: SendLoopContext;
  store: { current: Record<string, Conversation> };
  flushCheckpoint: ReturnType<typeof vi.fn>;
  emitRunEngineEvent: ReturnType<typeof vi.fn>;
  updateVerificationState: ReturnType<typeof vi.fn>;
  appendRunEvent: ReturnType<typeof vi.fn>;
}

function makeHarness(opts?: { sandboxId?: string | null; repo?: string | null }): Harness {
  const store = {
    current: {
      'chat-1': {
        messages: [msg('user', 'do the thing'), { ...msg('assistant', ''), status: 'streaming' }],
      } as unknown as Conversation,
    } as Record<string, Conversation>,
  };
  const flushCheckpoint = vi.fn();
  const emitRunEngineEvent = vi.fn();
  const updateVerificationState = vi.fn();
  const appendRunEvent = vi.fn();
  const ctx = {
    chatId: 'chat-1',
    lockedProvider: 'openrouter',
    resolvedModel: 'model-x',
    abortRef: { current: false },
    abortControllerRef: { current: new AbortController() },
    sandboxIdRef: { current: opts?.sandboxId === undefined ? 'sb-1' : opts.sandboxId },
    ensureSandboxRef: { current: null },
    repoRef: { current: opts?.repo === undefined ? 'owner/repo' : opts.repo },
    isMainProtectedRef: { current: true },
    branchInfoRef: { current: { currentBranch: 'feat/x', defaultBranch: 'main' } },
    checkpointRefs: { apiMessages: { current: [] as ChatMessage[] } },
    lastCoderStateRef: { current: null },
    setConversations: (
      updater: (prev: Record<string, Conversation>) => Record<string, Conversation>,
    ) => {
      store.current = updater(store.current);
    },
    dirtyConversationIdsRef: { current: new Set<string>() },
    updateAgentStatus: vi.fn(),
    appendRunEvent,
    emitRunEngineEvent,
    flushCheckpoint,
    updateVerificationState,
  } as unknown as SendLoopContext;
  return {
    ctx,
    store,
    flushCheckpoint,
    emitRunEngineEvent,
    updateVerificationState,
    appendRunEvent,
  };
}

function laneArgs() {
  return {
    trimmedText: 'do the thing',
    apiMessages: [
      msg('user', 'earlier question'),
      msg('assistant', 'earlier answer'),
      msg('user', 'do the thing'),
    ],
    runId: 'run-1',
    agentsMdRef: { current: 'AGENTS-MD' },
    instructionFilenameRef: { current: 'AGENTS.md' },
    getVerificationPolicyForChat: vi.fn(() => ({}) as never),
  };
}

function lastAssistant(store: Harness['store']): ChatMessage {
  const msgs = store.current['chat-1'].messages;
  return msgs[msgs.length - 1];
}

beforeEach(() => {
  mockRunInPageCoderKernel.mockReset().mockResolvedValue({
    summary: 'Did the thing.',
    cards: [{ type: 'diff' }],
    rounds: 3,
    checkpoints: 1,
    criteriaResults: undefined,
  });
  mockRunCoderAuditorGate.mockReset().mockResolvedValue(null);
  mockCapturePreCoderSnapshot
    .mockReset()
    .mockResolvedValue({ preCoderHead: 'abc', preCoderUntrackedFiles: ['junk.txt'] });
  mockCreateCoderCheckpointAnswerer.mockReset().mockReturnValue(async () => 'answer');
  mockTeePushStream.mockReset().mockReturnValue('TEED-STREAM');
  mockGetProviderPushStream.mockReset().mockReturnValue('PROVIDER-STREAM');
  mockGetSandboxDiff.mockReset().mockResolvedValue({ diff: 'diff --git a/src/a.ts b/src/a.ts' });
  mockResolveHarnessSettings.mockReset().mockReturnValue({ evaluateAfterCoder: true });
  mockInvalidateMemory.mockReset().mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// Preamble seeding
// ---------------------------------------------------------------------------

describe('buildInlineTurnPreamble', () => {
  it('seeds a bounded recent-history block ahead of the task', () => {
    const preamble = buildInlineTurnPreamble('do the thing', laneArgs().apiMessages);
    expect(preamble).toContain('Prior conversation in this chat');
    expect(preamble).toContain('[user] earlier question');
    expect(preamble).toContain('[assistant] earlier answer');
    expect(preamble.trim().endsWith('Task: do the thing')).toBe(true);
    // The in-flight user turn (last message) is the task, not history.
    expect(preamble.match(/do the thing/g)).toHaveLength(1);
  });

  it('skips tool-call/tool-result turns, bounds to the last 6, and truncates long turns', () => {
    const history: ChatMessage[] = [];
    for (let i = 0; i < 10; i++) history.push(msg('user', `turn ${i}`));
    history.push(msg('user', 'tool output', { isToolResult: true }));
    history.push(msg('assistant', 'x'.repeat(900)));
    history.push(msg('user', 'the task'));
    const preamble = buildInlineTurnPreamble('the task', history);
    expect(preamble).not.toContain('tool output');
    expect(preamble).not.toContain('turn 4'); // beyond the 6-turn bound
    expect(preamble).toContain('turn 9');
    expect(preamble).toContain(`${'x'.repeat(700)}…`);
  });

  it('emits only the task line when there is no usable history', () => {
    expect(buildInlineTurnPreamble('solo task', [msg('user', 'solo task')])).toBe(
      'Task: solo task',
    );
  });
});

// ---------------------------------------------------------------------------
// Streaming bridge
// ---------------------------------------------------------------------------

describe('createInlineTranscriptMirror', () => {
  it('mirrors text/reasoning deltas into the streaming placeholder and resets per round', () => {
    const { ctx, store, emitRunEngineEvent } = makeHarness();
    const mirror = createInlineTranscriptMirror(ctx);

    mirror({ type: 'reasoning_delta', text: 'thinking…' } as PushStreamEvent);
    mirror({ type: 'text_delta', text: 'round one ' } as PushStreamEvent);
    mirror({ type: 'text_delta', text: 'output' } as PushStreamEvent);
    expect(lastAssistant(store).content).toBe('round one output');
    expect(lastAssistant(store).thinking).toBe('thinking…');
    expect(lastAssistant(store).status).toBe('streaming');
    expect(emitRunEngineEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ACCUMULATED_UPDATED', text: 'round one output' }),
    );

    // A done event settles the round; the next delta starts a fresh buffer.
    mirror({ type: 'done', finishReason: 'tool_calls' } as PushStreamEvent);
    mirror({ type: 'text_delta', text: 'round two' } as PushStreamEvent);
    expect(lastAssistant(store).content).toBe('round two');
    expect(lastAssistant(store).thinking).toBeUndefined();
  });

  it('goes quiet after the user aborts', () => {
    const { ctx, store } = makeHarness();
    const mirror = createInlineTranscriptMirror(ctx);
    ctx.abortRef.current = true;
    mirror({ type: 'text_delta', text: 'late token' } as PushStreamEvent);
    expect(lastAssistant(store).content).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Lane lifecycle
// ---------------------------------------------------------------------------

describe('startInlineCoderTurn', () => {
  it('runs the kernel with the lane spec: teed stream, memory scope, cadence-1 checkpoints, no brief', async () => {
    const { ctx } = makeHarness();
    const result = await startInlineCoderTurn(ctx, laneArgs());
    expect(result.completedNormally).toBe(true);

    expect(mockTeePushStream).toHaveBeenCalledWith('PROVIDER-STREAM', expect.any(Function));
    const [spec, callbacks] = mockRunInPageCoderKernel.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(spec.provider).toBe('openrouter');
    expect(spec.modelId).toBe('model-x');
    expect(spec.sandboxId).toBe('sb-1');
    expect(spec.stream).toBe('TEED-STREAM');
    expect(spec.checkpointCadenceRounds).toBe(1);
    expect(spec.memoryScope).toEqual({
      repoFullName: 'owner/repo',
      branch: 'feat/x',
      chatId: 'chat-1',
    });
    expect(spec.branchContext).toEqual({
      activeBranch: 'feat/x',
      defaultBranch: 'main',
      protectMain: true,
    });
    expect(spec.projectInstructions).toBe('AGENTS-MD');
    // Raw turn + history — no delegation brief vocabulary.
    expect(spec.taskPreamble).toContain('Task: do the thing');
    expect(spec.taskPreamble).toContain('[assistant] earlier answer');
    expect(callbacks.onCheckpoint).toBeInstanceOf(Function);
    expect(callbacks.onCheckpointRequest).toBeInstanceOf(Function);
  });

  it('completes the placeholder with the kernel summary + cards and logs the measurement pair', async () => {
    const { ctx, store } = makeHarness();
    const logSpy = vi.spyOn(console, 'log');
    await startInlineCoderTurn(ctx, laneArgs());

    const final = lastAssistant(store);
    expect(final.content).toBe('Did the thing.');
    expect(final.status).toBe('done');
    expect(final.cards).toEqual([{ type: 'diff' }]);

    const events = logSpy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(String(c[0])) as { event?: string; outcome?: string; rounds?: number };
        } catch {
          return {};
        }
      })
      .filter((e) => e.event?.startsWith('inline_turn'));
    expect(events.some((e) => e.event === 'inline_turn_started')).toBe(true);
    expect(
      events.some(
        (e) => e.event === 'inline_turn_completed' && e.outcome === 'ok' && e.rounds === 3,
      ),
    ).toBe(true);
    logSpy.mockRestore();
  });

  it('folds the Auditor verdict line into the final message (same gate as the delegated arc)', async () => {
    mockRunCoderAuditorGate.mockResolvedValue({
      evalResult: { verdict: 'incomplete', summary: 'gaps', gaps: ['tests'] },
      auditorSummaryLine: '[Evaluation: INCOMPLETE] gaps',
    });
    const { ctx, store } = makeHarness();
    await startInlineCoderTurn(ctx, laneArgs());

    expect(lastAssistant(store).content).toBe('Did the thing.\n\n[Evaluation: INCOMPLETE] gaps');
    const [, gateInput] = mockRunCoderAuditorGate.mock.calls[0] as [
      unknown,
      { auditorInput: Record<string, unknown> },
    ];
    expect(gateInput.auditorInput.taskList).toEqual(['do the thing']);
    expect(gateInput.auditorInput.preCoderHead).toBe('abc');
    expect(gateInput.auditorInput.preCoderUntrackedFiles).toEqual(['junk.txt']);
    expect(gateInput.auditorInput.currentSandboxId).toBe('sb-1');
  });

  it('bridges the kernel checkpoint into the V1 capture: ROUND_STARTED + transcript swap + flush', async () => {
    const { ctx, flushCheckpoint, emitRunEngineEvent } = makeHarness();
    await startInlineCoderTurn(ctx, laneArgs());
    const [, callbacks] = mockRunInPageCoderKernel.mock.calls[0] as [
      unknown,
      { onCheckpoint: (state: unknown) => Promise<void> },
    ];

    const kernelMessages = [{ id: 'k1', role: 'user', content: 'task', timestamp: 0 }];
    await callbacks.onCheckpoint({
      round: 4,
      messages: kernelMessages,
      workingMemory: { plan: 'p' },
      cards: [],
    });

    expect(emitRunEngineEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ROUND_STARTED', round: 4 }),
    );
    expect(ctx.checkpointRefs.apiMessages.current).toBe(kernelMessages);
    expect(ctx.lastCoderStateRef.current).toEqual({ plan: 'p' });
    expect(flushCheckpoint).toHaveBeenCalledWith('turn');
  });

  it('records workspace mutations + invalidates file-backed memory from the post-run diff', async () => {
    const { ctx, updateVerificationState } = makeHarness();
    await startInlineCoderTurn(ctx, laneArgs());
    expect(updateVerificationState).toHaveBeenCalled();
    expect(mockInvalidateMemory).toHaveBeenCalledWith(
      expect.objectContaining({ changedPaths: ['src/a.ts'] }),
    );
  });

  it('fails the precondition cleanly without a sandbox', async () => {
    const { ctx, store } = makeHarness({ sandboxId: null });
    const result = await startInlineCoderTurn(ctx, laneArgs());
    expect(result.completedNormally).toBe(false);
    expect(mockRunInPageCoderKernel).not.toHaveBeenCalled();
    expect(lastAssistant(store).content).toContain('[Inline turn unavailable]');
    expect(lastAssistant(store).status).toBe('done');
  });

  it('marks a user abort as cancelled without a failure event', async () => {
    const { ctx, store, emitRunEngineEvent } = makeHarness();
    ctx.abortRef.current = true;
    mockRunInPageCoderKernel.mockRejectedValue(new DOMException('aborted', 'AbortError'));
    const result = await startInlineCoderTurn(ctx, laneArgs());
    expect(result.completedNormally).toBe(false);
    expect(lastAssistant(store).content).toBe('Cancelled by user.');
    expect(emitRunEngineEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'LOOP_FAILED' }),
    );
  });

  it('emits LOOP_FAILED itself on a kernel error so finalize sees a terminal phase', async () => {
    const { ctx, store, emitRunEngineEvent } = makeHarness();
    mockRunInPageCoderKernel.mockRejectedValue(new Error('provider exploded'));
    const result = await startInlineCoderTurn(ctx, laneArgs());
    expect(result.completedNormally).toBe(false);
    expect(lastAssistant(store).content).toBe('[Inline turn failed] provider exploded');
    expect(emitRunEngineEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'LOOP_FAILED', reason: 'provider exploded' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Checkpoint-shape drift pin: kernel-born V1 → adoption resume seed
// ---------------------------------------------------------------------------

describe('inline checkpoint round-trips through runCheckpointToCoderResumeState', () => {
  it('preserves round, transcript, and working memory from kernel-born state', () => {
    // The shape the lane's onCheckpoint bridge persists: kernel transcript
    // as apiMessages, kernel round, kernel working memory.
    const kernelState = {
      round: 4,
      messages: [
        { id: 'k0', role: 'user' as const, content: 'Task: do the thing', timestamp: 0 },
        {
          id: 'k1',
          role: 'assistant' as const,
          content: '{"tool":"sandbox_exec",...}',
          timestamp: 0,
          isToolCall: true,
        },
        { id: 'k2', role: 'user' as const, content: 'exit 0', timestamp: 0, isToolResult: true },
      ],
      workingMemory: { plan: 'fix the thing', currentPhase: 'editing' },
    };

    const checkpoint = buildRunCheckpointV1({
      chatId: 'chat-1',
      repoFullName: 'owner/repo',
      branch: 'feat/x',
      runId: 'run-1',
      round: kernelState.round,
      phase: 'executing_tools',
      reason: 'turn',
      apiMessages: kernelState.messages as unknown as ChatMessage[],
      accumulated: '',
      thinkingAccumulated: '',
      provider: 'openrouter',
      model: 'model-x',
      approvalMode: 'supervised',
      workingMemory: kernelState.workingMemory as never,
      sandboxSessionId: 'sb-1',
    });

    // The persisted record is schema-valid (what `captureRunCheckpointV1`
    // requires before mirroring to the RunHost).
    expect(validateRunCheckpoint(checkpoint)).toEqual([]);

    const resume = runCheckpointToCoderResumeState(checkpoint);
    expect(resume.round).toBe(4);
    expect(resume.workingMemory).toEqual(kernelState.workingMemory);
    // Transcript carried verbatim (role/content/tool flags), with the
    // adoption note appended as the final user turn.
    expect(
      resume.messages.slice(0, kernelState.messages.length).map((m) => ({
        role: m.role,
        content: m.content,
        isToolCall: m.isToolCall ?? undefined,
        isToolResult: m.isToolResult ?? undefined,
      })),
    ).toEqual(
      kernelState.messages.map((m) => ({
        role: m.role,
        content: m.content,
        isToolCall: (m as { isToolCall?: boolean }).isToolCall ?? undefined,
        isToolResult: (m as { isToolResult?: boolean }).isToolResult ?? undefined,
      })),
    );
    expect(resume.messages.at(-1)?.content).toContain(ADOPTION_RESUME_NOTE_MARKER);
  });
});
