import { useEffect, useMemo, useState } from 'react';
import { RotateCcw, X } from 'lucide-react';
import type {
  ChatMessage,
  AgentStatus,
  ActiveRepo,
  CardAction,
  RunCheckpoint,
  LoopPhase,
  CIStatus,
  QuickPrompt,
} from '@/types';
import { groupChatMessages } from './tool-call-utils';
import { CIStatusBanner } from './CIStatusBanner';
import { TranscriptList } from './transcript/TranscriptList';
import type { TranscriptHandlers } from './transcript/segment-model';
import { getEmptyStateQuickPrompts } from '@/lib/quick-prompts';
import { PushMarkIcon } from '@/components/icons/push-custom-icons';
import { getRoleDisplay } from '@push/lib/role-display';
import {
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_TOP_BANNER_STRIP_CLASS,
} from '@/components/chat/hub-styles';

// --- Resume Banner (Resumable Sessions Phase 2) ---

function phaseLabel(phase: LoopPhase): string {
  switch (phase) {
    case 'streaming_llm':
      return 'mid-response';
    case 'executing_tools':
      return 'mid-tool-execution';
    case 'delegating_coder':
      return `during the ${getRoleDisplay('coder').phase} phase`;
    case 'delegating_explorer':
      return `during the ${getRoleDisplay('explorer').phase} phase`;
    case 'executing_task_graph':
      return 'during task graph execution';
  }
}

function formatCheckpointAge(savedAt: number): string {
  const ageMs = Date.now() - savedAt;
  const ageMin = Math.floor(ageMs / 60_000);
  return ageMin < 1 ? 'just now' : `${ageMin}m ago`;
}

