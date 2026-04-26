/**
 * Sequential Explorer delegation handler — Phase 2 of the useAgentDelegation
 * extraction track (see `docs/decisions/useAgentDelegation Coupling Recon.md`,
 * §"Recommended Extraction Order — Phase 2"). Mirrors the *HandlerContext
 * pattern proven five times over on `lib/sandbox-tools.ts`: the dispatcher
 * (hook) constructs a context object carrying the refs and bound callbacks the
 * handler needs, and this module owns the full execution path — span setup,
 * agent invocation, outcome assembly, memory persistence, verification-state
 * artifact recording, and event emission.
 *
 * ## Fitness rules
 *
 *   - **Boundary:** imports from `@/lib/*`, `@/hooks/chat-persistence`,
 *     `@push/lib/correlation-context`, and type-only from `@/lib/tool-dispatch`
 *     / `@/lib/orchestrator` / `@/lib/run-engine`. Never imports
 *     `useAgentDelegation.ts` or any other hook.
 *   - **API:** exports the `ExplorerHandlerContext` type and the
 *     `handleExplorerDelegation` async handler only. The build-context helper
 *     lives in the dispatcher (hook) so the one-way extraction boundary holds.
 *   - **Behavior preservation:** byte-for-byte equivalent to the inline seam
 *     (lines 177–371 pre-extraction). The existing tests in
 *     `hooks/useAgentDelegation.test.ts` gate the regression.
 */

import type React from 'react';
import { runExplorerAgent } from '@/lib/explorer-agent';
import {
  buildMemoryScope,
  retrieveMemoryKnownContextLine,
  runContextMemoryBestEffort,
  withMemoryContext,
} from '@/lib/memory-context-helpers';
import { writeExplorerMemory } from '@/lib/context-memory';
import {
  buildDelegationResultCard,
  formatCompactDelegationToolResult,
} from '@/lib/delegation-result';
import { recordVerificationArtifact } from '@/lib/verification-runtime';
import { summarizeToolResultPreview } from '@/lib/chat-run-events';
import { setSpanAttributes, withActiveSpan, SpanKind, SpanStatusCode } from '@/lib/tracing';
import {
  correlationToSpanAttributes,
  extendCorrelation,
  type CorrelationContext,
} from '@push/lib/correlation-context';
import { createId } from '@/hooks/chat-persistence';
import type { ActiveProvider } from '@/lib/orchestrator';
import type { AnyToolCall } from '@/lib/tool-dispatch';
import type { RunEngineEvent } from '@/lib/run-engine';
import type {
  AgentStatus,
  AgentStatusSource,
  ChatCard,
  DelegationOutcome,
  RunEventInput,
  ToolExecutionResult,
  VerificationRuntimeState,
} from '@/types';

// ---------------------------------------------------------------------------
// Handler context
// ---------------------------------------------------------------------------

/** Narrow tool-call shape for `delegate_explorer` dispatch. */
export type ExplorerToolCall = Extract<AnyToolCall, { call: { tool: 'delegate_explorer' } }>;

/**
 * The ambient context passed to {@link handleExplorerDelegation}. All
 * refs/callbacks the handler reaches for are enumerated here so the seam
 * has zero implicit reach into the hook's closure. Callbacks are already
 * bound (e.g. `appendInlineDelegationCards` takes `(chatId, cards)` — the
 * hook binds `setConversations` locally).
 */
export interface ExplorerHandlerContext {
  // Refs — read-only across the handler's lifetime.
  sandboxIdRef: React.MutableRefObject<string | null>;
  repoRef: React.MutableRefObject<string | null>;
  branchInfoRef: React.RefObject<
    { currentBranch?: string; defaultBranch?: string } | undefined | null
  >;
  isMainProtectedRef: React.MutableRefObject<boolean>;
  agentsMdRef: React.MutableRefObject<string | null>;
  instructionFilenameRef: React.MutableRefObject<string | null>;
  abortControllerRef: React.MutableRefObject<AbortController | null>;
  abortRef: React.MutableRefObject<boolean>;

