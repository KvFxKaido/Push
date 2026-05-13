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
import type { TodoItem } from '@/lib/todo-tools';
import type { MigrationGuard } from '@/lib/chat-message';
import type { RunEngineEvent } from '@/lib/run-engine';
import type { ToolCallRecoveryState } from '@/lib/tool-call-recovery';
import type {
  ActiveRepo,
  AgentStatus,
  AgentStatusSource,
  ChatMessage,
  Conversation,
  CoderWorkingMemory,
  LocalPcBinding,
  RelayBinding,
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

export interface UsageHandler {
  trackUsage: (model: string, inputTokens: number, outputTokens: number) => void;
}

export interface ChatRuntimeHandlers {
  onSandboxPromoted?: (repo: ActiveRepo) => void;
  bindSandboxSessionToRepo?: (repoFullName: string, branch?: string) => void;
  /** Called when a sandbox tool switches branches internally. */
  onBranchSwitch?: (branch: string) => void;
  /** Called when a tool result indicates the sandbox is unreachable. */
  onSandboxUnreachable?: (reason: string) => void;
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
   * Local-daemon binding for `kind: 'local-pc'` OR `kind: 'relay'`
   * workspace sessions (Phase 1.d / Phase 2.f). When the active
   * session is one of those kinds, this ref carries the paired
   * binding (loopback port+token, or relay deploymentUrl+sessionId+
   * attach token) so sandbox tool calls route through `pushd`
   * (directly or via the Worker relay) instead of a cloud sandbox.
   * `null` on cloud sessions; the sandbox dispatcher uses absence
   * to fall back to `execInSandbox`. Downstream helpers in
   * `local-daemon-sandbox-client.ts` pick the WS adapter constructor
   * by binding shape.
   */
  localDaemonBindingRef: MutableRefObject<LocalPcBinding | RelayBinding | null>;
  scratchpadRef: MutableRefObject<ScratchpadHandlers | undefined>;
  todoRef: MutableRefObject<TodoHandlers | undefined>;
  usageHandlerRef: MutableRefObject<UsageHandler | undefined>;
  workspaceContextRef: MutableRefObject<WorkspaceContext | null>;
  runtimeHandlersRef: MutableRefObject<ChatRuntimeHandlers | undefined>;
  repoRef: MutableRefObject<string | null>;
  isMainProtectedRef: MutableRefObject<boolean>;
  branchInfoRef: MutableRefObject<{ currentBranch?: string; defaultBranch?: string } | undefined>;
  checkpointRefs: CheckpointRefs;
  processedContentRef: MutableRefObject<Set<string>>;
  lastCoderStateRef: MutableRefObject<CoderWorkingMemory | null>;
  // Slice 2 conversation-fork migration. Set by chat-send when a 'forked'
  // branchSwitch arrives; cleared by useChat's state-observed effect once the
  // migration is observable. While set, useChat's auto-switch effect early-
  // returns to suppress both auto-create AND chat-id-steal.
  skipAutoCreateRef: MutableRefObject<MigrationGuard | null>;
  // For stale-capture avoidance: read activeChatId at migration time, not at
  // closure-capture time, so a chat switch between dispatch and resolution
  // doesn't migrate the wrong conversation.
  activeChatIdRef: MutableRefObject<string | null>;
  // Used by applyBranchSwitchPayload to verify the target conversation
  // exists BEFORE setting guards — see Codex P1 review feedback.
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
  flushCheckpoint: () => void;
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
  error: Error | null;
}

export interface AssistantTurnResult {
  nextApiMessages: ChatMessage[];
  nextRecoveryState: ToolCallRecoveryState;
  /** What the sendMessage loop should do after this turn. */
  loopAction: 'break' | 'continue';
  loopCompletedNormally: boolean;
}
