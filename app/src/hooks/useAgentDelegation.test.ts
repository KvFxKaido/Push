import { beforeEach, describe, expect, it, vi } from 'vitest';

// useAgentDelegation is a large (~1900 LOC) orchestrator that composes many
// agents (explorer/coder/auditor/planner/task-graph) and persistence layers.
// The deep per-agent logic lives in the helpers it imports (coder-agent,
// explorer-agent, auditor-agent, planner-agent, task-graph, context-memory,
// verification-runtime). These each have their own unit tests. Here we
// cover the hook's public surface: that it exposes `executeDelegateCall`,
// that early-return Tool Error paths are reachable, and that unknown tool
// calls fall through to an empty result.

const orchestrator = vi.hoisted(() => ({
  getActiveProvider: vi.fn(() => 'openrouter'),
}));
const sandboxClient = vi.hoisted(() => ({
  getSandboxDiff: vi.fn<() => Promise<string | { diff: string }>>(async () => ''),
  getSandboxOwnerToken: vi.fn<(sandboxId?: string) => string | null>(() => 'tok-1'),
}));
const userProfile = vi.hoisted(() => ({
  getUserProfile: vi.fn(() => null),
}));
const coderAgent = vi.hoisted(() => ({
  runCoderAgent: vi.fn(),
  generateCheckpointAnswer: vi.fn(),
  summarizeCoderStateForHandoff: vi.fn(() => null),
}));
const explorerAgent = vi.hoisted(() => ({
  runExplorerAgent: vi.fn(),
}));
const plannerAgent = vi.hoisted(() => ({
  runPlanner: vi.fn(),
  formatPlannerBrief: vi.fn(() => ''),
}));
const auditorAgent = vi.hoisted(() => ({
  runAuditorEvaluation: vi.fn(),
}));
const modelCapabilities = vi.hoisted(() => ({
  resolveHarnessSettings: vi.fn<
    () => {
      profile?: string;
      maxCoderRounds?: number;
      plannerRequired?: boolean;
      contextResetsEnabled?: boolean;
      evaluateAfterCoder?: boolean;
      harness?: string;
    }
  >(() => ({ harness: 'default' })),
}));
const taskGraph = vi.hoisted(() => ({
  // Real validateTaskGraph returns `TaskGraphValidationError[]` (empty = valid);
  // keep the mock shape aligned so `.length`/array methods work as in prod.
  validateTaskGraph: vi.fn(() => [] as unknown[]),
  executeTaskGraph: vi.fn(),
}));
const chatToolMessages = vi.hoisted(() => ({
  appendCardsToLatestToolCall: vi.fn((msgs: unknown[]) => msgs),
}));
const chatRunEvents = vi.hoisted(() => ({
  summarizeToolResultPreview: vi.fn((s: string) => s),
}));
const delegationResult = vi.hoisted(() => ({
  buildDelegationResultCard: vi.fn(() => ({ type: 'delegation-result' })),
  filterDelegationCardsForInlineDisplay: vi.fn(() => []),
  formatCompactDelegationToolResult: vi.fn(() => ''),
}));
const contextMemory = vi.hoisted(() => ({
  buildRetrievedMemoryKnownContext: vi.fn(async () => ({ line: null })),
  writeDecisionMemory: vi.fn(async () => {}),
  writeExplorerMemory: vi.fn(async () => {}),
  writeTaskGraphNodeMemory: vi.fn(async () => {}),
  writeCoderMemory: vi.fn(async () => {}),
  invalidateMemoryForChangedFiles: vi.fn(async () => {}),
}));
const verificationRuntime = vi.hoisted(() => ({
  activateVerificationGate: vi.fn((s: unknown) => s),
  buildVerificationAcceptanceCriteria: vi.fn(() => []),
  extractChangedPathsFromDiff: vi.fn<(diff: string) => string[]>(() => []),
  recordVerificationArtifact: vi.fn((s: unknown) => s),
  recordVerificationCommandResult: vi.fn((s: unknown) => s),
  recordVerificationGateResult: vi.fn((s: unknown) => s),
  recordVerificationMutation: vi.fn((s: unknown) => s),
}));
const utilsLib = vi.hoisted(() => ({
  formatElapsedTime: vi.fn(() => '0s'),
}));
const chatPersistence = vi.hoisted(() => ({
  createId: vi.fn(() => 'test-id'),
}));
const tracing = vi.hoisted(() => ({
  setSpanAttributes: vi.fn(),
  withActiveSpan: vi.fn(async (_n: unknown, _o: unknown, fn: (span: unknown) => unknown) =>
    fn({ setStatus: vi.fn() }),
  ),
  SpanKind: { INTERNAL: 'internal' },
  SpanStatusCode: { OK: 1, ERROR: 2 },
}));
const correlation = vi.hoisted(() => ({
  correlationToSpanAttributes: vi.fn(() => ({})),
  extendCorrelation: vi.fn((base: unknown, ext: unknown) => ({
    ...(base as object),
    ...(ext as object),
  })),
}));

vi.mock('@/lib/orchestrator', () => orchestrator);
vi.mock('@/lib/sandbox-client', () => sandboxClient);
vi.mock('@/hooks/useUserProfile', () => userProfile);
vi.mock('@/lib/coder-agent', () => coderAgent);
vi.mock('@/lib/explorer-agent', () => explorerAgent);
vi.mock('@/lib/planner-agent', () => plannerAgent);
vi.mock('@/lib/auditor-agent', () => auditorAgent);
vi.mock('@/lib/model-capabilities', () => modelCapabilities);
vi.mock('@/lib/task-graph', () => taskGraph);
vi.mock('@/lib/chat-tool-messages', () => chatToolMessages);
vi.mock('@/lib/chat-run-events', () => chatRunEvents);
vi.mock('@/lib/delegation-result', () => delegationResult);
vi.mock('@/lib/context-memory', () => contextMemory);
vi.mock('@/lib/verification-runtime', () => verificationRuntime);
vi.mock('@/lib/utils', () => utilsLib);
vi.mock('@/hooks/chat-persistence', () => chatPersistence);
vi.mock('@/lib/tracing', () => tracing);
vi.mock('@push/lib/correlation-context', () => correlation);
vi.mock('@/lib/tool-dispatch', () => ({}));