  // Callbacks — bound in the hook's buildExplorerContext helper.
  emitRunEngineEvent: (event: RunEngineEvent) => void;
  appendRunEvent: (chatId: string, event: RunEventInput) => void;
  updateAgentStatus: (
    status: AgentStatus,
    meta?: { chatId?: string; source?: AgentStatusSource; log?: boolean },
  ) => void;
  appendInlineDelegationCards: (chatId: string, cards: readonly ChatCard[]) => void;
  updateVerificationStateForChat: (
    chatId: string,
    updater: (state: VerificationRuntimeState) => VerificationRuntimeState,
  ) => void;
}

/** Per-invocation input carried alongside the ambient context. */
export interface HandleExplorerDelegationInput {
  chatId: string;
  toolCall: ExplorerToolCall;
  baseCorrelation: CorrelationContext;
  lockedProviderForChat: ActiveProvider;
  resolvedModelForChat: string | undefined;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleExplorerDelegation(
  ctx: ExplorerHandlerContext,
  input: HandleExplorerDelegationInput,
): Promise<ToolExecutionResult> {
  const { chatId, toolCall, baseCorrelation, lockedProviderForChat, resolvedModelForChat } = input;
  const executionId = createId();
  // Capture the foreground branch at dispatch — see R11 in the slice 2
  // design doc. Bound to this delegation's result for its lifetime.
  const originBranch = ctx.branchInfoRef.current?.currentBranch;
  ctx.emitRunEngineEvent({
    type: 'DELEGATION_STARTED',
    timestamp: Date.now(),
    agent: 'explorer',
  });
  const explorerTask = toolCall.call.args.task?.trim();
  const explorerArgs = toolCall.call.args;
  const explorerStartMs = Date.now();
  if (!explorerTask) {
    return {
      text: '[Tool Error] delegate_explorer requires a non-empty "task" string.',
      originBranch,
    };
  }
  ctx.appendRunEvent(chatId, {
    type: 'subagent.started',
    executionId,
    agent: 'explorer',
    detail: explorerTask,
  });
  const explorerMemoryScope = buildMemoryScope(
    chatId,
    ctx.repoRef.current,
    ctx.branchInfoRef.current?.currentBranch,
  );
  const explorerMemoryLine = await retrieveMemoryKnownContextLine(
    explorerMemoryScope,
    'explorer',
    explorerTask,
    explorerArgs.files,
  );
  try {
    const explorerCorrelation = extendCorrelation(baseCorrelation, { executionId });
    const explorerResult = await withActiveSpan(
      'subagent.explorer',
      {
        scope: 'push.delegation',
        kind: SpanKind.INTERNAL,
        attributes: {
          ...correlationToSpanAttributes(explorerCorrelation),
          'push.agent.role': 'explorer',
          'push.task_count': 1,
          'push.provider': lockedProviderForChat,
          'push.model': resolvedModelForChat,
          'push.has_sandbox': Boolean(ctx.sandboxIdRef.current),
          'push.has_repo': Boolean(ctx.repoRef.current),
        },
      },
      async (span) => {
        const result = await runExplorerAgent(
          {
            task: explorerTask,
            files: explorerArgs.files || [],
            intent: explorerArgs.intent,
            deliverable: explorerArgs.deliverable,
            knownContext: withMemoryContext(explorerArgs.knownContext, explorerMemoryLine),
            constraints: explorerArgs.constraints,
            branchContext: ctx.branchInfoRef.current?.currentBranch
              ? {
                  activeBranch: ctx.branchInfoRef.current.currentBranch,
                  defaultBranch: ctx.branchInfoRef.current.defaultBranch || 'main',
                  protectMain: ctx.isMainProtectedRef.current,
                }
              : undefined,
            provider: lockedProviderForChat,
            model: resolvedModelForChat || undefined,
            projectInstructions: ctx.agentsMdRef.current || undefined,
            instructionFilename: ctx.instructionFilenameRef.current || undefined,
          },
          ctx.sandboxIdRef.current,
          ctx.repoRef.current || '',
          {
            onStatus: (phase, detail) => {
              ctx.updateAgentStatus(
                { active: true, phase, detail },
                { chatId, source: 'explorer' },
              );
            },
            signal: ctx.abortControllerRef.current?.signal,
          },
        );
        setSpanAttributes(span, {
          'push.round_count': result.rounds,
          'push.card_count': result.cards.length,
        });
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      },
    );

    ctx.appendInlineDelegationCards(chatId, explorerResult.cards);

    const explorerOutcome: DelegationOutcome = {
      agent: 'explorer',
      status:
        explorerResult.rounds > 0 && explorerResult.summary.trim() ? 'complete' : 'inconclusive',
      summary: explorerResult.summary,
      evidence: explorerResult.summary.trim()
        ? [{ kind: 'observation', label: 'Investigation findings' }]
        : [],
      checks: [],
      gateVerdicts: [],
      missingRequirements: [],
      nextRequiredAction: null,
      rounds: explorerResult.rounds,
      checkpoints: 0,
      elapsedMs: Date.now() - explorerStartMs,
    };

    const toolExecResult: ToolExecutionResult = {
      text: formatCompactDelegationToolResult({
        agent: 'explorer',
        outcome: explorerOutcome,
      }),
      card: buildDelegationResultCard({
        agent: 'explorer',
        outcome: explorerOutcome,
      }),
      delegationOutcome: explorerOutcome,
      originBranch,
    };

    if (explorerMemoryScope && explorerOutcome.status === 'complete') {
      await runContextMemoryBestEffort('persisting explorer memory', () =>
        writeExplorerMemory({
          scope: explorerMemoryScope,
          summary: explorerResult.summary,
          relatedFiles: explorerArgs.files,
          rounds: explorerResult.rounds,
        }),
      );
    }

    ctx.updateVerificationStateForChat(chatId, (state) =>
      recordVerificationArtifact(
        state,
        `Explorer produced evidence: ${summarizeToolResultPreview(explorerResult.summary)}`,
      ),
    );
    ctx.appendRunEvent(chatId, {
      type: 'subagent.completed',
      executionId,
      agent: 'explorer',
      summary: summarizeToolResultPreview(explorerResult.summary),
      delegationOutcome: explorerOutcome,
    });
    return toolExecResult;
  } catch (err) {
    const isAbort = err instanceof DOMException && err.name === 'AbortError';
    if (isAbort || ctx.abortRef.current) {
      const abortOutcome: DelegationOutcome = {
        agent: 'explorer',
        status: 'inconclusive',
        summary: 'Explorer cancelled by user.',
        evidence: [],
        checks: [],
        gateVerdicts: [],
        missingRequirements: [],
        nextRequiredAction: null,
        rounds: 0,
        checkpoints: 0,
        elapsedMs: Date.now() - explorerStartMs,
      };
      ctx.appendRunEvent(chatId, {
        type: 'subagent.completed',
        executionId,
        agent: 'explorer',
        summary: 'Cancelled by user.',
        delegationOutcome: abortOutcome,
      });
      return {
        text: formatCompactDelegationToolResult({
          agent: 'explorer',
          outcome: abortOutcome,
        }),
        card: buildDelegationResultCard({
          agent: 'explorer',
          outcome: abortOutcome,
        }),
        delegationOutcome: abortOutcome,
        originBranch,
      };
    }
    const msg = err instanceof Error ? err.message : String(err);
    ctx.appendRunEvent(chatId, {
      type: 'subagent.failed',
      executionId,
      agent: 'explorer',
      error: summarizeToolResultPreview(msg),
    });
    return { text: `[Tool Error] Explorer failed: ${msg}`, originBranch };
  }
}
