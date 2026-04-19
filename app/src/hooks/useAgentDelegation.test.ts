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
  getActiveProvider: vi.fn(() => 'openai'),
}));
const sandboxClient = vi.hoisted(() => ({
  getSandboxDiff: vi.fn(async () => ''),
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
  resolveHarnessSettings: vi.fn(() => ({ harness: 'default' })),
}));
const taskGraph = vi.hoisted(() => ({
  validateTaskGraph: vi.fn(() => ({ valid: true, errors: [] })),
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
  extractChangedPathsFromDiff: vi.fn(() => []),
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
    getVerificationPolicyForChat: vi.fn(() => ({
      mode: 'strict' as const,
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
  orchestrator.getActiveProvider.mockReset().mockReturnValue('openai');
  explorerAgent.runExplorerAgent.mockReset();
  coderAgent.runCoderAgent.mockReset();
  plannerAgent.runPlanner.mockReset();
  plannerAgent.formatPlannerBrief.mockClear();
  auditorAgent.runAuditorEvaluation.mockReset();
  taskGraph.validateTaskGraph.mockReset().mockReturnValue({ valid: true, errors: [] });
  taskGraph.executeTaskGraph.mockReset();
  contextMemory.buildRetrievedMemoryKnownContext.mockReset().mockResolvedValue({ line: null });
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
      'openai',
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
      'openai',
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
      'openai',
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
      'openai',
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
      'openai',
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
      'openai',
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
      'openai',
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
      'openai',
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
      'openai',
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
      'openai',
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
      'openai',
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
      'openai',
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
      'openai',
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
      'openai',
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
      'openai',
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
      'openai',
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
