import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnyToolCall, DetectedToolCalls } from '@/lib/tool-dispatch';
import {
  applyPostExecutionSideEffects,
  executeToolWithChatHooks,
  recordGithubToolTurnUsage,
  shouldSkipDelegationOutcomeRecording,
} from './chat-send-helpers';
import type { SendLoopContext } from './chat-send-types';
import {
  GITHUB_TOOL_TURN_IDLE_EVENT,
  GITHUB_TOOL_TURN_USED_EVENT,
} from '@push/lib/prompt-cost-telemetry';
import type { ToolExecutionResult } from '@/types';
import { schedulePostPushCIStatus } from './chat-post-push-ci';

vi.mock('./chat-post-push-ci', () => ({
  schedulePostPushCIStatus: vi.fn(),
}));

describe('executeToolWithChatHooks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('measures chat-hook tool durations with the monotonic clock', async () => {
    const performanceNow = vi
      .spyOn(performance, 'now')
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(107);
    const wallClock = vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(500);
    const call = {
      source: 'scratchpad',
      call: { tool: 'read_scratchpad', content: '' },
    } as unknown as AnyToolCall;

    const result = await executeToolWithChatHooks(call, {} as never, {
      scratchpadRef: {
        current: { content: 'remember this', replace: vi.fn(), append: vi.fn() },
      },
      todoRef: { current: undefined },
    });

    expect(result.durationMs).toBe(7);
    expect(performanceNow).toHaveBeenCalledTimes(2);
    expect(wallClock).not.toHaveBeenCalled();
  });
});

// Pins the Codex P1 contract from PR #603: `plan_tasks` wrapper
// outcomes carry agent='coder' or 'explorer' but the inner per-task
// nodes already record their own outcomes via the task-graph handler.
// Counting the wrapper too would double-count and could falsely break
// a later direct `delegate_coder` call. The recordDelegationOutcome
// closure uses this predicate to skip the wrapper.

describe('shouldSkipDelegationOutcomeRecording', () => {
  it('returns true for plan_tasks delegation calls (inner nodes record their own outcomes)', () => {
    const call = {
      source: 'delegate',
      call: { tool: 'plan_tasks', args: { tasks: [] } },
    } as unknown as AnyToolCall;
    expect(shouldSkipDelegationOutcomeRecording(call)).toBe(true);
  });

  it('returns false for delegate_coder so the outcome counts toward the per-agent breaker', () => {
    const call = {
      source: 'delegate',
      call: { tool: 'delegate_coder', args: { task: 'fix the bug' } },
    } as unknown as AnyToolCall;
    expect(shouldSkipDelegationOutcomeRecording(call)).toBe(false);
  });

  it('returns false for delegate_explorer so the outcome counts toward the per-agent breaker', () => {
    const call = {
      source: 'delegate',
      call: { tool: 'delegate_explorer', args: { task: 'trace the flow' } },
    } as unknown as AnyToolCall;
    expect(shouldSkipDelegationOutcomeRecording(call)).toBe(false);
  });

  it('returns false for non-delegation tools — the breaker silently ignores them anyway', () => {
    const call = {
      source: 'sandbox',
      call: { tool: 'sandbox_read_file', args: { path: '/a' } },
    } as unknown as AnyToolCall;
    expect(shouldSkipDelegationOutcomeRecording(call)).toBe(false);
  });
});

// Pins the schema-deferral measurement contract: a malformed GitHub call lands
// in `droppedCandidates` (not the classified arrays) but is still intent to use
// the GitHub schema, so it must count the turn as "used" — otherwise the
// used/idle split undercounts the deferral tax in exactly the malformed case.

function emptyDetected(overrides: Partial<DetectedToolCalls> = {}): DetectedToolCalls {
  return {
    readOnly: [],
    fileMutations: [],
    mutating: null,
    batchOverflow: [],
    extraMutations: [],
    droppedCandidates: [],
    ...overrides,
  };
}

function ctxWithGitHub(includeGitHubTools: boolean): SendLoopContext {
  return {
    chatId: 'chat-1',
    workspaceContextRef: { current: { includeGitHubTools, mode: 'repo', description: '' } },
  } as unknown as SendLoopContext;
}

function loggedEvent(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  expect(spy).toHaveBeenCalledTimes(1);
  return JSON.parse(spy.mock.calls[0]?.[0] as string);
}

describe('recordGithubToolTurnUsage', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('counts a malformed (dropped) GitHub call as "used" via its resolved name', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    recordGithubToolTurnUsage(
      emptyDetected({
        droppedCandidates: [
          { rawToolName: 'pr', resolvedToolName: 'fetch_pr', sample: '{"tool":"pr"}' },
        ],
      }),
      ctxWithGitHub(true),
      2,
    );
    const event = loggedEvent(spy);
    expect(event.event).toBe(GITHUB_TOOL_TURN_USED_EVENT);
    expect(event.githubCalls).toBe(1);
    // Dropped candidates fold into totalCalls so githubCalls <= totalCalls.
    expect(event.totalCalls).toBe(1);
  });

  it('does not let a dropped non-GitHub candidate flip the turn to "used"', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    recordGithubToolTurnUsage(
      emptyDetected({
        droppedCandidates: [
          {
            rawToolName: 'write_file',
            resolvedToolName: 'write_file',
            sample: '{"tool":"write_file"}',
          },
        ],
      }),
      ctxWithGitHub(true),
      3,
    );
    const event = loggedEvent(spy);
    expect(event.event).toBe(GITHUB_TOOL_TURN_IDLE_EVENT);
    expect(event.githubCalls).toBe(0);
    expect(event.totalCalls).toBe(1);
  });

  it('skips emission entirely when the turn did not carry the GitHub protocol', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    recordGithubToolTurnUsage(
      emptyDetected({
        droppedCandidates: [
          { rawToolName: 'pr', resolvedToolName: 'fetch_pr', sample: '{"tool":"pr"}' },
        ],
      }),
      ctxWithGitHub(false),
      1,
    );
    expect(spy).not.toHaveBeenCalled();
  });
});

