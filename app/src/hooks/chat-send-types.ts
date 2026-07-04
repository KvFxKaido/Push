/**
 * chat-send-types.ts
 *
 * Shared interfaces for the chat-send module set. Lifted out of chat-send.ts
 * so chat-send-helpers.ts and chat-stream-round.ts can depend on the type
 * shapes without circular-importing the dispatcher.
 */

import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { ActiveProvider } from '@/lib/orchestrator';
import type { AnyToolCall } from '@/lib/tool-dispatch';
import type { NativeToolCall } from '@push/lib/provider-contract';
import type { TodoItem } from '@/lib/todo-tools';
import type { RunEngineEvent } from '@/lib/run-engine';
import type { ToolCallRecoveryState } from '@/lib/tool-call-recovery';
import type { ToolDispatchBinding } from '@/lib/local-daemon-sandbox-client';
import type { SandboxUnreachableRecoveryPolicy } from '@/lib/sandbox-recovery-policy';
import type { PushRuntimeContext } from '@push/lib/runtime-context';
import type {
  ActiveRepo,
  AgentStatus,
  AgentStatusSource,
  ChatMessage,
  Conversation,
  ReasoningBlock,
  RunEventInput,
  ToolExecutionResult,
  VerificationRuntimeState,
  WorkspaceContext,
} from '@/types';
import type { CheckpointRefs } from './useChatCheckpoint';

export interface ScratchpadHandlers {
  content: string;
  replace: (text: string) => void;
  append: (text: string) => void;
}

export interface TodoHandlers {
  todos: readonly TodoItem[];
  replace: (todos: TodoItem[]) => void;
  clear: () => void;
}

export interface ChatRuntimeHandlers {
  onSandboxPromoted?: (repo: ActiveRepo) => void;
  bindSandboxSessionToRepo?: (repoFullName: string, branch?: string) => void;
  /** Called when a sandbox tool switches branches internally. */
  onBranchSwitch?: (branch: string) => void;
  /** Called when sandbox_exec reports sandbox HEAD diverged from tracked branch. */
  onBranchDesync?: (event: {
    expected: string;
    actual: string;
    command: string;
    reconciled: boolean;
  }) => void;
  /** Called when a tool result indicates the sandbox is unreachable. */
  onSandboxUnreachable?: (reason: string, policy?: SandboxUnreachableRecoveryPolicy) => void;
}

// ---------------------------------------------------------------------------
// Shared run context — stays constant for the duration of one sendMessage call
// ---------------------------------------------------------------------------

export interface SendLoopContext {
  chatId: string;
  lockedProvider: ActiveProvider;
  resolvedModel: string | undefined;
  // Refs
  abortRef: MutableRefObject<boolean>;
  abortControllerRef: MutableRefObject<AbortController | null>;
  sandboxIdRef: MutableRefObject<string | null>;
  ensureSandboxRef: MutableRefObject<(() => Promise<string | null>) | null>;
  /**
   * Local-daemon binding for Remote workspace sessions. When active, this ref
   * carries the paired relay binding so sandbox tool calls route through
   * `pushd` via the Worker relay instead of a cloud sandbox.
   * `null` on cloud sessions; the sandbox dispatcher uses absence
   * to fall back to `execInSandbox`. The ref carries either a plain
   * params binding (legacy / pre-open transient path) or a
   * `LiveDaemonBinding` (hook-owned long-lived WS, preferred): the
   * dispatcher in `local-daemon-sandbox-client.ts#runWithBinding`
   * branches by shape.
   */
  localDaemonBindingRef: MutableRefObject<ToolDispatchBinding | null>;
  scratchpadRef: MutableRefObject<ScratchpadHandlers | undefined>;
  todoRef: MutableRefObject<TodoHandlers | undefined>;
  workspaceContextRef: MutableRefObject<WorkspaceContext | null>;
  runtimeHandlersRef: MutableRefObject<ChatRuntimeHandlers | undefined>;
  repoRef: MutableRefObject<string | null>;
  isMainProtectedRef: MutableRefObject<boolean>;
  branchInfoRef: MutableRefObject<{ currentBranch?: string; defaultBranch?: string } | undefined>;
  runtimeContext: PushRuntimeContext;
  checkpointRefs: CheckpointRefs;
  processedContentRef: MutableRefObject<Set<string>>;
  // For stale-capture avoidance: read activeChatId at branch-change time, not
  // at closure-capture time.
  activeChatIdRef: MutableRefObject<string | null>;
  // Used by applyBranchSwitchPayload to update the active conversation's
  // mutable branch state.
  conversationsRef: MutableRefObject<Record<string, Conversation>>;
  // State mutation
  setConversations: Dispatch<SetStateAction<Record<string, Conversation>>>;
  dirtyConversationIdsRef: MutableRefObject<Set<string>>;
  // Callbacks
  updateAgentStatus: (
    status: AgentStatus,
    options?: { chatId?: string; source?: AgentStatusSource; log?: boolean },
  ) => void;
  appendRunEvent: (chatId: string, event: RunEventInput) => void;
  emitRunEngineEvent: (event: RunEngineEvent) => void;
  /** Persist legacy + V1 checkpoints. `reason` annotates the V1 record:
   *  'turn' for steady-state in-run captures, 'interrupt' (default) for
   *  protective flushes like visibilitychange. */
  flushCheckpoint: (reason?: import('@push/lib/run-checkpoint').RunCheckpointReason) => void;
  getVerificationState: (chatId: string) => VerificationRuntimeState;
  updateVerificationState: (
    chatId: string,
    updater: (state: VerificationRuntimeState) => VerificationRuntimeState,
  ) => VerificationRuntimeState;
  executeDelegateCall: (
    chatId: string,
    toolCall: AnyToolCall,
    apiMessages: ChatMessage[],
    provider: ActiveProvider,
    resolvedModel?: string,
  ) => Promise<ToolExecutionResult>;
  /**
   * Fire-and-forget capture invoked at the end of every round by
   * {@link runRoundLoop}. The default loop-side wiring snapshots the
   * events emitted during the round and passes them via `roundEvents`
   * so the capture seam can decide whether to fire. Optional so
   * existing tests that build minimal contexts keep compiling.
   */
  captureWorkspacePatchAtRoundEnd?: (
    ctx: import('./useWorkspacePatchCapture').WorkspacePatchRoundContext,
  ) => Promise<void>;
}

export interface StreamRoundResult {
  accumulated: string;
  thinkingAccumulated: string;
  /** Structured signed-thinking blocks captured this round. Persisted on
   *  the assistant message so the next request can echo them back to the
   *  provider — required for Anthropic extended thinking + tool use to
   *  survive across turns. Empty array when the upstream emitted no
   *  signed reasoning. */
  reasoningBlocks: ReasoningBlock[];
  /** Complete provider-native tool/function calls captured this round. */
  nativeToolCalls: NativeToolCall[];
  error: Error | null;
}

export interface AssistantTurnResult {
  nextApiMessages: ChatMessage[];
  nextRecoveryState: ToolCallRecoveryState;
  /** What the sendMessage loop should do after this turn. */
  loopAction: 'break' | 'continue';
  loopCompletedNormally: boolean;
}