vi.mock('react', () => ({
  useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));

const { useAgentDelegation } = await import('./useAgentDelegation');

function makeParams() {
  return {
    setConversations: vi.fn(),
    updateAgentStatus: vi.fn(),
    appendRunEvent: vi.fn(),
    emitRunEngineEvent: vi.fn(),
    getVerificationPolicyForChat: vi.fn<
      () => { mode: string; requireAuditor: boolean; autoVerifyOnMutation: boolean }
    >(() => ({
      mode: 'strict',
      requireAuditor: true,
      autoVerifyOnMutation: true,
    })),
    updateVerificationStateForChat: vi.fn(),
    branchInfoRef: { current: { currentBranch: 'main', defaultBranch: 'main' } },
    isMainProtectedRef: { current: false },
    agentsMdRef: { current: null },
    instructionFilenameRef: { current: null },
    sandboxIdRef: { current: null as string | null },
    repoRef: { current: null as string | null },
    abortControllerRef: { current: null },
    abortRef: { current: false },
    lastCoderStateRef: { current: null },
  };
}

beforeEach(() => {
  orchestrator.getActiveProvider.mockReset().mockReturnValue('openrouter');
  explorerAgent.runExplorerAgent.mockReset();
  coderAgent.runCoderAgent.mockReset();
  plannerAgent.runPlanner.mockReset();
  plannerAgent.formatPlannerBrief.mockReset();
  auditorAgent.runAuditorEvaluation.mockReset();
  taskGraph.validateTaskGraph.mockReset().mockReturnValue([]);
  taskGraph.executeTaskGraph.mockReset();
  contextMemory.buildRetrievedMemoryKnownContext.mockReset().mockResolvedValue({ line: null });
  // Clear call history for memory-persistence mocks so tests asserting call
  // counts (e.g. the Phase 5 TG memory-persistence test) see a clean slate.
  // Use mockClear (not mockReset) to preserve the default no-op
  // implementation; these mocks don't need per-test behavior overrides.
  contextMemory.writeTaskGraphNodeMemory.mockClear();
  contextMemory.invalidateMemoryForChangedFiles.mockClear();
  contextMemory.writeCoderMemory.mockClear();
  contextMemory.writeExplorerMemory.mockClear();
});

describe('useAgentDelegation — public API', () => {
  it('returns executeDelegateCall', () => {
    const params = makeParams();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hook = useAgentDelegation(params as any);
    expect(typeof hook.executeDelegateCall).toBe('function');
  });
});

describe('useAgentDelegation.executeDelegateCall — delegate_explorer', () => {
  it('returns a Tool Error when task is empty', async () => {
    const params = makeParams();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(params as any);
    const toolCall = {
      source: 'delegate' as const,
      call: { tool: 'delegate_explorer' as const, args: { task: '   ' } },
    };
    const result = await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );
    expect(result.text).toContain('[Tool Error]');
    expect(result.text).toContain('non-empty');
    expect(explorerAgent.runExplorerAgent).not.toHaveBeenCalled();
  });

  it('emits DELEGATION_STARTED for a valid explorer task', async () => {
    explorerAgent.runExplorerAgent.mockResolvedValue({
      rounds: 1,
      summary: 'explored',
      cards: [],
    });
    const params = makeParams();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(params as any);
    const toolCall = {
      source: 'delegate' as const,
      call: { tool: 'delegate_explorer' as const, args: { task: 'find auth' } },
    };
    await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );
    expect(params.emitRunEngineEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'DELEGATION_STARTED', agent: 'explorer' }),
    );
    expect(explorerAgent.runExplorerAgent).toHaveBeenCalledOnce();
  });

  it('records a failure when runExplorerAgent throws a non-abort error', async () => {
    explorerAgent.runExplorerAgent.mockRejectedValue(new Error('boom'));
    const params = makeParams();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(params as any);
    const toolCall = {
      source: 'delegate' as const,
      call: { tool: 'delegate_explorer' as const, args: { task: 'do it' } },
    };
    const result = await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );
    expect(result.text).toContain('[Tool Error]');
    expect(result.text).toContain('Explorer failed');
    expect(params.appendRunEvent).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ type: 'subagent.failed', agent: 'explorer' }),
    );
  });
});

describe('useAgentDelegation.executeDelegateCall — delegate_coder', () => {
  it('returns a Tool Error when no sandbox is available', async () => {
    const params = makeParams();
    params.sandboxIdRef.current = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(params as any);
    const toolCall = {
      source: 'delegate' as const,
      call: { tool: 'delegate_coder' as const, args: { task: 'fix bug' } },
    };
    const result = await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );
    expect(result.text).toContain('[Tool Error]');
    expect(result.text).toContain('sandbox');
    expect(coderAgent.runCoderAgent).not.toHaveBeenCalled();
  });

  it('returns a Tool Error when task and tasks are both empty', async () => {
    const params = makeParams();
    params.sandboxIdRef.current = 'sbx-1';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(params as any);
    const toolCall = {
      source: 'delegate' as const,
      call: { tool: 'delegate_coder' as const, args: { task: '', tasks: [] } },
    };
    const result = await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );
    expect(result.text).toContain('[Tool Error]');
    expect(result.text).toContain('task');
    expect(coderAgent.runCoderAgent).not.toHaveBeenCalled();
  });

  it('emits DELEGATION_STARTED for coder when sandbox + task are present', async () => {
    const params = makeParams();
    params.sandboxIdRef.current = 'sbx-1';
    // Make runCoderAgent reject so we don't have to fill out the full success
    // path; the DELEGATION_STARTED event fires before the try block.
    coderAgent.runCoderAgent.mockRejectedValue(new Error('short-circuit'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(params as any);
    const toolCall = {
      source: 'delegate' as const,
      call: { tool: 'delegate_coder' as const, args: { task: 'fix it' } },
    };
    await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );
    expect(params.emitRunEngineEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'DELEGATION_STARTED', agent: 'coder' }),
    );
  });
});

describe('useAgentDelegation.executeDelegateCall — unknown tool', () => {
  it('falls through to an empty-text result for an unrecognized tool', async () => {
    const params = makeParams();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(params as any);
    const toolCall = {
      source: 'github' as const,
      call: { tool: 'some_other_tool', args: {} },
    };
    const result = await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );
    expect(result).toEqual({ text: '' });
  });
});

// ---------------------------------------------------------------------------
// Delegation-outcomes characterization — the Step 2 remnant from the
// Architecture Remediation Plan. The explorer-happy-start and coder-short-
// circuit tests above exercise the pre-outcome emission paths
// (`DELEGATION_STARTED`, mock dispatch); these tests pin the full outcome
// surface the agent reports back through `appendRunEvent` and
// `toolExecResult.delegationOutcome`: `subagent.completed` shape on success,
// `subagent.failed` on error, and the structured `DelegationOutcome` fields
// each role produces (rounds, checkpoints, summary, status).
// ---------------------------------------------------------------------------

