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
  mockApplyBranchSwitchPayload,
  mockRunInlineVerificationCriteria,
  mockBuildLinkedLibraryContext,
  mockSpliceLinkedImagesIntoLastUser,
  mockMemoryStoreList,
  mockNotifyWorkspaceMutation,
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
  mockApplyBranchSwitchPayload: vi.fn(),
  mockRunInlineVerificationCriteria: vi.fn(),
  mockBuildLinkedLibraryContext: vi.fn(),
  mockSpliceLinkedImagesIntoLastUser: vi.fn(),
  mockMemoryStoreList: vi.fn(),
  mockNotifyWorkspaceMutation: vi.fn(),
}));

vi.mock('@/lib/inline-coder-run', () => ({
  runInPageCoderKernel: (...args: unknown[]) => mockRunInPageCoderKernel(...args),
  runCoderAuditorGate: (...args: unknown[]) => mockRunCoderAuditorGate(...args),
  capturePreCoderSnapshot: (...args: unknown[]) => mockCapturePreCoderSnapshot(...args),
  createCoderCheckpointAnswerer: (...args: unknown[]) => mockCreateCoderCheckpointAnswerer(...args),
  teePushStream: (...args: unknown[]) => mockTeePushStream(...args),
  runInlineVerificationCriteria: (...args: unknown[]) => mockRunInlineVerificationCriteria(...args),
}));

vi.mock('@push/lib/context-memory-store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@push/lib/context-memory-store')>()),
  getDefaultMemoryStore: () => ({ list: (...args: unknown[]) => mockMemoryStoreList(...args) }),
}));

vi.mock('@/lib/orchestrator', () => ({
  getProviderPushStream: (...args: unknown[]) => mockGetProviderPushStream(...args),
}));

vi.mock('@/lib/sandbox-client', () => ({
  getSandboxDiff: (...args: unknown[]) => mockGetSandboxDiff(...args),
  getSandboxEnvironment: () => null,
}));

vi.mock('@/lib/sandbox-mutation-signal', () => ({
  notifyWorkspaceMutation: (...args: unknown[]) => mockNotifyWorkspaceMutation(...args),
}));

vi.mock('@/lib/repo-metadata', () => ({
  getRepoMetadata: () => null,
}));

vi.mock('@/lib/model-capabilities', () => ({
  resolveHarnessSettings: (...args: unknown[]) => mockResolveHarnessSettings(...args),
  getModelCapabilities: () => ({ contextLimit: 0 }),
}));

vi.mock('@/lib/context-memory', () => ({
  invalidateMemoryForChangedFiles: (...args: unknown[]) => mockInvalidateMemory(...args),
}));

vi.mock('@/lib/branch-fork-migration', () => ({
  applyBranchSwitchPayload: (...args: unknown[]) => mockApplyBranchSwitchPayload(...args),
}));

vi.mock('@/lib/linked-library-context', () => ({
  buildLinkedLibraryContext: (...args: unknown[]) => mockBuildLinkedLibraryContext(...args),
  spliceLinkedImagesIntoLastUser: (...args: unknown[]) =>
    mockSpliceLinkedImagesIntoLastUser(...args),
}));

// Faithful stand-in for the real git_status parser (own tests live in
// auditor-delegation-handler.test.ts) — avoids dragging that heavy module's
// graph into this suite's partial mocks.
vi.mock('@/lib/auditor-delegation-handler', () => ({
  parseUntrackedFileSet: (status?: string | null) => {
    const set = new Set<string>();
    for (const line of String(status ?? '').split(/\r?\n/)) {
      if (line.startsWith('?? ')) set.add(line.slice(3).trim());
    }
    return set;
  },
}));

import {
  buildInlineTurnPreamble,
  createInlineTranscriptMirror,
  splitVisibleContent,
  startInlineCoderTurn,
} from './chat-send-inline';
import { buildRunCheckpointV1 } from '@/lib/run-checkpoint-capture';
import { validateRunCheckpoint } from '@push/lib/run-checkpoint';
import {
  runCheckpointToCoderResumeState,
  ADOPTION_RESUME_NOTE_MARKER,
} from '@push/lib/run-adoption-loop';
import type { PushStreamEvent } from '@push/lib/provider-contract';
import { createRuntimeContext } from '@push/lib/runtime-context';
import type { AttachmentData, ChatMessage, Conversation, VerificationRuntimeState } from '@/types';
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

