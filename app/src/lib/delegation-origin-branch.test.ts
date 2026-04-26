/**
 * R11 data-contract tests — delegation `originBranch`.
 *
 * Slice 2 invariant: a delegated run is bound to the branch active at
 * launch. The launch branch is captured into the delegation envelope at
 * dispatch and propagated to the result message via `ToolExecutionResult.
 * originBranch`. The result message stamps `branch: originBranch`, NOT the
 * current foreground branch — even if the user/model has since forked away.
 *
 * These tests exercise the contract at three independent boundaries:
 *
 *   1. Dispatch capture: handler reads `branchInfoRef.current?.currentBranch`
 *      at entry and threads it into every `ToolExecutionResult` it returns.
 *   2. Propagation: the returned `ToolExecutionResult` carries `originBranch`
 *      verbatim, surviving foreground branch mutation between dispatch and
 *      result reading.
 *   3. Stamping: `buildToolResultMessage({ branch: originBranch })` produces
 *      a `ChatMessage` with `branch: originBranch`, locking the result to
 *      the launch branch at write time.
 *
 * See `docs/branch-context-preservation-slice-2-draft.md` (R11).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type React from 'react';
import { buildToolMeta, buildToolResultMessage } from './chat-tool-messages';
import {
  handleExplorerDelegation,
  type ExplorerHandlerContext,
  type ExplorerToolCall,
} from './explorer-delegation-handler';
import {
  handleTaskGraphDelegation,
  type TaskGraphHandlerContext,
  type TaskGraphToolCall,
} from './task-graph-delegation-handler';

// Mock the orchestrator/sandbox seams so the early-exit handler paths don't
// pull in real network/sandbox machinery.
vi.mock('./orchestrator', () => ({
  estimateContextTokens: vi.fn(),
  getContextBudget: vi.fn(),
}));

vi.mock('./file-awareness-ledger', () => ({
  fileLedger: {
    getDirtyFilesWithProvenance: () => [],
  },
}));

vi.mock('./sandbox-client', () => ({
  getSandboxEnvironment: () => null,
}));

interface MutableBranchRef {
  current: { currentBranch?: string; defaultBranch?: string } | null;
}

function makeBranchRef(currentBranch: string | undefined): MutableBranchRef {
  return { current: { currentBranch, defaultBranch: 'main' } };
}

function makeMutableRef<T>(value: T): React.MutableRefObject<T> {
  return { current: value } as React.MutableRefObject<T>;
}

function makeExplorerContext(
  branchRef: MutableBranchRef,
  overrides: Partial<ExplorerHandlerContext> = {},
): ExplorerHandlerContext {
  return {
    sandboxIdRef: makeMutableRef<string | null>('sandbox-1'),
    repoRef: makeMutableRef<string | null>('owner/repo'),
    branchInfoRef: branchRef as ExplorerHandlerContext['branchInfoRef'],
    isMainProtectedRef: makeMutableRef(false),
    agentsMdRef: makeMutableRef<string | null>(null),
    instructionFilenameRef: makeMutableRef<string | null>(null),
    abortControllerRef: makeMutableRef<AbortController | null>(null),
    abortRef: makeMutableRef(false),
    emitRunEngineEvent: vi.fn(),
    appendRunEvent: vi.fn(),
    updateAgentStatus: vi.fn(),
    appendInlineDelegationCards: vi.fn(),
    updateVerificationStateForChat: vi.fn(),
    ...overrides,
  };
}

function makeTaskGraphContext(
  branchRef: MutableBranchRef,
  overrides: Partial<TaskGraphHandlerContext> = {},
): TaskGraphHandlerContext {
  return {
    sandboxIdRef: makeMutableRef<string | null>('sandbox-1'),
    repoRef: makeMutableRef<string | null>('owner/repo'),
    branchInfoRef: branchRef as TaskGraphHandlerContext['branchInfoRef'],
    isMainProtectedRef: makeMutableRef(false),
    agentsMdRef: makeMutableRef<string | null>(null),
    instructionFilenameRef: makeMutableRef<string | null>(null),
    abortControllerRef: makeMutableRef<AbortController | null>(null),
    abortRef: makeMutableRef(false),
    emitRunEngineEvent: vi.fn(),
    appendRunEvent: vi.fn(),
    updateAgentStatus: vi.fn(),
    updateVerificationStateForChat: vi.fn(),
    appendInlineDelegationCards: vi.fn(),
    resetCoderState: vi.fn(),
    onCoderStateUpdate: vi.fn(),
    readLatestCoderState: () => null,
    ...overrides,
  };
}

function makeEmptyExplorerCall(): ExplorerToolCall {
  return {
    source: 'delegate',
    call: { tool: 'delegate_explorer', args: { task: '' } },
  } as unknown as ExplorerToolCall;
}

function makeInvalidTaskGraphCall(): TaskGraphToolCall {
  // Empty task list trips the validator's "at least one task" rule, so the
  // handler exits before any agent runs.
  return {
    source: 'delegate',
    call: { tool: 'plan_tasks', args: { tasks: [] } },
  } as unknown as TaskGraphToolCall;
}

describe('R11 delegation originBranch contract', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('explorer handler', () => {
    it('captures originBranch from branchInfoRef at dispatch and stamps it on early-exit result', async () => {
      const branchRef = makeBranchRef('main');
      const ctx = makeExplorerContext(branchRef);

      const result = await handleExplorerDelegation(ctx, {
        chatId: 'chat-1',
        toolCall: makeEmptyExplorerCall(),
        baseCorrelation: { surface: 'web', chatId: 'chat-1' },
        lockedProviderForChat: 'openrouter',
        resolvedModelForChat: undefined,
      });

      expect(result.originBranch).toBe('main');
    });

    it('binds originBranch to the launch branch even after foreground forks away', async () => {
      // Capture branch at dispatch...
      const branchRef = makeBranchRef('main');
      const ctx = makeExplorerContext(branchRef);
      const dispatchPromise = handleExplorerDelegation(ctx, {
        chatId: 'chat-1',
        toolCall: makeEmptyExplorerCall(),
        baseCorrelation: { surface: 'web', chatId: 'chat-1' },
        lockedProviderForChat: 'openrouter',
        resolvedModelForChat: undefined,
      });

      // ...then the foreground forks to feature/foo before the result is read.
      branchRef.current = { currentBranch: 'feature/foo', defaultBranch: 'main' };

      const result = await dispatchPromise;
      // The handler's snapshot is what the contract guarantees. The early-exit
      // path is synchronous-ish, but the contract is structural: the result
      // carries the captured branch, not the current ref value.
      expect(result.originBranch).toBe('main');
    });

    it('leaves originBranch undefined when no branch is active at dispatch', async () => {
      const branchRef: MutableBranchRef = { current: null };
      const ctx = makeExplorerContext(branchRef);

      const result = await handleExplorerDelegation(ctx, {
        chatId: 'chat-1',
        toolCall: makeEmptyExplorerCall(),
        baseCorrelation: { surface: 'web', chatId: 'chat-1' },
        lockedProviderForChat: 'openrouter',
        resolvedModelForChat: undefined,
      });

      // Undefined is the correct fallback signal — buildToolResultMessage
      // skips stamping, and effectiveMessageBranch defaults to conv.branch.
      expect(result.originBranch).toBeUndefined();
    });
  });

  describe('task-graph handler', () => {
    it('captures originBranch and stamps it on validation-error early exit', async () => {
      const branchRef = makeBranchRef('main');
      const ctx = makeTaskGraphContext(branchRef);

      const result = await handleTaskGraphDelegation(ctx, {
        chatId: 'chat-1',
        toolCall: makeInvalidTaskGraphCall(),
        baseCorrelation: { surface: 'web', chatId: 'chat-1' },
        lockedProviderForChat: 'openrouter',
        resolvedModelForChat: undefined,
        verificationPolicy: { name: 'Test', rules: [] },
      });

      expect(result.originBranch).toBe('main');
    });
  });

  describe('end-to-end stamping (handler result -> ChatMessage)', () => {
    it('stamps the message with the launch branch even when foreground has since forked', async () => {
      // 1. Dispatch on main.
      const branchRef = makeBranchRef('main');
      const ctx = makeExplorerContext(branchRef);
      const result = await handleExplorerDelegation(ctx, {
        chatId: 'chat-1',
        toolCall: makeEmptyExplorerCall(),
        baseCorrelation: { surface: 'web', chatId: 'chat-1' },
        lockedProviderForChat: 'openrouter',
        resolvedModelForChat: undefined,
      });

      // 2. Foreground forks to feature/foo before the result is rendered.
      branchRef.current = { currentBranch: 'feature/foo', defaultBranch: 'main' };

      // 3. The integration site (chat-tool-execution.ts buildToolOutcome)
      //    forwards `result.originBranch` into `buildToolResultMessage`. The
      //    resulting message stamps with the launch branch, NOT the current
      //    foreground branch.
      const message = buildToolResultMessage({
        id: 'msg-1',
        timestamp: 1,
        text: result.text,
        toolMeta: buildToolMeta({
          toolName: 'delegate_explorer',
          source: 'delegate',
          provider: 'openrouter',
          durationMs: 0,
          isError: true,
        }),
        branch: result.originBranch,
      });

      expect(message.branch).toBe('main');
      // And distinctly NOT the current foreground branch — the whole point
      // of the contract.
      expect(message.branch).not.toBe('feature/foo');
    });
  });
});
