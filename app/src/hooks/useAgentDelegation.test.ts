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