function makeHarness(opts?: {
  sandboxId?: string | null;
  repo?: string | null;
  linkedLibraryIds?: string[];
}): Harness {
  const store = {
    current: {
      'chat-1': {
        messages: [msg('user', 'do the thing'), { ...msg('assistant', ''), status: 'streaming' }],
        linkedLibraryIds: opts?.linkedLibraryIds ?? [],
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
    scratchpadRef: {
      current: {
        content: 'Scratch note',
        replace: vi.fn(),
        append: vi.fn(),
      },
    },
    todoRef: {
      current: {
        todos: [
          {
            id: 'inspect-runbook',
            content: 'Inspect runbook',
            activeForm: 'Inspecting runbook',
            status: 'pending',
          },
        ],
        replace: vi.fn(),
        clear: vi.fn(),
      },
    },
    repoRef: { current: opts?.repo === undefined ? 'owner/repo' : opts.repo },
    isMainProtectedRef: { current: true },
    branchInfoRef: { current: { currentBranch: 'feat/x', defaultBranch: 'main' } },
    runtimeContext: createRuntimeContext({
      correlation: { surface: 'web', chatId: 'chat-1', runId: 'run-inline' },
      memory: {
        scope:
          opts?.repo === null
            ? null
            : { repoFullName: opts?.repo ?? 'owner/repo', branch: 'feat/x', chatId: 'chat-1' },
      },
    }),
    activeChatIdRef: { current: 'chat-1' },
    conversationsRef: store,
    runtimeHandlersRef: { current: { onBranchSwitch: vi.fn() } },
    checkpointRefs: { apiMessages: { current: [] as ChatMessage[] } },
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

type LaneArgs = Parameters<typeof startInlineCoderTurn>[1];

function laneArgs(overrides: Partial<LaneArgs> = {}): LaneArgs {
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
    ...overrides,
  } as LaneArgs;
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
  mockNotifyWorkspaceMutation.mockReset();
  mockResolveHarnessSettings.mockReset().mockReturnValue({ evaluateAfterCoder: true });
  mockInvalidateMemory.mockReset().mockResolvedValue(undefined);
  // Default: no verification criteria (empty policy in these fixtures). Tests
  // that exercise the gate set their own resolved value.
  mockRunInlineVerificationCriteria.mockReset().mockResolvedValue({
    criteriaResults: [],
    verificationCommandsById: new Map<string, string>(),
    summaryLine: '',
  });
  mockBuildLinkedLibraryContext.mockReset().mockResolvedValue({
    systemText: undefined,
    imageAttachments: [],
  });
  mockSpliceLinkedImagesIntoLastUser.mockReset().mockImplementation((messages) => messages);
  mockMemoryStoreList.mockReset().mockReturnValue([]);
  // Default: a recording no-op (the real append is exercised only by the
  // mid-run-divider regression test, which sets its own implementation).
  mockApplyBranchSwitchPayload.mockReset();
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

  it('rotates the vibe verbs during the responding (visible-prose) stream', () => {
    const { ctx } = makeHarness();
    const verbs = ['Backpropagating...', 'Inferring...'];
    const mirror = createInlineTranscriptMirror(ctx, verbs);
    const status = ctx.updateAgentStatus as unknown as ReturnType<typeof vi.fn>;

    status.mockClear();
    mirror({ type: 'text_delta', text: 'Here is the answer.' } as PushStreamEvent);

    // Visible prose with no tool construct → the "Responding…" opening now
    // carries the rotating vibe-verb pool (previously a static label, #verbs).
    expect(status).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'Responding...', verbs }),
      expect.objectContaining({ log: false }),
    );
  });

  it('never leaks a fenced tool call into the transcript, keeping any prose preamble', () => {
    const { ctx, store, emitRunEngineEvent } = makeHarness();
    const mirror = createInlineTranscriptMirror(ctx);

    // A round that opens with prose then a fenced tool call, streamed in the
    // fragments a provider would actually emit.
    mirror({ type: 'text_delta', text: 'Let me check the file.' } as PushStreamEvent);
    mirror({ type: 'text_delta', text: '\n```json\n{"tool":' } as PushStreamEvent);
    mirror({
      type: 'text_delta',
      text: '"sandbox_exec","args":{"cmd":"ls"}}\n```',
    } as PushStreamEvent);

    // The prose survives; the fence + tool JSON never reaches the bubble.
    expect(lastAssistant(store).content).toBe('Let me check the file.');
    expect(lastAssistant(store).content).not.toContain('sandbox_exec');
    expect(lastAssistant(store).content).not.toContain('```');
    // The ACCUMULATED_UPDATED preview (mirrored to viewers / adoption) is
    // filtered too — not just the local placeholder.
    const lastAccumulated = emitRunEngineEvent.mock.calls
      .map(([event]) => event)
      .filter((e: { type: string }) => e.type === 'ACCUMULATED_UPDATED')
      .at(-1);
    expect(lastAccumulated.text).toBe('Let me check the file.');
  });

  it('strips a bare (unfenced) tool call and a coder_update_state blob', () => {
    const { ctx, store } = makeHarness();
    const mirror = createInlineTranscriptMirror(ctx);

    mirror({ type: 'text_delta', text: '{"tool":"sandbox_exec","args":{}}' } as PushStreamEvent);
    expect(lastAssistant(store).content).toBe('');

    mirror({ type: 'done', finishReason: 'tool_calls' } as PushStreamEvent);
    mirror({
      type: 'text_delta',
      text: '{"tool":"coder_update_state","args":{"summary":"x"}}',
    } as PushStreamEvent);
    expect(lastAssistant(store).content).toBe('');
  });

  it('goes quiet after the user aborts', () => {
    const { ctx, store } = makeHarness();
    const mirror = createInlineTranscriptMirror(ctx);
    ctx.abortRef.current = true;
    mirror({ type: 'text_delta', text: 'late token' } as PushStreamEvent);
    expect(lastAssistant(store).content).toBe('');
  });
});