function minimalSideEffectContext(onSandboxUnreachable: ReturnType<typeof vi.fn>): SendLoopContext {
  return {
    chatId: 'chat-1',
    repoRef: { current: 'owner/repo' },
    setConversations: vi.fn(),
    dirtyConversationIdsRef: { current: new Set<string>() },
    runtimeHandlersRef: { current: { onSandboxUnreachable } },
    activeChatIdRef: { current: 'chat-1' },
    conversationsRef: { current: {} },
    branchInfoRef: { current: { currentBranch: 'main', defaultBranch: 'main' } },
    updateVerificationState: vi.fn(),
    appendRunEvent: vi.fn(),
    sandboxIdRef: { current: 'sb-1' },
  } as unknown as SendLoopContext;
}

function unreachableResult(): ToolExecutionResult {
  return {
    text: '[Tool Error] Sandbox unreachable',
    structuredError: {
      type: 'SANDBOX_UNREACHABLE',
      retryable: true,
      message: 'Sandbox unreachable',
    },
  };
}

describe('applyPostExecutionSideEffects sandbox recovery policy', () => {
  it('marks read-only sandbox loss as safe to retry after recovery', async () => {
    const onSandboxUnreachable = vi.fn();
    await applyPostExecutionSideEffects(
      {
        source: 'sandbox',
        call: { tool: 'sandbox_read_file', args: { path: 'README.md' } },
      } as unknown as AnyToolCall,
      unreachableResult(),
      minimalSideEffectContext(onSandboxUnreachable),
    );

    expect(onSandboxUnreachable).toHaveBeenCalledWith('Sandbox unreachable', {
      action: 'safe-read-retry',
      toolName: 'sandbox_read_file',
      toolSource: 'sandbox',
      reason: 'read_only_tool',
    });
  });

  it('marks mutating sandbox loss as recover then inspect, not blind retry', async () => {
    const onSandboxUnreachable = vi.fn();
    await applyPostExecutionSideEffects(
      {
        source: 'sandbox',
        call: { tool: 'sandbox_exec', args: { command: 'npm test' } },
      } as unknown as AnyToolCall,
      unreachableResult(),
      minimalSideEffectContext(onSandboxUnreachable),
    );

    expect(onSandboxUnreachable).toHaveBeenCalledWith('Sandbox unreachable', {
      action: 'recover-inspect',
      toolName: 'sandbox_exec',
      toolSource: 'sandbox',
      reason: 'mutation_may_have_dispatched',
    });
  });
});

// Side effect #9 (#1298 item 4): a successful DIRECT sandbox_push schedules
// the post-push CI status injection — parity with the approval-gated path in
// chat-card-actions. Failure/blocked results must NOT schedule it.
describe('applyPostExecutionSideEffects post-push CI parity', () => {
  const pushCall = {
    source: 'sandbox',
    call: { tool: 'sandbox_push', args: {} },
  } as unknown as AnyToolCall;

  afterEach(() => {
    vi.mocked(schedulePostPushCIStatus).mockClear();
  });

  it('schedules the CI follow-up on a successful direct push', async () => {
    await applyPostExecutionSideEffects(
      pushCall,
      { text: '[Tool Result — sandbox_push]\nPushed successfully.' },
      minimalSideEffectContext(vi.fn()),
    );

    expect(schedulePostPushCIStatus).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1', repo: 'owner/repo' }),
    );
  });

  it('does not schedule on a failed push', async () => {
    await applyPostExecutionSideEffects(
      pushCall,
      { text: '[Tool Result — sandbox_push]\nPush failed: rejected' },
      minimalSideEffectContext(vi.fn()),
    );

    expect(schedulePostPushCIStatus).not.toHaveBeenCalled();
  });

  it('does not schedule on a structured-error push result', async () => {
    await applyPostExecutionSideEffects(
      pushCall,
      {
        text: '[Tool Error — sandbox_push]\nblocked',
        structuredError: { type: 'GIT_GUARD_BLOCKED', retryable: false, message: 'blocked' },
      },
      minimalSideEffectContext(vi.fn()),
    );

    expect(schedulePostPushCIStatus).not.toHaveBeenCalled();
  });

  it('does not schedule when no repo is bound', async () => {
    const ctx = minimalSideEffectContext(vi.fn());
    (ctx as unknown as { repoRef: { current: string | null } }).repoRef.current = null;
    await applyPostExecutionSideEffects(
      pushCall,
      { text: '[Tool Result — sandbox_push]\nPushed successfully.' },
      ctx,
    );

    expect(schedulePostPushCIStatus).not.toHaveBeenCalled();
  });

  it('does not schedule for non-push tools', async () => {
    await applyPostExecutionSideEffects(
      {
        source: 'sandbox',
        call: { tool: 'sandbox_exec', args: { command: 'echo Pushed successfully.' } },
      } as unknown as AnyToolCall,
      { text: 'Pushed successfully.' },
      minimalSideEffectContext(vi.fn()),
    );

    expect(schedulePostPushCIStatus).not.toHaveBeenCalled();
  });
});