describe('useAgentDelegation.executeDelegateCall — delegation outcomes', () => {
  it('emits subagent.completed with an explorer DelegationOutcome on happy path', async () => {
    explorerAgent.runExplorerAgent.mockResolvedValue({
      rounds: 2,
      summary: 'found the auth module at src/auth.ts',
      cards: [],
    });
    const params = makeParams();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(params as any);
    const toolCall = {
      source: 'delegate' as const,
      call: { tool: 'delegate_explorer' as const, args: { task: 'find auth' } },
    };

    const result = await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );

    expect(params.appendRunEvent).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        type: 'subagent.completed',
        agent: 'explorer',
        delegationOutcome: expect.objectContaining({
          agent: 'explorer',
          status: 'complete',
          summary: 'found the auth module at src/auth.ts',
          rounds: 2,
        }),
      }),
    );
    expect(result.delegationOutcome).toMatchObject({
      agent: 'explorer',
      status: 'complete',
      rounds: 2,
    });
    expect(result.card).toBeDefined();
  });

  it('emits subagent.completed with a coder DelegationOutcome on happy path', async () => {
    coderAgent.runCoderAgent.mockResolvedValue({
      rounds: 3,
      checkpoints: 1,
      cards: [],
      summary: 'implemented the feature',
      criteriaResults: [],
    });
    const params = makeParams();
    params.sandboxIdRef.current = 'sbx-1';
    // The auditor branch is gated by harnessSettings.evaluateAfterCoder; the
    // default resolveHarnessSettings mock omits that field, so the auditor
    // span does not fire here. The dedicated `pins auditor subagent.completed`
    // test below enables it.
    params.getVerificationPolicyForChat = vi.fn(() => ({
      mode: 'off' as const,
      requireAuditor: false,
      autoVerifyOnMutation: false,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(params as any);
    const toolCall = {
      source: 'delegate' as const,
      call: { tool: 'delegate_coder' as const, args: { task: 'implement it' } },
    };

    const result = await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );

    expect(coderAgent.runCoderAgent).toHaveBeenCalledOnce();
    expect(params.appendRunEvent).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        type: 'subagent.completed',
        agent: 'coder',
        delegationOutcome: expect.objectContaining({
          agent: 'coder',
          rounds: 3,
          checkpoints: 1,
        }),
      }),
    );
    expect(result.delegationOutcome).toMatchObject({
      agent: 'coder',
      rounds: 3,
      checkpoints: 1,
    });
    expect(result.card).toBeDefined();
  });

  it('emits subagent.failed and a Tool Error when runCoderAgent throws', async () => {
    coderAgent.runCoderAgent.mockRejectedValue(new Error('compile error in sandbox'));
    const params = makeParams();
    params.sandboxIdRef.current = 'sbx-1';
    params.getVerificationPolicyForChat = vi.fn(() => ({
      mode: 'off' as const,
      requireAuditor: false,
      autoVerifyOnMutation: false,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(params as any);
    const toolCall = {
      source: 'delegate' as const,
      call: { tool: 'delegate_coder' as const, args: { task: 'fix it' } },
    };

    const result = await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );

    expect(result.text).toContain('[Tool Error]');
    expect(result.text).toContain('Coder failed');
    expect(params.appendRunEvent).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ type: 'subagent.failed', agent: 'coder' }),
    );
    expect(result.delegationOutcome).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Side-effect surface — the council review on the initial 3-test landing
  // (Gemini + Codex, both flagged this independently) called the envelope-only
  // coverage above material undercoverage of the plan's "Behavior rule"
  // ("exact command sequence, mutation flags, cache clearing, card shapes,
  // user-visible text"). The three tests below pin the side-effect surface
  // those reviewers identified as highest-value: verification-state mutation
  // recording when the Coder produces a non-empty diff, the auditor-enabled
  // completion event + verdict line, and the subagent.started → completed +
  // DELEGATION_STARTED ordering invariants the dispatcher relies on.
  // -------------------------------------------------------------------------

  it('records verification mutation when Coder produces a non-empty diff', async () => {
    coderAgent.runCoderAgent.mockResolvedValue({
      rounds: 1,
      checkpoints: 0,
      cards: [],
      summary: 'edited auth module',
      criteriaResults: [],
    });
    sandboxClient.getSandboxDiff.mockResolvedValueOnce({
      diff: 'diff --git a/src/auth.ts b/src/auth.ts\n+const x = 1;\n',
    });
    verificationRuntime.extractChangedPathsFromDiff.mockReturnValueOnce(['src/auth.ts']);

    const params = makeParams();
    params.sandboxIdRef.current = 'sbx-1';
    // The default updateVerificationStateForChat mock just records the call
    // without invoking the transformer; override it so downstream record*
    // mocks fire and we can assert on the structured mutation envelope.
    const fakeVerificationState = {};
    params.updateVerificationStateForChat = vi.fn(
      (_chatId: string, transformer: (state: unknown) => unknown) => {
        transformer(fakeVerificationState);
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(params as any);
    const toolCall = {
      source: 'delegate' as const,
      call: { tool: 'delegate_coder' as const, args: { task: 'fix auth bug' } },
    };

    await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );

    expect(params.updateVerificationStateForChat).toHaveBeenCalledWith(
      'chat-1',
      expect.any(Function),
    );
    expect(verificationRuntime.recordVerificationMutation).toHaveBeenCalledWith(
      fakeVerificationState,
      expect.objectContaining({
        source: 'coder',
        touchedPaths: ['src/auth.ts'],
        detail: 'Coder delegation mutated the workspace.',
      }),
    );
  });

  it('pins the auditor subagent.completed event when harnessSettings.evaluateAfterCoder is true', async () => {
    coderAgent.runCoderAgent.mockResolvedValue({
      rounds: 2,
      checkpoints: 0,
      cards: [],
      summary: 'implemented the change',
      criteriaResults: [],
    });
    // The auditor branch fires when harnessSettings.evaluateAfterCoder is
    // truthy AND summaries.length > 0. The default resolveHarnessSettings
    // mock omits both fields; override to enable the branch.
    modelCapabilities.resolveHarnessSettings.mockReturnValueOnce({
      evaluateAfterCoder: true,
      maxCoderRounds: 30,
    });
    auditorAgent.runAuditorEvaluation.mockResolvedValueOnce({
      verdict: 'complete',
      summary: 'all acceptance criteria met',
      gaps: [],
    });

    const params = makeParams();
    params.sandboxIdRef.current = 'sbx-1';
    // Same callback-invoking override as the verification-mutation test: the
    // auditor verdict flows through updateVerificationStateForChat, which by
    // default doesn't run its transformer.
    const fakeVerificationState = {};
    params.updateVerificationStateForChat = vi.fn(
      (_chatId: string, transformer: (state: unknown) => unknown) => {
        transformer(fakeVerificationState);
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(params as any);
    const toolCall = {
      source: 'delegate' as const,
      call: { tool: 'delegate_coder' as const, args: { task: 'implement it' } },
    };

    await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );

    expect(auditorAgent.runAuditorEvaluation).toHaveBeenCalledOnce();
    expect(params.appendRunEvent).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        type: 'subagent.started',
        agent: 'auditor',
        detail: 'Evaluating coder output',
      }),
    );
    expect(params.appendRunEvent).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        type: 'subagent.completed',
        agent: 'auditor',
        summary: expect.stringContaining('all acceptance criteria met'),
      }),
    );
    expect(verificationRuntime.recordVerificationGateResult).toHaveBeenCalledWith(
      fakeVerificationState,
      'auditor',
      'passed',
      'all acceptance criteria met',
    );
  });

  it('pins event ordering: DELEGATION_STARTED before runCoderAgent, subagent.started before subagent.completed', async () => {
    coderAgent.runCoderAgent.mockResolvedValue({
      rounds: 1,
      checkpoints: 0,
      cards: [],
      summary: 'done',
      criteriaResults: [],
    });
    const params = makeParams();
    params.sandboxIdRef.current = 'sbx-1';
    params.getVerificationPolicyForChat = vi.fn(() => ({
      mode: 'off' as const,
      requireAuditor: false,
      autoVerifyOnMutation: false,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(params as any);
    const toolCall = {
      source: 'delegate' as const,
      call: { tool: 'delegate_coder' as const, args: { task: 'fix it' } },
    };

    await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );

    // emitRunEngineEvent({ DELEGATION_STARTED }) must fire before runCoderAgent.
    const delegationStartedOrder = params.emitRunEngineEvent.mock.invocationCallOrder[0];
    const runCoderOrder = coderAgent.runCoderAgent.mock.invocationCallOrder[0];
    expect(delegationStartedOrder).toBeLessThan(runCoderOrder);

    // subagent.started must precede subagent.completed in appendRunEvent calls.
    const startedCallIndex = params.appendRunEvent.mock.calls.findIndex(
      (call: unknown[]) =>
        call[1] !== null &&
        typeof call[1] === 'object' &&
        (call[1] as { type?: string; agent?: string }).type === 'subagent.started' &&
        (call[1] as { agent?: string }).agent === 'coder',
    );
    const completedCallIndex = params.appendRunEvent.mock.calls.findIndex(
      (call: unknown[]) =>
        call[1] !== null &&
        typeof call[1] === 'object' &&
        (call[1] as { type?: string; agent?: string }).type === 'subagent.completed' &&
        (call[1] as { agent?: string }).agent === 'coder',
    );
    expect(startedCallIndex).toBeGreaterThanOrEqual(0);
    expect(completedCallIndex).toBeGreaterThan(startedCallIndex);
  });
});