describe('splitVisibleContent', () => {
  it('passes plain prose through untouched', () => {
    expect(splitVisibleContent('hello, world')).toEqual({
      visible: 'hello, world',
      toolCallActive: false,
    });
  });

  it('keeps a completed (balanced) prose code fence visible', () => {
    const text = 'Here is an example:\n```ts\nconst x = 1;\n```\nDone.';
    expect(splitVisibleContent(text)).toEqual({ visible: text, toolCallActive: false });
  });

  it('cuts a fenced tool call at the fence, trimming trailing whitespace', () => {
    const { visible, toolCallActive } = splitVisibleContent(
      'Working on it.\n```json\n{"tool":"sandbox_exec"',
    );
    expect(visible).toBe('Working on it.');
    expect(toolCallActive).toBe(true);
  });

  it('cuts a bare tool call at the opening brace', () => {
    const { visible, toolCallActive } = splitVisibleContent('done {"tool":"x"}');
    expect(visible).toBe('done');
    expect(toolCallActive).toBe(true);
  });

  it('provisionally hides a dangling unbalanced fence before the key arrives', () => {
    const { visible, toolCallActive } = splitVisibleContent('prefix\n```json\n');
    expect(visible).toBe('prefix');
    expect(toolCallActive).toBe(true);
  });

  it('hides a balanced fenced array with single-quoted/unquoted tool keys', () => {
    // The dispatcher executes these shapes; the filter must hide them even
    // once the closing fence balances, or the leak reappears (Codex #894).
    const arrayForm = splitVisibleContent("intro\n```json\n[{'tool':'read_file','args':{}}]\n```");
    expect(arrayForm).toEqual({ visible: 'intro', toolCallActive: true });

    const unquoted = splitVisibleContent('intro\n```\n{tool: "read_file"}\n```');
    expect(unquoted).toEqual({ visible: 'intro', toolCallActive: true });
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
    expect(spec.scratchpad).toEqual(ctx.scratchpadRef.current);
    expect(spec.todo).toEqual(ctx.todoRef.current);
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
    expect(callbacks.onBranchSwitchPayload).toBeInstanceOf(Function);
  });

  it('signals a workspace mutation at completion when the run changed the workspace (device finding 2026-06-22)', async () => {
    // Default harness returns a non-empty diff → workspaceChanged → the
    // deterministic trigger fires the mutation signal so auto-back / checkpoint
    // capture and the hub diff view wake up on the inline lane.
    const { ctx } = makeHarness();
    await startInlineCoderTurn(ctx, laneArgs());
    expect(mockNotifyWorkspaceMutation).toHaveBeenCalledWith('sb-1');
  });

  it('does not signal a mutation on a no-change turn', async () => {
    mockGetSandboxDiff.mockResolvedValue({ diff: '', head_sha: 'abc' });
    const { ctx } = makeHarness();
    await startInlineCoderTurn(ctx, laneArgs());
    expect(mockNotifyWorkspaceMutation).not.toHaveBeenCalled();
  });

  it('passes current-turn attachments as multipart content to the kernel spec', async () => {
    const { ctx } = makeHarness();
    const attachment: AttachmentData = {
      id: 'img-1',
      type: 'image',
      filename: 'screen.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      content: 'data:image/png;base64,abc123',
    };

    await startInlineCoderTurn(ctx, laneArgs({ attachments: [attachment] }));

    const [spec] = mockRunInPageCoderKernel.mock.calls[0] as [Record<string, unknown>];
    expect(spec.initialUserContentParts).toEqual([
      { type: 'text', text: spec.taskPreamble },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } },
    ]);
  });

  it('seeds conversational turns with managed transcript context and linked libraries', async () => {
    const linkedImage: AttachmentData = {
      id: 'linked-img',
      type: 'image',
      filename: 'diagram.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      content: 'data:image/png;base64,linked123',
    };
    mockBuildLinkedLibraryContext.mockResolvedValueOnce({
      systemText: '# Linked libraries\n\n## Library: Design notes',
      imageAttachments: [linkedImage],
    });
    mockSpliceLinkedImagesIntoLastUser.mockImplementationOnce(
      (messages: ChatMessage[], images: AttachmentData[]) => {
        const next = messages.map((message) => ({ ...message }));
        const idx = next.findLastIndex((message) => message.role === 'user');
        if (idx !== -1) {
          next[idx] = {
            ...next[idx],
            attachments: [...(next[idx].attachments ?? []), ...images],
          };
        }
        return next;
      },
    );

    const { ctx } = makeHarness({ linkedLibraryIds: ['lib-1'] });
    await startInlineCoderTurn(
      ctx,
      laneArgs({
        trimmedText: 'what changed recently?',
        apiMessages: [
          msg('user', 'earlier question'),
          msg('assistant', 'earlier answer'),
          msg('user', 'what changed recently?'),
        ],
      }),
    );

    expect(mockBuildLinkedLibraryContext).toHaveBeenCalledWith(['lib-1']);
    const [spec] = mockRunInPageCoderKernel.mock.calls[0] as [Record<string, unknown>];
    expect(spec.taskInFlight).toBe(false);
    expect(spec.linkedLibraryContent).toContain('Design notes');
    expect(spec.initialMessages).toEqual([
      expect.objectContaining({ role: 'user', content: 'earlier question' }),
      expect.objectContaining({ role: 'assistant', content: 'earlier answer' }),
      expect.objectContaining({
        role: 'user',
        content: 'what changed recently?',
        contentBlocks: [
          { type: 'text', text: 'what changed recently?' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'linked123' },
          },
        ],
      }),
    ]);
    expect(JSON.stringify(spec.initialMessages)).not.toContain('Task:');
    expect(spec.initialUserContentParts).toEqual([
      { type: 'text', text: spec.taskPreamble },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,linked123' } },
    ]);
    // Digest inputs are threaded to the kernel (→ stream's single transform),
    // not pre-applied here — so history management happens exactly once.
    expect('sessionDigestRecords' in spec).toBe(true);
    expect('priorSessionDigest' in spec).toBe(true);
    expect(typeof spec.onSessionDigestEmitted).toBe('function');
  });

  it('drops display-only (visibleToModel:false) messages from the conversational seed', async () => {
    const { ctx } = makeHarness();
    await startInlineCoderTurn(
      ctx,
      laneArgs({
        trimmedText: 'how does auth work?',
        apiMessages: [
          msg('user', 'how does auth work?'),
          { ...msg('assistant', 'aborted partial'), visibleToModel: false },
        ],
      }),
    );
    const [spec] = mockRunInPageCoderKernel.mock.calls[0] as [Record<string, unknown>];
    const seed = spec.initialMessages as Array<{ content: string }>;
    expect(seed.map((m) => m.content)).toEqual(['how does auth work?']);
  });

  it('gates the session-digest memory prefetch on a short conversational turn', async () => {
    // Parity with the Orchestrator (chat-stream-round.ts): the digest stage
    // no-ops until compaction, so a short conversational turn must not pay the
    // store's full list() scan.
    const { ctx } = makeHarness();
    await startInlineCoderTurn(
      ctx,
      laneArgs({
        trimmedText: 'what changed recently?',
        apiMessages: [msg('user', 'what changed recently?')],
      }),
    );
    expect(mockMemoryStoreList).not.toHaveBeenCalled();
  });

  it('prefetches memory records when a compaction marker is already in the transcript', async () => {
    const { ctx } = makeHarness();
    await startInlineCoderTurn(
      ctx,
      laneArgs({
        trimmedText: 'what changed recently?',
        apiMessages: [
          msg('user', '[USER_GOAL]\nShip the auth refactor\n[/USER_GOAL]'),
          msg('assistant', 'noted'),
          msg('user', 'what changed recently?'),
        ],
      }),
    );
    expect(mockMemoryStoreList).toHaveBeenCalled();
  });

  it('routes kernel branchSwitch payloads through applyBranchSwitchPayload', async () => {
    const { ctx } = makeHarness();
    await startInlineCoderTurn(ctx, laneArgs());
    const [, callbacks] = mockRunInPageCoderKernel.mock.calls[0] as [
      unknown,
      { onBranchSwitchPayload: (payload: unknown) => void },
    ];
    const payload = {
      name: 'main',
      kind: 'switched',
      from: 'feat/x',
      source: 'sandbox_switch_branch',
    };

    callbacks.onBranchSwitchPayload(payload);

    expect(mockApplyBranchSwitchPayload).toHaveBeenCalledWith(
      payload,
      expect.objectContaining({
        chatId: 'chat-1',
        appendRunEvent: ctx.appendRunEvent,
        activeChatIdRef: ctx.activeChatIdRef,
        conversationsRef: ctx.conversationsRef,
        branchInfoRef: ctx.branchInfoRef,
        setConversations: ctx.setConversations,
        dirtyConversationIdsRef: ctx.dirtyConversationIdsRef,
        runtimeHandlersRef: ctx.runtimeHandlersRef,
      }),
    );
  });

  it('translates the kernel onStatus into phase-first vocab + rotating verbs (no raw "Coder" leak)', async () => {
    const { ctx } = makeHarness();
    await startInlineCoderTurn(ctx, laneArgs());
    const [, callbacks] = mockRunInPageCoderKernel.mock.calls[0] as [
      unknown,
      { onStatus: (phase: string, detail?: string) => void },
    ];
    const status = ctx.updateAgentStatus as unknown as ReturnType<typeof vi.fn>;

    // Thinking dead air → static 'Thinking…' phase + a rotating verb pool.
    status.mockClear();
    callbacks.onStatus('Coder working...', 'Round 2');
    expect(status).toHaveBeenLastCalledWith(
      expect.objectContaining({ phase: 'Thinking…', verbs: expect.any(Array) }),
      expect.objectContaining({ source: 'coder' }),
    );
    expect((status.mock.calls.at(-1)?.[0] as { verbs: string[] }).verbs.length).toBeGreaterThan(0);

    // Tool execution → phase-first label, kernel detail kept, no verbs.
    status.mockClear();
    callbacks.onStatus('Coder executing...', 'sandbox_exec');
    const arg = status.mock.calls.at(-1)?.[0] as {
      phase: string;
      detail?: string;
      verbs?: unknown;
    };
    expect(arg.phase).toBe('Editing');
    expect(arg.detail).toBe('sandbox_exec');
    expect(arg.verbs).toBeUndefined();

    // Never forwards the raw internal vocabulary.
    expect(JSON.stringify(status.mock.calls)).not.toContain('Coder executing');
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

  it('preserves reasoning streamed onto the placeholder when finalizing (no wipe on settle)', async () => {
    const { ctx, store } = makeHarness();
    // Simulate the reasoning the live mirror writes onto the placeholder while
    // the kernel streams. The finalizer used to hardcode `thinking: undefined`,
    // wiping the reasoning pane the instant the turn settled — on every model.
    const conv = store.current['chat-1'];
    const lastIdx = conv.messages.length - 1;
    conv.messages[lastIdx] = {
      ...conv.messages[lastIdx],
      thinking: 'weighed two approaches before answering',
    };

    await startInlineCoderTurn(ctx, laneArgs());

    const final = lastAssistant(store);
    expect(final.status).toBe('done');
    expect(final.thinking).toBe('weighed two approaches before answering');
  });

  it('renders an incomplete verdict as a structured card, not appended prose', async () => {
    mockRunCoderAuditorGate.mockResolvedValue({
      evalResult: {
        verdict: 'incomplete',
        summary: 'left work undone',
        gaps: ['tests'],
        confidence: 'high',
      },
      auditorSummaryLine: '[Evaluation: INCOMPLETE] left work undone',
    });
    const { ctx, store } = makeHarness();
    await startInlineCoderTurn(ctx, laneArgs());

    // The prose verdict no longer leaks into the message body.
    const final = lastAssistant(store);
    expect(final.content).toBe('Did the thing.');
    expect(final.content).not.toContain('[Evaluation:');
    // It rides the visible message as an `evaluation` card with the gaps.
    const evalCard = final.cards?.find((c) => c.type === 'evaluation');
    expect(evalCard).toEqual({
      type: 'evaluation',
      data: {
        verdict: 'incomplete',
        summary: 'left work undone',
        gaps: ['tests'],
        confidence: 'high',
      },
    });

    const [, gateInput] = mockRunCoderAuditorGate.mock.calls[0] as [
      unknown,
      { auditorInput: Record<string, unknown> },
    ];
    expect(gateInput.auditorInput.taskList).toEqual(['do the thing']);
    expect(gateInput.auditorInput.preCoderHead).toBe('abc');
    expect(gateInput.auditorInput.preCoderUntrackedFiles).toEqual(['junk.txt']);
    expect(gateInput.auditorInput.currentSandboxId).toBe('sb-1');
  });

  it('surfaces no evaluation card for a complete verdict (no self-grade footer)', async () => {
    mockRunCoderAuditorGate.mockResolvedValue({
      evalResult: { verdict: 'complete', summary: 'all good', gaps: [], confidence: 'high' },
      auditorSummaryLine: '[Evaluation: COMPLETE] all good',
    });
    const { ctx, store } = makeHarness();
    await startInlineCoderTurn(ctx, laneArgs());

    const final = lastAssistant(store);
    expect(final.content).toBe('Did the thing.');
    expect(final.content).not.toContain('[Evaluation:');
    expect(final.cards?.some((c) => c.type === 'evaluation')).toBeFalsy();
  });

  it('skips the Auditor on a read-only turn (no diff, HEAD unmoved) — no spurious verdict', async () => {
    // Conversational turn: clean tree and HEAD still at the pre-run snapshot.
    mockGetSandboxDiff.mockResolvedValue({ diff: '', head_sha: 'abc' });
    mockRunCoderAuditorGate.mockResolvedValue({
      evalResult: { verdict: 'complete', summary: 'ok', gaps: [] },
      auditorSummaryLine: '[Evaluation: COMPLETE] ok',
    });
    const { ctx, store } = makeHarness();
    await startInlineCoderTurn(ctx, laneArgs());

    expect(mockRunCoderAuditorGate).not.toHaveBeenCalled();
    expect(lastAssistant(store).content).toBe('Did the thing.');
  });

  it('still audits when the coder committed (clean tree but HEAD advanced)', async () => {
    mockGetSandboxDiff.mockResolvedValue({ diff: '', head_sha: 'def' }); // moved off 'abc'
    const { ctx } = makeHarness();
    await startInlineCoderTurn(ctx, laneArgs());
    expect(mockRunCoderAuditorGate).toHaveBeenCalled();
  });

  it('still audits a brand-new untracked file (empty diff, HEAD unmoved) — review #897', async () => {
    // `git diff HEAD` is empty for an unstaged new file; it surfaces only as
    // `?? path` in git_status, not in the pre-run untracked baseline (junk.txt).
    mockGetSandboxDiff.mockResolvedValue({
      diff: '',
      head_sha: 'abc',
      git_status: '?? src/brand-new.ts\n?? junk.txt\n',
    });
    const { ctx } = makeHarness();
    await startInlineCoderTurn(ctx, laneArgs());
    expect(mockRunCoderAuditorGate).toHaveBeenCalled();
  });

  it('skips the Auditor when the diff probe fails but only read-only tools ran — no prose verdict', async () => {
    // The reported "residual coder behavior": a conversational "what changed
    // recently?" turn answered from a read-only GitHub `commits` lookup. The
    // diff probe throws (e.g. the sandbox/runtime is unhealthy), so we can't
    // confirm a clean tree — but a read-only turn can't have mutated the
    // workspace, so the conservative fallback must NOT fire and audit prose.
    mockGetSandboxDiff.mockRejectedValue(new Error('sandbox unreachable'));
    mockRunInPageCoderKernel.mockImplementationOnce(
      async (
        _spec: unknown,
        callbacks: { onRunEvent: (event: Record<string, unknown>) => void },
      ) => {
        callbacks.onRunEvent({
          type: 'tool.execution_complete',
          round: 1,
          executionId: 'x-1',
          toolName: 'commits',
          toolSource: 'github',
          durationMs: 1,
          isError: false,
          preview: 'recent commits',
        });
        return {
          summary: 'Here is what changed recently.',
          cards: [],
          rounds: 1,
          checkpoints: 0,
          criteriaResults: undefined,
        };
      },
    );
    const { ctx, store } = makeHarness();
    await startInlineCoderTurn(ctx, laneArgs());

    expect(mockRunCoderAuditorGate).not.toHaveBeenCalled();
    expect(lastAssistant(store).content).toBe('Here is what changed recently.');
  });

  it('still audits when the diff probe fails after a sandbox-workspace mutator ran', async () => {
    // A real edit turn whose post-run diff probe throws: we genuinely can't
    // tell whether the write landed, so the conservative fallback stands. The
    // event's `toolSource` is the executing lane ('coder'); classification is
    // by tool NAME via the registry, so this still resolves to a sandbox tool.
    mockGetSandboxDiff.mockRejectedValue(new Error('sandbox unreachable'));
    mockRunInPageCoderKernel.mockImplementationOnce(
      async (
        _spec: unknown,
        callbacks: { onRunEvent: (event: Record<string, unknown>) => void },
      ) => {
        callbacks.onRunEvent({
          type: 'tool.execution_complete',
          round: 1,
          executionId: 'x-1',
          toolName: 'sandbox_write_file',
          toolSource: 'coder',
          durationMs: 1,
          isError: false,
          preview: 'wrote src/a.ts',
        });
        return {
          summary: 'Did the thing.',
          cards: [{ type: 'diff' }],
          rounds: 1,
          checkpoints: 0,
          criteriaResults: undefined,
        };
      },
    );
    const { ctx } = makeHarness();
    await startInlineCoderTurn(ctx, laneArgs());

    expect(mockRunCoderAuditorGate).toHaveBeenCalled();
  });

  it('skips the Auditor when the diff probe fails but only non-sandbox tools ran (ask_user/artifact)', async () => {
    // Codex P2 on #972: `ask_user` and `create_artifact` are non-read-only but
    // never touch the sandbox. A clarification- or artifact-only turn whose
    // probe happens to fail must NOT re-audit prose just because a non-read-only
    // tool ran — only sandbox-workspace mutators justify the conservative
    // fallback.
    mockGetSandboxDiff.mockRejectedValue(new Error('sandbox unreachable'));
    mockRunInPageCoderKernel.mockImplementationOnce(
      async (
        _spec: unknown,
        callbacks: { onRunEvent: (event: Record<string, unknown>) => void },
      ) => {
        callbacks.onRunEvent({
          type: 'tool.execution_complete',
          round: 1,
          executionId: 'x-1',
          toolName: 'artifact',
          toolSource: 'coder',
          durationMs: 1,
          isError: false,
          preview: 'created an artifact',
        });
        return {
          summary: 'Drafted that for you.',
          cards: [],
          rounds: 1,
          checkpoints: 0,
          criteriaResults: undefined,
        };
      },
    );
    const { ctx, store } = makeHarness();
    await startInlineCoderTurn(ctx, laneArgs());

    expect(mockRunCoderAuditorGate).not.toHaveBeenCalled();
    expect(lastAssistant(store).content).toBe('Drafted that for you.');
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
    expect(ctx.runtimeContext.workingMemory.coder).toEqual({ plan: 'p' });
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

  it('shields raw upstream error text from the transcript but keeps it for ops', async () => {
    const { ctx, store, emitRunEngineEvent } = makeHarness();
    const raw = '<html>\n  {"error":"boom"}  `code`\n</html>';
    mockRunInPageCoderKernel.mockRejectedValue(new Error(raw));
    await startInlineCoderTurn(ctx, laneArgs());

    const shown = lastAssistant(store).content;
    // No raw markup/fence chars reach the rendered (markdown) bubble — angle
    // brackets become inert full-width look-alikes (HTML entities would be
    // decoded back by the markdown renderer).
    expect(shown).not.toContain('<html>');
    expect(shown).not.toContain('`');
    expect(shown).not.toContain('\n');
    expect(shown).not.toContain('&lt;');
    expect(shown).toContain('＜html＞');
    // The structured failure reason keeps the full, unaltered message.
    expect(emitRunEngineEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'LOOP_FAILED', reason: raw }),
    );
  });

  it('early-exits on abort before paying for the pre-coder snapshot or kernel', async () => {
    const { ctx, store } = makeHarness();
    ctx.abortRef.current = true;
    const result = await startInlineCoderTurn(ctx, laneArgs());
    expect(result.completedNormally).toBe(false);
    expect(lastAssistant(store).content).toBe('Cancelled by user.');
    expect(mockCapturePreCoderSnapshot).not.toHaveBeenCalled();
    expect(mockRunInPageCoderKernel).not.toHaveBeenCalled();
  });

  it('names the specific missing precondition in the user-facing message', async () => {
    const { ctx, store } = makeHarness({ repo: null });
    await startInlineCoderTurn(ctx, laneArgs());
    expect(lastAssistant(store).content).toContain('a connected repo');
  });

  it('skips the checkpoint flush and logs when the kernel transcript is malformed', async () => {
    const { ctx, flushCheckpoint } = makeHarness();
    const logSpy = vi.spyOn(console, 'log');
    await startInlineCoderTurn(ctx, laneArgs());
    const [, callbacks] = mockRunInPageCoderKernel.mock.calls[0] as [
      unknown,
      { onCheckpoint: (state: unknown) => Promise<void> },
    ];

    flushCheckpoint.mockClear();
    await callbacks.onCheckpoint({
      round: 2,
      messages: [{ notARole: true }],
      workingMemory: { plan: 'p' },
      cards: [],
    });

    expect(flushCheckpoint).not.toHaveBeenCalled();
    expect(ctx.checkpointRefs.apiMessages.current).toEqual([]);
    const logged = logSpy.mock.calls
      .map((c) => {
        try {
          return JSON.parse(String(c[0])) as { event?: string };
        } catch {
          return {};
        }
      })
      .some((e) => e.event === 'coder_checkpoint_shape_invalid');
    expect(logged).toBe(true);
    logSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Card routing — disclosure vs. final message
// ---------------------------------------------------------------------------

describe('card routing: disclosure vs. final message', () => {
  /** Simulate the kernel firing onRunEvent with one tool.execution_complete event. */
  function kernelWithToolEvent(cards: object[], target?: string) {
    mockRunInPageCoderKernel.mockImplementation(
      async (_spec: unknown, callbacks: { onRunEvent?: (e: unknown) => void }) => {
        callbacks.onRunEvent?.({
          type: 'tool.execution_complete',
          round: 1,
          executionId: 'exec-1',
          toolName: 'list_commits',
          toolSource: 'coder',
          durationMs: 120,
          isError: false,
          preview: 'preview text',
          ...(target ? { target } : {}),
        });
        return { summary: 'Done.', cards, rounds: 1, checkpoints: 0 };
      },
    );
  }

  it('attaches cards to the last synthetic call message when tool events were captured', async () => {
    const commitCard = { type: 'commit-list', data: { repo: 'owner/repo', commits: [] } };
    kernelWithToolEvent([commitCard]);
    const { ctx, store } = makeHarness();
    await startInlineCoderTurn(ctx, laneArgs());

    const messages = store.current['chat-1'].messages;
    const callMsg = messages.find((m) => m.isToolCall);
    expect(callMsg).toBeDefined();
    expect(callMsg?.cards).toEqual([commitCard]);
  });

  it('threads event targets onto synthetic tool metadata', async () => {
    kernelWithToolEvent([], 'src/app.ts');
    const { ctx, store } = makeHarness();
    await startInlineCoderTurn(ctx, laneArgs());

    const messages = store.current['chat-1'].messages;
    const callMsg = messages.find((m) => m.isToolCall);
    const resultMsg = messages.find((m) => m.isToolResult);
    expect(callMsg?.toolMeta?.target).toBe('src/app.ts');
    expect(resultMsg?.toolMeta?.target).toBe('src/app.ts');
  });

  it('leaves no cards key on the final message when the disclosure absorbed them', async () => {
    kernelWithToolEvent([{ type: 'commit-list', data: {} }]);
    const { ctx, store } = makeHarness();
    await startInlineCoderTurn(ctx, laneArgs());

    const final = lastAssistant(store);
    expect(final.isToolCall).toBeFalsy();
    expect(final.cards).toBeUndefined();
  });

  it('keeps cards on the final message when no tool events were captured', async () => {
    // Default mock fires no onRunEvent — pure conversational turn.
    const { ctx, store } = makeHarness();
    await startInlineCoderTurn(ctx, laneArgs());

    const final = lastAssistant(store);
    expect(final.cards).toEqual([{ type: 'diff' }]);
    expect(store.current['chat-1'].messages.some((m) => m.isToolCall)).toBe(false);
  });

  it('produces no cards on either path when result.cards is empty', async () => {
    kernelWithToolEvent([]); // tool event fired but no cards
    const { ctx, store } = makeHarness();
    await startInlineCoderTurn(ctx, laneArgs());

    const messages = store.current['chat-1'].messages;
    const callMsg = messages.find((m) => m.isToolCall);
    expect(callMsg?.cards).toBeUndefined();
    expect(lastAssistant(store).cards).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Verification gate + workspace-patch capture (orchestrator-loop parity)
// ---------------------------------------------------------------------------

describe('verification gate + workspace-patch capture', () => {
  /** Kernel that emits one editing tool event so a synthetic tool-call
   *  message (the patch anchor) exists. */
  function editingKernel() {
    mockRunInPageCoderKernel.mockImplementation(
      async (_spec: unknown, callbacks: { onRunEvent?: (e: unknown) => void }) => {
        callbacks.onRunEvent?.({
          type: 'tool.execution_complete',
          round: 1,
          executionId: 'e1',
          toolName: 'sandbox_write_file',
          toolSource: 'coder',
          durationMs: 7,
          isError: false,
          preview: 'wrote src/a.ts',
        });
        return { summary: 'Edited.', cards: [], rounds: 2, checkpoints: 1 };
      },
    );
  }

  it('runs verification, feeds the Auditor, folds the block, and captures the patch when the turn edited', async () => {
    editingKernel();
    // Non-empty diff + HEAD moved off the pre-run snapshot ⇒ a real edit.
    mockGetSandboxDiff.mockResolvedValue({
      diff: 'diff --git a/src/a.ts b/src/a.ts',
      head_sha: 'head-after',
      git_status: '',
    });
    mockRunInlineVerificationCriteria.mockResolvedValue({
      criteriaResults: [{ id: 'verification:typecheck', passed: true, exitCode: 0, output: '' }],
      verificationCommandsById: new Map([['verification:typecheck', 'npm run typecheck']]),
      summaryLine: '\n\n[Acceptance Criteria] 1/1 passed',
    });
    const capture = vi.fn().mockResolvedValue(undefined);
    const { ctx, store, updateVerificationState } = makeHarness();
    ctx.captureWorkspacePatchAtRoundEnd = capture as never;

    await startInlineCoderTurn(ctx, laneArgs());

    // Verification ran against the live sandbox.
    expect(mockRunInlineVerificationCriteria).toHaveBeenCalledTimes(1);
    expect(mockRunInlineVerificationCriteria).toHaveBeenCalledWith(
      'sb-1',
      expect.anything(),
      expect.anything(),
    );
    // Auditor received the populated command map (not the old empty Map()).
    const auditorInput = mockRunCoderAuditorGate.mock.calls[0]?.[1] as {
      auditorInput: {
        verificationCommandsById: Map<string, string>;
        allCriteriaResults: unknown[];
      };
    };
    expect(auditorInput.auditorInput.verificationCommandsById.get('verification:typecheck')).toBe(
      'npm run typecheck',
    );
    expect(auditorInput.auditorInput.allCriteriaResults).toHaveLength(1);
    // The verification block joins the final summary.
    expect(lastAssistant(store).content).toContain('[Acceptance Criteria] 1/1 passed');
    // The patch was captured against the synthetic tool-call anchor.
    expect(capture).toHaveBeenCalledTimes(1);
    const captureArg = capture.mock.calls[0][0] as {
      workspaceMutated: boolean;
      assistantToolCallMessageId: string | null;
    };
    expect(captureArg.workspaceMutated).toBe(true);
    expect(captureArg.assistantToolCallMessageId).toBeTruthy();

    // Each command result is reflected into VerificationRuntimeState, so a
    // later runtime gate doesn't treat the passed check as still pending. We
    // assert by running the recorded updater against a seeded state with a
    // matching command rule and confirming it flips pending → passed.
    const seeded: VerificationRuntimeState = {
      policyName: 'p',
      backendTouched: true,
      mutationOccurred: true,
      lastUpdatedAt: 0,
      requirements: [
        {
          id: 'typecheck',
          label: 'tc',
          scope: 'always',
          kind: 'command',
          command: 'npm run typecheck',
          status: 'pending',
          updatedAt: 0,
        },
      ],
    };
    const recordCall = updateVerificationState.mock.calls.find(
      ([, updater]) =>
        (updater as (s: VerificationRuntimeState) => VerificationRuntimeState)(seeded)
          .requirements[0].status === 'passed',
    );
    expect(recordCall).toBeTruthy();
  });

  it('captures the patch for an untracked-only turn (new files, empty git diff HEAD)', async () => {
    editingKernel();
    // `git diff HEAD` is empty for `??` paths, but a new untracked file appears
    // and HEAD is unchanged — a real uncommitted change the capture must keep.
    mockGetSandboxDiff.mockResolvedValue({
      diff: '',
      head_sha: 'abc',
      git_status: '?? newfile.ts',
    });
    mockCapturePreCoderSnapshot.mockResolvedValue({
      preCoderHead: 'abc',
      preCoderUntrackedFiles: [],
    });
    mockRunInlineVerificationCriteria.mockResolvedValue({
      criteriaResults: [],
      verificationCommandsById: new Map<string, string>(),
      summaryLine: '',
    });
    const capture = vi.fn().mockResolvedValue(undefined);
    const { ctx } = makeHarness();
    ctx.captureWorkspacePatchAtRoundEnd = capture as never;

    await startInlineCoderTurn(ctx, laneArgs());

    expect(capture).toHaveBeenCalledTimes(1);
    expect((capture.mock.calls[0][0] as { workspaceMutated: boolean }).workspaceMutated).toBe(true);
  });

  it('skips verification and capture on a conversational turn (no edit)', async () => {
    // Default kernel fires no tool event; empty diff + unchanged HEAD + no new
    // untracked file ⇒ nothing was edited.
    mockGetSandboxDiff.mockResolvedValue({ diff: '', head_sha: 'same', git_status: '' });
    mockCapturePreCoderSnapshot.mockResolvedValue({
      preCoderHead: 'same',
      preCoderUntrackedFiles: [],
    });
    const capture = vi.fn();
    const { ctx } = makeHarness();
    ctx.captureWorkspacePatchAtRoundEnd = capture as never;

    await startInlineCoderTurn(ctx, laneArgs());

    expect(mockRunInlineVerificationCriteria).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Checkpoint answerer — delegation-arc carryover adjustments (inverse sweep)
// ---------------------------------------------------------------------------

describe('inline checkpoint answerer', () => {
  it('skips decision-memory and translates raw "Coder" status off the spinner', async () => {
    const { ctx } = makeHarness();
    await startInlineCoderTurn(ctx, laneArgs());

    const opts = mockCreateCoderCheckpointAnswerer.mock.calls[0]?.[0] as {
      memoryScope: unknown;
      updateAgentStatus: (
        s: { active: boolean; phase?: string; detail?: string },
        m?: unknown,
      ) => void;
    };

    // Inline self-consultation is not a delegated ruling — no decision memory.
    expect(opts.memoryScope).toBeNull();

    // The answerer's delegated vocabulary is translated to phase-first thinking
    // rather than leaking "Coder checkpoint" / "Coder resuming..." to the lead.
    const status = ctx.updateAgentStatus as unknown as {
      mock: { calls: Array<[{ phase?: string; detail?: string }]> };
    };
    opts.updateAgentStatus(
      { active: true, phase: 'Coder checkpoint', detail: 'should I X?' },
      { chatId: 'chat-1', source: 'coder' },
    );
    const last = status.mock.calls.at(-1)?.[0];
    expect(last?.phase).toBe('Thinking…');
    expect(last?.detail).toBeUndefined();
    expect(JSON.stringify(last)).not.toContain('Coder');
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