function ResumeBanner({
  checkpoint,
  onResume,
  onDismiss,
}: {
  checkpoint: RunCheckpoint;
  onResume: () => void;
  onDismiss: () => void;
}) {
  const [ageLabel, setAgeLabel] = useState('just now');

  useEffect(() => {
    // Use setInterval for both initial and periodic updates — avoids synchronous
    // setState in effect body which trips the react-hooks/set-state-in-effect rule.
    const timer = setInterval(() => setAgeLabel(formatCheckpointAge(checkpoint.savedAt)), 30_000);
    // Fire the first update asynchronously via setTimeout(0)
    const initial = setTimeout(() => setAgeLabel(formatCheckpointAge(checkpoint.savedAt)), 0);
    return () => {
      clearInterval(timer);
      clearTimeout(initial);
    };
  }, [checkpoint.savedAt]);

  return (
    <div
      className={`mx-4 mt-5 mb-1 flex items-center justify-between gap-3 px-1 py-2.5 ${HUB_TOP_BANNER_STRIP_CLASS} border-amber-500/25`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-amber-200">
          Session interrupted {phaseLabel(checkpoint.phase)}
        </p>
        <p className="text-push-xs text-amber-200/60 mt-0.5">
          Round {checkpoint.round + 1} &middot; {ageLabel}
          {checkpoint.coderDelegationActive ? ' &middot; Coder was active' : ''}
        </p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={onResume}
          className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} gap-1.5 px-3 text-amber-200`}
        >
          <RotateCcw className="h-3 w-3" />
          <span>Resume</span>
        </button>
        <button
          onClick={onDismiss}
          className="flex h-7 w-7 items-center justify-center rounded-full text-amber-200/40 transition-colors hover:bg-amber-900/20 hover:text-amber-200/70 active:scale-95"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

interface ChatContainerProps {
  messages: ChatMessage[];
  agentStatus: AgentStatus;
  activeRepo?: ActiveRepo | null;
  hasSandbox?: boolean;
  isChat?: boolean;
  onSuggestion?: (prompt: QuickPrompt) => void;
  onCardAction?: (action: CardAction) => void;
  onPin?: (content: string, messageId: string) => void;
  interruptedCheckpoint?: RunCheckpoint | null;
  onResumeRun?: () => void;
  onDismissResume?: () => void;
  ciStatus?: CIStatus | null;
  onDiagnoseCI?: () => void;
  onEditUserMessage?: (messageId: string) => void;
  onRegenerateLastResponse?: () => void;
}

function EmptyState({
  activeRepo,
  hasSandbox,
  isChat,
  onSuggestion,
}: {
  activeRepo?: ActiveRepo | null;
  hasSandbox?: boolean;
  isChat?: boolean;
  onSuggestion?: (prompt: QuickPrompt) => void;
}) {
  const [hexTap, setHexTap] = useState(false);

  const handleHexTap = () => {
    setHexTap(false);
    // Force reflow so re-adding the class restarts the animation
    requestAnimationFrame(() => setHexTap(true));
  };

  const suggestions = useMemo(
    () => (isChat ? [] : getEmptyStateQuickPrompts(activeRepo, hasSandbox)),
    [activeRepo, hasSandbox, isChat],
  );

  return (
    <div className="flex flex-1 items-center justify-center px-8">
      <div className="text-center max-w-sm">
        {!isChat && (
          <>
            <button
              type="button"
              onClick={handleHexTap}
              className="mx-auto mb-5 flex h-12 w-12 cursor-pointer items-center justify-center rounded-xl border border-push-edge bg-push-grad-icon shadow-[0_12px_30px_rgba(0,0,0,0.55)] active:scale-95 transition-transform"
            >
              <PushMarkIcon
                className={`text-push-accent transition-colors ${hexTap ? 'hex-tap' : ''}`}
                pathClassName={`transition-all duration-300 ${hexTap ? 'fill-push-accent/20' : 'fill-transparent'}`}
                height={22}
                onAnimationEnd={() => setHexTap(false)}
                width={22}
              />
            </button>
            <h2 className="mb-2.5 text-push-2xl font-display font-semibold text-push-fg">
              {activeRepo ? activeRepo.name : hasSandbox ? 'Workspace' : 'Push'}
            </h2>
          </>
        )}
        {isChat && (
          <h2 className="mb-3 text-push-2xl font-display font-semibold text-push-fg">
            Start a conversation
          </h2>
        )}
        <p className="text-sm leading-relaxed text-push-fg-secondary">
          {isChat
            ? 'Think through ideas, ask questions, or plan your next move.'
            : activeRepo
              ? `Focused on ${activeRepo.full_name}. Ask about PRs, recent changes, or the codebase.`
              : hasSandbox
                ? 'Ephemeral workspace — write code, run commands, and prototype ideas from scratch.'
                : 'AI coding agent with direct repo access. Review PRs, explore codebases, and ship changes — all from here.'}
        </p>
        {suggestions.length > 0 && (
          <div className="mt-6 flex flex-col gap-2.5 stagger-in">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion.label}
                onClick={() => onSuggestion?.(suggestion)}
                className="cursor-pointer rounded-xl border border-push-edge bg-push-grad-card px-4 py-3 text-left text-sm text-push-fg-secondary shadow-push-card card-hover spring-press hover:border-push-edge-hover hover:text-push-fg hover:shadow-push-card-hover"
              >
                {suggestion.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ChatContainer({
  messages,
  agentStatus,
  activeRepo,
  hasSandbox,
  isChat,
  onSuggestion,
  onCardAction,
  onPin,
  interruptedCheckpoint,
  onResumeRun,
  onDismissResume,
  ciStatus,
  onDiagnoseCI,
  onEditUserMessage,
  onRegenerateLastResponse,
}: ChatContainerProps) {
  // Split messages into settled (all but the active streaming tail) and active.
  // The settled set is grouped once and memoized so streaming chunks — which
  // only mutate the tail — don't re-group or re-render the settled segments.
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const isLastStreaming = lastMessage?.status === 'streaming';
  const settledMessages = useMemo(
    () => (isLastStreaming ? messages.slice(0, -1) : messages),
    [isLastStreaming, messages],
  );
  const activeMessage = isLastStreaming ? lastMessage : null;
  // The streaming loop clones `messages` every token, so this regroups
  // mid-stream — but grouping is a cheap O(n) pass. The expensive part (settled
  // MessageBubble re-renders: markdown, syntax highlighting, mermaid) is
  // prevented by SegmentView's content-based memo, which compares the underlying
  // message refs that stay stable while only the tail changes.
  const segments = useMemo(() => groupChatMessages(settledMessages), [settledMessages]);

  const regeneratableAssistantMessageId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index];
      if (message.role !== 'assistant') continue;
      if (message.status === 'streaming' || message.status === 'error') continue;
      if (message.isToolCall || message.isMalformed) continue;
      return message.id;
    }
    return null;
  }, [messages]);

  // One memoized handler bundle for both transcript paths — its stable identity
  // is what lets settled segments skip re-rendering while the tail streams.
  const handlers = useMemo<TranscriptHandlers>(
    () => ({
      onCardAction,
      onPin,
      onEditUserMessage,
      regeneratableAssistantMessageId,
      onRegenerateLastResponse,
    }),
    [
      onCardAction,
      onPin,
      onEditUserMessage,
      regeneratableAssistantMessageId,
      onRegenerateLastResponse,
    ],
  );

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        {interruptedCheckpoint && onResumeRun && onDismissResume && (
          <ResumeBanner
            checkpoint={interruptedCheckpoint}
            onResume={onResumeRun}
            onDismiss={onDismissResume}
          />
        )}
        {ciStatus && onDiagnoseCI && <CIStatusBanner status={ciStatus} onDiagnose={onDiagnoseCI} />}

        <EmptyState
          activeRepo={activeRepo}
          hasSandbox={hasSandbox}
          isChat={isChat}
          onSuggestion={onSuggestion}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {interruptedCheckpoint && onResumeRun && onDismissResume && (
        <ResumeBanner
          checkpoint={interruptedCheckpoint}
          onResume={onResumeRun}
          onDismiss={onDismissResume}
        />
      )}
      {ciStatus && onDiagnoseCI && <CIStatusBanner status={ciStatus} onDiagnose={onDiagnoseCI} />}

      <TranscriptList
        segments={segments}
        activeMessage={activeMessage}
        agentStatus={agentStatus}
        handlers={handlers}
        lastMessage={lastMessage}
      />
    </div>
  );
}