// ---------------------------------------------------------------------------
// Planner sub-seam characterization — pre-requisite for Phase 3 of the
// useAgentDelegation extraction track (recon doc: §"Recommended Extraction
// Order — Phase 3: Sequential Coder Handler (+ Planner Sub-Seam)").
//
// The Planner fires as a pre-pass inside the delegate_coder branch when
// harnessSettings.plannerRequired is true AND taskList.length === 1. Its
// output (plannerBrief) threads into runCoderAgent's options bag at the
// 11th positional argument. The seam has a fail-open contract: if
// runPlanner returns null, Coder proceeds with plannerBrief=undefined and
// a subagent.failed event records the null-plan path.
//
// These three tests pin the current behavior so the Phase 3 extraction
// cannot silently drop the gate, the skip path, or the data-flow contract.
// ---------------------------------------------------------------------------

describe('useAgentDelegation.executeDelegateCall — Planner sub-seam', () => {
  it('fires Planner when harnessSettings.plannerRequired and taskList is single', async () => {
    modelCapabilities.resolveHarnessSettings.mockReturnValueOnce({
      plannerRequired: true,
      profile: 'small-model',
    });
    plannerAgent.runPlanner.mockResolvedValueOnce({ checklist: ['step 1'] });
    plannerAgent.formatPlannerBrief.mockReturnValueOnce('Plan:\n- step 1');
    coderAgent.runCoderAgent.mockResolvedValueOnce({
      rounds: 1,
      checkpoints: 0,
      cards: [],
      summary: 'done',
      criteriaResults: [],
    });
    const params = makeParams();
    params.sandboxIdRef.current = 'sbx-1';
    params.getVerificationPolicyForChat = vi.fn(() => ({
      mode: 'off' as const,
      requireAuditor: false,
      autoVerifyOnMutation: false,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(params as any);
    const toolCall = {
      source: 'delegate' as const,
      call: { tool: 'delegate_coder' as const, args: { task: 'implement it' } },
    };

    await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );

    expect(plannerAgent.runPlanner).toHaveBeenCalledOnce();
    // First positional arg is the single task; second is files (empty array).
    expect(plannerAgent.runPlanner.mock.calls[0][0]).toBe('implement it');
    expect(plannerAgent.runPlanner.mock.calls[0][1]).toEqual([]);
    expect(plannerAgent.formatPlannerBrief).toHaveBeenCalledWith({ checklist: ['step 1'] });

    // Envelope: planner.started + planner.completed are both emitted.
    expect(params.appendRunEvent).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        type: 'subagent.started',
        agent: 'planner',
        detail: 'implement it',
      }),
    );
    expect(params.appendRunEvent).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ type: 'subagent.completed', agent: 'planner' }),
    );

    // Ordering invariant load-bearing for extraction: planner.completed falls
    // between planner.started and the terminal coder.completed. If Phase 3
    // hoists the planner completion emission out of the sub-seam's span
    // closure, this order breaks.
    const plannerStartedIndex = params.appendRunEvent.mock.calls.findIndex(
      (call: unknown[]) =>
        call[1] !== null &&
        typeof call[1] === 'object' &&
        (call[1] as { type?: string; agent?: string }).type === 'subagent.started' &&
        (call[1] as { agent?: string }).agent === 'planner',
    );
    const plannerCompletedIndex = params.appendRunEvent.mock.calls.findIndex(
      (call: unknown[]) =>
        call[1] !== null &&
        typeof call[1] === 'object' &&
        (call[1] as { type?: string; agent?: string }).type === 'subagent.completed' &&
        (call[1] as { agent?: string }).agent === 'planner',
    );
    const coderCompletedIndex = params.appendRunEvent.mock.calls.findIndex(
      (call: unknown[]) =>
        call[1] !== null &&
        typeof call[1] === 'object' &&
        (call[1] as { type?: string; agent?: string }).type === 'subagent.completed' &&
        (call[1] as { agent?: string }).agent === 'coder',
    );
    expect(plannerStartedIndex).toBeGreaterThanOrEqual(0);
    expect(plannerCompletedIndex).toBeGreaterThan(plannerStartedIndex);
    expect(coderCompletedIndex).toBeGreaterThan(plannerCompletedIndex);

    // Data flow: formatted plannerBrief reaches runCoderAgent's options bag.
    // runCoderAgent signature is positional; options bag is the 12th arg (index 11).
    const coderOptions = coderAgent.runCoderAgent.mock.calls[0][11];
    expect(coderOptions).toMatchObject({ plannerBrief: 'Plan:\n- step 1' });
  });

  it('skips Planner when taskList has multiple tasks', async () => {
    modelCapabilities.resolveHarnessSettings.mockReturnValueOnce({
      plannerRequired: true,
      profile: 'small-model',
    });
    coderAgent.runCoderAgent.mockResolvedValue({
      rounds: 1,
      checkpoints: 0,
      cards: [],
      summary: 'done',
      criteriaResults: [],
    });
    const params = makeParams();
    params.sandboxIdRef.current = 'sbx-1';
    params.getVerificationPolicyForChat = vi.fn(() => ({
      mode: 'off' as const,
      requireAuditor: false,
      autoVerifyOnMutation: false,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(params as any);
    const toolCall = {
      source: 'delegate' as const,
      call: {
        tool: 'delegate_coder' as const,
        args: { tasks: ['task A', 'task B'] },
      },
    };

    await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );

    expect(plannerAgent.runPlanner).not.toHaveBeenCalled();

    // No planner-agent events of any type.
    const plannerEventCalls = params.appendRunEvent.mock.calls.filter(
      (call: unknown[]) =>
        call[1] !== null &&
        typeof call[1] === 'object' &&
        (call[1] as { agent?: string }).agent === 'planner',
    );
    expect(plannerEventCalls).toHaveLength(0);
  });

  it('fails open when Planner returns null — Coder proceeds with plannerBrief=undefined', async () => {
    modelCapabilities.resolveHarnessSettings.mockReturnValueOnce({
      plannerRequired: true,
      profile: 'small-model',
    });
    plannerAgent.runPlanner.mockResolvedValueOnce(null);
    coderAgent.runCoderAgent.mockResolvedValueOnce({
      rounds: 1,
      checkpoints: 0,
      cards: [],
      summary: 'done',
      criteriaResults: [],
    });
    const params = makeParams();
    params.sandboxIdRef.current = 'sbx-1';
    params.getVerificationPolicyForChat = vi.fn(() => ({
      mode: 'off' as const,
      requireAuditor: false,
      autoVerifyOnMutation: false,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(params as any);
    const toolCall = {
      source: 'delegate' as const,
      call: { tool: 'delegate_coder' as const, args: { task: 'implement it' } },
    };

    await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );

    // subagent.failed fires for planner with the null-plan error message.
    expect(params.appendRunEvent).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        type: 'subagent.failed',
        agent: 'planner',
        error: 'Planner did not return a plan.',
      }),
    );

    // formatPlannerBrief is never called when plan is null.
    expect(plannerAgent.formatPlannerBrief).not.toHaveBeenCalled();

    // Fail-open contract: Coder still runs, with plannerBrief=undefined.
    // This is the load-bearing assertion Phase 3 extraction must preserve.
    expect(coderAgent.runCoderAgent).toHaveBeenCalledOnce();
    const coderOptions = coderAgent.runCoderAgent.mock.calls[0][11];
    expect(coderOptions).toMatchObject({ plannerBrief: undefined });
  });
});

// ---------------------------------------------------------------------------
// Sequential Auditor characterization — pre-requisite for Phase 4 of the
// useAgentDelegation extraction track (recon doc: §"Recommended Extraction
// Order — Phase 4: Sequential Auditor Handler").
//
// The Auditor fires after the Coder arc completes, gated by
// harnessSettings.evaluateAfterCoder && summaries.length > 0. Currently only
// the happy path (verdict == 'complete') is covered by the earlier "pins the
// auditor subagent.completed event" test. These four tests pin the three
// uncovered failure/variant paths plus the evalWorkingMemory policy so the
// Phase 4 extraction cannot silently drop any of them.
// ---------------------------------------------------------------------------

describe('useAgentDelegation.executeDelegateCall — Sequential Auditor', () => {
  it('emits subagent.failed and inconclusive gate when runAuditorEvaluation returns null', async () => {
    coderAgent.runCoderAgent.mockResolvedValueOnce({
      rounds: 1,
      checkpoints: 0,
      cards: [],
      summary: 'ran the task',
      criteriaResults: [{ id: 't1', passed: true, exitCode: 0, output: '' }],
    });
    modelCapabilities.resolveHarnessSettings.mockReturnValueOnce({
      evaluateAfterCoder: true,
      maxCoderRounds: 30,
    });
    auditorAgent.runAuditorEvaluation.mockResolvedValueOnce(null);

    const params = makeParams();
    params.sandboxIdRef.current = 'sbx-1';
    const fakeVerificationState = {};
    params.updateVerificationStateForChat = vi.fn(
      (_chatId: string, transformer: (state: unknown) => unknown) => {
        transformer(fakeVerificationState);
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(params as any);
    const toolCall = {
      source: 'delegate' as const,
      call: { tool: 'delegate_coder' as const, args: { task: 'implement it' } },
    };

    const result = await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );

    expect(params.appendRunEvent).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        type: 'subagent.failed',
        agent: 'auditor',
        error: 'Auditor returned no evaluation.',
      }),
    );
    expect(verificationRuntime.recordVerificationGateResult).toHaveBeenCalledWith(
      fakeVerificationState,
      'auditor',
      'inconclusive',
      'Auditor evaluation returned no result.',
    );
    // Outcome status falls through to criteria-derived (all passed → complete),
    // NOT the null evaluation.
    expect(result.delegationOutcome).toMatchObject({
      agent: 'coder',
      status: 'complete',
    });
    // gateVerdicts must NOT contain an auditor verdict when eval returned null
    // — extraction could accidentally push one anyway.
    expect(result.delegationOutcome?.gateVerdicts).toEqual([]);
  });

  it('fails open when runAuditorEvaluation throws — Coder result stands', async () => {
    coderAgent.runCoderAgent.mockResolvedValueOnce({
      rounds: 2,
      checkpoints: 0,
      cards: [],
      summary: 'done',
      criteriaResults: [],
    });
    modelCapabilities.resolveHarnessSettings.mockReturnValueOnce({
      evaluateAfterCoder: true,
      maxCoderRounds: 30,
    });
    auditorAgent.runAuditorEvaluation.mockRejectedValueOnce(new Error('openai 503'));

    const params = makeParams();
    params.sandboxIdRef.current = 'sbx-1';
    const fakeVerificationState = {};
    params.updateVerificationStateForChat = vi.fn(
      (_chatId: string, transformer: (state: unknown) => unknown) => {
        transformer(fakeVerificationState);
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(params as any);
    const toolCall = {
      source: 'delegate' as const,
      call: { tool: 'delegate_coder' as const, args: { task: 'implement it' } },
    };

    const result = await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );

    expect(params.appendRunEvent).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        type: 'subagent.failed',
        agent: 'auditor',
        error: 'Evaluation failed.',
      }),
    );
    expect(verificationRuntime.recordVerificationGateResult).toHaveBeenCalledWith(
      fakeVerificationState,
      'auditor',
      'inconclusive',
      'Auditor evaluation failed.',
    );
    // Fail-open invariant: the auditor throw must NOT propagate to a Coder
    // Tool Error. The Coder outcome stands.
    expect(result.text).not.toContain('[Tool Error]');
    expect(result.delegationOutcome).toMatchObject({ agent: 'coder' });
  });

  it('folds incomplete verdict with gaps into the final DelegationOutcome', async () => {
    coderAgent.runCoderAgent.mockResolvedValueOnce({
      rounds: 1,
      checkpoints: 0,
      cards: [],
      summary: 'implemented login handler',
      criteriaResults: [{ id: 't1', passed: true, exitCode: 0, output: '' }],
    });
    modelCapabilities.resolveHarnessSettings.mockReturnValueOnce({
      evaluateAfterCoder: true,
      maxCoderRounds: 30,
    });
    auditorAgent.runAuditorEvaluation.mockResolvedValueOnce({
      verdict: 'incomplete',
      summary: 'login endpoint returns 200 but swallows errors',
      gaps: ['log at error level', 'return 5xx on db failure'],
    });

    const params = makeParams();
    params.sandboxIdRef.current = 'sbx-1';
    const fakeVerificationState = {};
    params.updateVerificationStateForChat = vi.fn(
      (_chatId: string, transformer: (state: unknown) => unknown) => {
        transformer(fakeVerificationState);
      },
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(params as any);
    const toolCall = {
      source: 'delegate' as const,
      call: { tool: 'delegate_coder' as const, args: { task: 'add login handler' } },
    };

    const result = await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );

    // Verdict wins over criteria: criteria passed, but auditor said incomplete.
    expect(result.delegationOutcome).toMatchObject({
      agent: 'coder',
      status: 'incomplete',
      missingRequirements: ['log at error level', 'return 5xx on db failure'],
      nextRequiredAction: 'Address gaps identified by auditor',
    });
    expect(result.delegationOutcome?.gateVerdicts).toEqual([
      {
        gate: 'auditor',
        outcome: 'failed',
        summary: 'login endpoint returns 200 but swallows errors',
      },
    ]);
    expect(verificationRuntime.recordVerificationGateResult).toHaveBeenCalledWith(
      fakeVerificationState,
      'auditor',
      'failed',
      'login endpoint returns 200 but swallows errors',
    );
  });

  it('passes lastCoderStateRef.current as evalWorkingMemory on single-task, null on multi-task', async () => {
    // runCoderAgent is positional; index 8 is the onStateUpdate callback.
    // Invoke it from the mock so lastCoderStateRef.current gets populated
    // before the auditor reads it — otherwise single-task and multi-task
    // would both appear null and the policy would be invisible.
    const populateState = async (args: unknown[]) => {
      const onStateUpdate = args[8] as (state: unknown) => void;
      onStateUpdate({ working: 'memory-single' });
      return {
        rounds: 1,
        checkpoints: 0,
        cards: [],
        summary: 'done',
        criteriaResults: [],
      };
    };

    // --- Single-task scenario ---
    coderAgent.runCoderAgent.mockImplementationOnce((...args: unknown[]) => populateState(args));
    modelCapabilities.resolveHarnessSettings.mockReturnValueOnce({
      evaluateAfterCoder: true,
      maxCoderRounds: 30,
    });
    auditorAgent.runAuditorEvaluation.mockResolvedValueOnce({
      verdict: 'complete',
      summary: 'ok',
      gaps: [],
    });

    const paramsSingle = makeParams();
    paramsSingle.sandboxIdRef.current = 'sbx-1';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const singleHook = useAgentDelegation(paramsSingle as any);
    const singleToolCall = {
      source: 'delegate' as const,
      call: { tool: 'delegate_coder' as const, args: { task: 'single task' } },
    };
    await singleHook.executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      singleToolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );

    // Single-task: evalWorkingMemory (3rd positional arg, index 2) should
    // be the last-reported coder state, not null.
    expect(auditorAgent.runAuditorEvaluation.mock.calls[0][2]).toEqual({
      working: 'memory-single',
    });

    // --- Multi-task scenario ---
    // Reset runCoderAgent to fire the callback for both task invocations;
    // reset auditor so the next assertion sees a clean mock.calls[0].
    auditorAgent.runAuditorEvaluation.mockReset();
    coderAgent.runCoderAgent.mockReset();
    coderAgent.runCoderAgent.mockImplementation((...args: unknown[]) => populateState(args));
    modelCapabilities.resolveHarnessSettings.mockReturnValueOnce({
      evaluateAfterCoder: true,
      maxCoderRounds: 30,
    });
    auditorAgent.runAuditorEvaluation.mockResolvedValueOnce({
      verdict: 'complete',
      summary: 'ok',
      gaps: [],
    });

    const paramsMulti = makeParams();
    paramsMulti.sandboxIdRef.current = 'sbx-2';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const multiHook = useAgentDelegation(paramsMulti as any);
    const multiToolCall = {
      source: 'delegate' as const,
      call: {
        tool: 'delegate_coder' as const,
        args: { tasks: ['task A', 'task B'] },
      },
    };
    await multiHook.executeDelegateCall(
      'chat-2',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      multiToolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );

    // Multi-task: evalWorkingMemory must be null to avoid misleading the
    // evaluator. This is policy — the extraction must preserve it.
    expect(auditorAgent.runAuditorEvaluation.mock.calls[0][2]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task-Graph characterization — pre-requisite for Phase 5 of the
// useAgentDelegation extraction track (recon doc: §"Recommended Extraction
// Order — Phase 5: Task-Graph Handler").
//
// The plan_tasks branch coordinates 4 sub-seams (TG Execute, TG Explorer,
// TG Coder, TG Auditor) spanning ~736 lines. These four tests pin the
// load-bearing behaviors extraction must preserve:
//   1. `task_graph.graph_completed` envelope on successful execution.
//   2. `writeTaskGraphNodeMemory` invoked once per completed node.
//   3. TG Auditor fires when the graph contains >=1 coder node, with
//      aggregated combinedTask/combinedSummary inputs.
//   4. `evalWorkingMemory` policy: single coder node -> last-written ref
//      state, multi-coder-node graph -> null (Option A contract pin).
//
// Test 4 is the Option A contract pin from the Phase 5 design spike
// (docs/decisions/Phase 5 Handoff - Task-Graph Extraction.md §"Open Design
// Question"). The TG Auditor currently passes null for evalWorkingMemory on
// any multi-coder-node graph to avoid misleading the evaluator with only
// the last-completing node's state. Phase 5 extracts this seam unchanged;
// a future Option-B follow-up may replace the ref with a Map accumulation,
// but that change must be deliberate, not incidental. If this test starts
// failing without a matching code change in the auditor contract, the
// extraction has silently regressed the policy.
// ---------------------------------------------------------------------------

describe('useAgentDelegation.executeDelegateCall — plan_tasks (task graph)', () => {
  // Minimal coder-node shape the hook reads from graphArgs.tasks. Only
  // `id`, `agent`, `task`, and `files` are actually touched in these paths.
  const coderNode = (id: string, task: string) => ({
    id,
    agent: 'coder' as const,
    task,
    files: [] as string[],
  });

  // Pre-built nodeStates map for tests that don't need the executor closure
  // to run. Matches the shape `executeTaskGraph` returns: Map<nodeId, {
  // node, status, result, delegationOutcome }>.
  const coderNodeState = (
    id: string,
    task: string,
    delegationOutcome: Record<string, unknown> = { agent: 'coder', checks: [], rounds: 1 },
  ) =>
    [
      id,
      {
        node: coderNode(id, task),
        status: 'completed',
        result: `${id} done`,
        delegationOutcome,
      },
    ] as const;

  it('emits task_graph.graph_completed envelope on successful execution', async () => {
    taskGraph.validateTaskGraph.mockReturnValueOnce([]);
    const nodeStates = new Map([coderNodeState('n1', 'implement it')]);
    taskGraph.executeTaskGraph.mockResolvedValueOnce({
      success: true,
      aborted: false,
      summary: 'graph done',
      nodeStates,
      totalRounds: 2,
      wallTimeMs: 1234,
    });
    auditorAgent.runAuditorEvaluation.mockResolvedValueOnce({
      verdict: 'complete',
      summary: 'ok',
      gaps: [],
    });

    const params = makeParams();
    params.sandboxIdRef.current = 'sbx-1';
    // buildMemoryScope returns null when repoRef.current is null (scratch
    // mode), which would short-circuit the writeTaskGraphNodeMemory loop
    // in Test 2. Set it here too for parity across the describe block.
    params.repoRef = { current: 'owner/repo' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(params as any);
    const toolCall = {
      source: 'delegate' as const,
      call: {
        tool: 'plan_tasks' as const,
        args: { tasks: [coderNode('n1', 'implement it')] },
      },
    };

    await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );

    expect(params.appendRunEvent).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        type: 'task_graph.graph_completed',
        success: true,
        aborted: false,
        nodeCount: 1,
        totalRounds: 2,
        wallTimeMs: 1234,
      }),
    );
  });

  it('persists typed memory for every completed node via writeTaskGraphNodeMemory', async () => {
    taskGraph.validateTaskGraph.mockReturnValueOnce([]);
    const nodeStates = new Map([
      coderNodeState('n1', 'implement A'),
      coderNodeState('n2', 'implement B'),
    ]);
    taskGraph.executeTaskGraph.mockResolvedValueOnce({
      success: true,
      aborted: false,
      summary: 'graph done',
      nodeStates,
      totalRounds: 2,
      wallTimeMs: 100,
    });
    auditorAgent.runAuditorEvaluation.mockResolvedValueOnce({
      verdict: 'complete',
      summary: 'ok',
      gaps: [],
    });

    const params = makeParams();
    params.sandboxIdRef.current = 'sbx-1';
    params.repoRef = { current: 'owner/repo' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(params as any);
    const toolCall = {
      source: 'delegate' as const,
      call: {
        tool: 'plan_tasks' as const,
        args: { tasks: [coderNode('n1', 'implement A'), coderNode('n2', 'implement B')] },
      },
    };

    await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );

    // The loop at lines ~929-940 iterates graphResult.nodeStates.values()
    // and calls writeTaskGraphNodeMemory once per node. Extraction that
    // hoists this loop out of the hook must preserve the 1:1 invariant.
    expect(contextMemory.writeTaskGraphNodeMemory).toHaveBeenCalledTimes(2);
    const nodeIdsWritten = contextMemory.writeTaskGraphNodeMemory.mock.calls.map(
      (call: unknown[]) => (call[0] as { nodeState: { node: { id: string } } }).nodeState.node.id,
    );
    expect(nodeIdsWritten).toEqual(expect.arrayContaining(['n1', 'n2']));
  });

  it('fires TG Auditor with aggregated inputs when graph has a coder node', async () => {
    taskGraph.validateTaskGraph.mockReturnValueOnce([]);
    const nodeStates = new Map([
      coderNodeState('n1', 'implement login', {
        agent: 'coder',
        checks: [{ id: 'unit', passed: true, exitCode: 0, output: '' }],
        rounds: 3,
      }),
    ]);
    // Override result/message so combinedSummary has content we can assert.
    const entry = nodeStates.get('n1')!;
    (entry as { result: string }).result = 'added handler';
    taskGraph.executeTaskGraph.mockResolvedValueOnce({
      success: true,
      aborted: false,
      summary: 'done',
      nodeStates,
      totalRounds: 3,
      wallTimeMs: 200,
    });
    auditorAgent.runAuditorEvaluation.mockResolvedValueOnce({
      verdict: 'complete',
      summary: 'all good',
      gaps: [],
    });

    const params = makeParams();
    params.sandboxIdRef.current = 'sbx-1';
    params.repoRef = { current: 'owner/repo' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(params as any);
    const toolCall = {
      source: 'delegate' as const,
      call: {
        tool: 'plan_tasks' as const,
        args: { tasks: [coderNode('n1', 'implement login')] },
      },
    };

    await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );

    expect(auditorAgent.runAuditorEvaluation).toHaveBeenCalledOnce();
    // Positional args: combinedTask=[0], combinedSummary=[1].
    // The aggregation format is `[nodeId] <content>`; pin the prefix.
    expect(auditorAgent.runAuditorEvaluation.mock.calls[0][0]).toContain('[n1] implement login');
    expect(auditorAgent.runAuditorEvaluation.mock.calls[0][1]).toContain('[n1] added handler');
    expect(params.appendRunEvent).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        type: 'subagent.started',
        agent: 'auditor',
        detail: 'Evaluating task graph output',
      }),
    );
    expect(params.appendRunEvent).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        type: 'subagent.completed',
        agent: 'auditor',
        summary: expect.stringContaining('all good'),
      }),
    );
  });

  it('passes lastCoderStateRef as evalWorkingMemory on single-node graph, null on multi-node (Option A pin)', async () => {
    // Shared fake runCoderAgent that fires onStateUpdate (positional index 8
    // on runCoderAgent) from within the executor closure, populating
    // lastCoderStateRef.current before the auditor reads it. Without this
    // the single-node case would also read null and the policy pin would
    // be vacuous (both branches of the ternary would appear equal).
    const populateState = async (args: unknown[]) => {
      const onStateUpdate = args[8] as (state: unknown) => void;
      onStateUpdate({ working: 'tg-memory' });
      return {
        rounds: 1,
        checkpoints: 0,
        cards: [],
        summary: 'done',
        criteriaResults: [],
      };
    };

    // Executor-invoking graph mock: actually call the hook's taskExecutor
    // closure for each node so runCoderAgent's onStateUpdate callback fires
    // and mutates lastCoderStateRef. The default mock's resolvedValue would
    // skip the executor entirely.
    type Executor = (
      node: unknown,
      ctx: unknown,
      signal: unknown,
    ) => Promise<{ summary: string; delegationOutcome: unknown; rounds: number }>;
    const runGraph = async (
      tasks: Array<{ id: string; agent: string; task: string }>,
      executor: Executor,
    ) => {
      const nodeStates = new Map();
      for (const node of tasks) {
        const res = await executor(node, [], undefined);
        nodeStates.set(node.id, {
          node,
          status: 'completed',
          result: res.summary,
          delegationOutcome: res.delegationOutcome,
        });
      }
      return {
        success: true,
        aborted: false,
        summary: 'done',
        nodeStates,
        totalRounds: tasks.length,
        wallTimeMs: 100,
      };
    };

    // --- Single-node scenario ---
    taskGraph.validateTaskGraph.mockReturnValueOnce([]);
    coderAgent.runCoderAgent.mockImplementationOnce((...args: unknown[]) => populateState(args));
    taskGraph.executeTaskGraph.mockImplementationOnce(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (tasks: any, executor: any) => runGraph(tasks, executor),
    );
    auditorAgent.runAuditorEvaluation.mockResolvedValueOnce({
      verdict: 'complete',
      summary: 'ok',
      gaps: [],
    });

    const paramsSingle = makeParams();
    paramsSingle.sandboxIdRef.current = 'sbx-1';
    paramsSingle.repoRef = { current: 'owner/repo' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const singleHook = useAgentDelegation(paramsSingle as any);
    const singleToolCall = {
      source: 'delegate' as const,
      call: {
        tool: 'plan_tasks' as const,
        args: { tasks: [coderNode('n1', 'single')] },
      },
    };
    await singleHook.executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      singleToolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );

    // Single-coder-node graph: evalWorkingMemory (index 2) carries the
    // ref's last-written state through to the auditor.
    expect(auditorAgent.runAuditorEvaluation.mock.calls[0][2]).toEqual({
      working: 'tg-memory',
    });

    // --- Multi-node scenario ---
    auditorAgent.runAuditorEvaluation.mockReset();
    coderAgent.runCoderAgent.mockReset();
    coderAgent.runCoderAgent.mockImplementation((...args: unknown[]) => populateState(args));
    taskGraph.validateTaskGraph.mockReturnValueOnce([]);
    taskGraph.executeTaskGraph.mockImplementationOnce(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (tasks: any, executor: any) => runGraph(tasks, executor),
    );
    auditorAgent.runAuditorEvaluation.mockResolvedValueOnce({
      verdict: 'complete',
      summary: 'ok',
      gaps: [],
    });

    const paramsMulti = makeParams();
    paramsMulti.sandboxIdRef.current = 'sbx-2';
    paramsMulti.repoRef = { current: 'owner/repo' };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const multiHook = useAgentDelegation(paramsMulti as any);
    const multiToolCall = {
      source: 'delegate' as const,
      call: {
        tool: 'plan_tasks' as const,
        args: { tasks: [coderNode('n1', 'task A'), coderNode('n2', 'task B')] },
      },
    };
    await multiHook.executeDelegateCall(
      'chat-2',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      multiToolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );

    // Multi-coder-node graph: evalWorkingMemory must be null even though
    // the ref was populated by each node's onStateUpdate. This pins the
    // "pass null for multi-node" policy (recon §Coupling Hazards #3).
    // If Phase 5 extraction accidentally feeds the last node's memory or
    // changes to Map accumulation without a matching contract update,
    // this assertion breaks.
    expect(auditorAgent.runAuditorEvaluation.mock.calls[0][2]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Background-mode branch — PR #3b.
//
// When `backgroundCoderJob` is provided AND
// `isBackgroundModeEnabledForChat(chatId)` returns true, the hook must
// route `delegate_coder` through the job runner and short-circuit the
// inline arc. The placeholder ToolExecutionResult is the contract
// promised to the orchestrator turn loop — it must never claim
// completion.
// ---------------------------------------------------------------------------

describe('useAgentDelegation.executeDelegateCall — delegate_coder (background mode)', () => {
  it('routes through backgroundCoderJob.startJob and returns the placeholder text when the flag is on', async () => {
    const params = makeParams();
    params.sandboxIdRef.current = 'sbx-1';
    params.repoRef.current = 'acme/web';
    const startJob = vi.fn(async () => ({ ok: true as const, jobId: 'job-42' }));
    const formatPlaceholderText = vi.fn(
      (id: string) => `Coder delegation accepted and queued as background job ${id}.`,
    );
    const cancelJob = vi.fn(async () => {});
    const paramsWithBg = {
      ...params,
      backgroundCoderJob: { startJob, cancelJob, formatPlaceholderText },
      isBackgroundModeEnabledForChat: () => true,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(paramsWithBg as any);
    const toolCall = {
      source: 'delegate' as const,
      call: { tool: 'delegate_coder' as const, args: { task: 'fix bug' } },
    };
    const result = await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );

    expect(startJob).toHaveBeenCalledOnce();
    const startJobArg = (startJob.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(startJobArg).toMatchObject({
      chatId: 'chat-1',
      repoFullName: 'acme/web',
      sandboxId: 'sbx-1',
      ownerToken: 'tok-1',
      provider: 'openrouter',
    });
    // The inline Coder arc must NOT run in background mode.
    expect(coderAgent.runCoderAgent).not.toHaveBeenCalled();
    expect(result.text).toContain('accepted and queued');
    expect(result.text).toContain('job-42');
    expect(result.text).not.toMatch(/completed|succe(ss|eded)/i);
  });

  it('falls through to the inline path when the flag is off', async () => {
    coderAgent.runCoderAgent.mockResolvedValue({
      rounds: 1,
      checkpoints: 0,
      cards: [],
      summary: 'done',
      criteriaResults: [],
    });
    const params = makeParams();
    params.sandboxIdRef.current = 'sbx-1';
    params.repoRef.current = 'acme/web';
    const startJob = vi.fn(async () => ({ ok: true as const, jobId: 'job-42' }));
    const paramsWithBg = {
      ...params,
      backgroundCoderJob: {
        startJob,
        cancelJob: vi.fn(),
        formatPlaceholderText: vi.fn(() => ''),
      },
      // Flag off — inline path must win.
      isBackgroundModeEnabledForChat: () => false,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(paramsWithBg as any);
    const toolCall = {
      source: 'delegate' as const,
      call: { tool: 'delegate_coder' as const, args: { task: 'fix bug' } },
    };
    await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );

    expect(startJob).not.toHaveBeenCalled();
    expect(coderAgent.runCoderAgent).toHaveBeenCalledOnce();
  });

  it('returns a Tool Error when startJob fails (inline Coder arc remains untouched)', async () => {
    const params = makeParams();
    params.sandboxIdRef.current = 'sbx-1';
    params.repoRef.current = 'acme/web';
    const startJob = vi.fn(async () => ({
      ok: false as const,
      error: 'MISSING_FIELDS: envelope',
    }));
    const paramsWithBg = {
      ...params,
      backgroundCoderJob: {
        startJob,
        cancelJob: vi.fn(),
        formatPlaceholderText: vi.fn(() => ''),
      },
      isBackgroundModeEnabledForChat: () => true,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(paramsWithBg as any);
    const toolCall = {
      source: 'delegate' as const,
      call: { tool: 'delegate_coder' as const, args: { task: 'fix bug' } },
    };
    const result = await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );

    expect(startJob).toHaveBeenCalledOnce();
    expect(coderAgent.runCoderAgent).not.toHaveBeenCalled();
    expect(result.text).toContain('[Tool Error]');
    expect(result.text).toContain('MISSING_FIELDS');
  });

  it('falls back to defaultBranch when currentBranch is unset', async () => {
    const params = makeParams();
    params.sandboxIdRef.current = 'sbx-1';
    params.repoRef.current = 'acme/web';
    // currentBranch missing, defaultBranch present — envelope should
    // carry defaultBranch and startJob must still be called.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (params.branchInfoRef as any).current = { defaultBranch: 'main' };
    const startJob = vi.fn(async () => ({ ok: true as const, jobId: 'job-42' }));
    const paramsWithBg = {
      ...params,
      backgroundCoderJob: {
        startJob,
        cancelJob: vi.fn(),
        formatPlaceholderText: vi.fn(
          (id: string) => `accepted and queued as background job ${id}.`,
        ),
      },
      isBackgroundModeEnabledForChat: () => true,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(paramsWithBg as any);
    const toolCall = {
      source: 'delegate' as const,
      call: { tool: 'delegate_coder' as const, args: { task: 'fix bug' } },
    };
    await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );
    expect(startJob).toHaveBeenCalledOnce();
    const arg = (startJob.mock.calls[0] as unknown[])[0] as { branch: string };
    expect(arg.branch).toBe('main');
  });

  it('returns a Tool Error when neither currentBranch nor defaultBranch is set', async () => {
    const params = makeParams();
    params.sandboxIdRef.current = 'sbx-1';
    params.repoRef.current = 'acme/web';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (params.branchInfoRef as any).current = {};
    const startJob = vi.fn(async () => ({ ok: true as const, jobId: 'job-42' }));
    const paramsWithBg = {
      ...params,
      backgroundCoderJob: {
        startJob,
        cancelJob: vi.fn(),
        formatPlaceholderText: vi.fn(() => ''),
      },
      isBackgroundModeEnabledForChat: () => true,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(paramsWithBg as any);
    const toolCall = {
      source: 'delegate' as const,
      call: { tool: 'delegate_coder' as const, args: { task: 'fix bug' } },
    };
    const result = await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );
    expect(startJob).not.toHaveBeenCalled();
    expect(result.text).toContain('[Tool Error]');
    expect(result.text).toContain('branch');
  });

  it('returns a Tool Error when sandbox owner token is missing', async () => {
    sandboxClient.getSandboxOwnerToken.mockReturnValueOnce(null);
    const params = makeParams();
    params.sandboxIdRef.current = 'sbx-1';
    params.repoRef.current = 'acme/web';
    const startJob = vi.fn(async () => ({ ok: true as const, jobId: 'job-42' }));
    const paramsWithBg = {
      ...params,
      backgroundCoderJob: {
        startJob,
        cancelJob: vi.fn(),
        formatPlaceholderText: vi.fn(() => ''),
      },
      isBackgroundModeEnabledForChat: () => true,
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { executeDelegateCall } = useAgentDelegation(paramsWithBg as any);
    const toolCall = {
      source: 'delegate' as const,
      call: { tool: 'delegate_coder' as const, args: { task: 'fix bug' } },
    };
    const result = await executeDelegateCall(
      'chat-1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toolCall as any,
      [],
      'openrouter',
      'gpt-4',
    );

    expect(startJob).not.toHaveBeenCalled();
    expect(result.text).toContain('[Tool Error]');
    expect(result.text).toContain('owner token');
  });
});
