import { useRef, useEffect, useMemo, useState, useCallback, memo } from 'react';
import { ArrowDown, RotateCcw, X } from 'lucide-react';
import type { ChatMessage, AgentStatus, ActiveRepo, CardAction, RunCheckpoint, LoopPhase, CIStatus, QuickPrompt } from '@/types';
import { MessageBubble } from './MessageBubble';
import { AgentStatusBar } from './AgentStatusBar';
import { CIStatusBanner } from './CIStatusBanner';
import { getEmptyStateQuickPrompts } from '@/lib/quick-prompts';
import { PushMarkIcon } from '@/components/icons/push-custom-icons';
import {
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_TOP_BANNER_STRIP_CLASS,
  HubControlGlow,
} from '@/components/chat/hub-styles';


// --- Resume Banner (Resumable Sessions Phase 2) ---

function phaseLabel(phase: LoopPhase): string {
  switch (phase) {
    case 'streaming_llm': return 'mid-response';
    case 'executing_tools': return 'mid-tool-execution';
    case 'delegating_coder': return 'during Coder delegation';
    case 'delegating_explorer': return 'during Explorer delegation';
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
    return () => { clearInterval(timer); clearTimeout(initial); };
  }, [checkpoint.savedAt]);

  return (
    <div
      className={`mx-4 mt-5 mb-1 flex items-center justify-between gap-3 px-1 py-2.5 ${HUB_TOP_BANNER_STRIP_CLASS} border-amber-500/25`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-amber-200">Session interrupted {phaseLabel(checkpoint.phase)}</p>
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
          <HubControlGlow />
          <RotateCcw className="relative z-10 h-3 w-3" />
          <span className="relative z-10">Resume</span>
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

/**
 * Memoized list of "settled" messages (all messages except the last one when
 * it is actively streaming). This avoids re-running the map/callback
 * computation for every streaming chunk when only the final message changes.
 */
const SettledMessageList = memo(function SettledMessageList({
  messages,
  onCardAction,
  onPin,
  onEditUserMessage,
  regeneratableAssistantMessageId,
  onRegenerateLastResponse,
}: {
  messages: ChatMessage[];
  onCardAction?: (action: CardAction) => void;
  onPin?: (content: string, messageId: string) => void;
  onEditUserMessage?: (messageId: string) => void;
  regeneratableAssistantMessageId: string | null;
  onRegenerateLastResponse?: () => void;
}) {
  return (
    <>
      {messages.map((msg) => (
        <MessageBubble
          key={msg.id}
          message={msg}
          onCardAction={onCardAction}
          onPin={onPin}
          onEdit={msg.role === 'user' && !msg.isToolResult ? onEditUserMessage : undefined}
          canRegenerate={msg.id === regeneratableAssistantMessageId}
          onRegenerate={msg.id === regeneratableAssistantMessageId ? onRegenerateLastResponse : undefined}
        />
      ))}
    </>
  );
}, (prevProps, nextProps) => {
  if (prevProps.messages.length !== nextProps.messages.length) return false;
  if (prevProps.onCardAction !== nextProps.onCardAction) return false;
  if (prevProps.onPin !== nextProps.onPin) return false;
  if (prevProps.onEditUserMessage !== nextProps.onEditUserMessage) return false;
  if (prevProps.regeneratableAssistantMessageId !== nextProps.regeneratableAssistantMessageId) return false;
  if (prevProps.onRegenerateLastResponse !== nextProps.onRegenerateLastResponse) return false;

  for (let index = 0; index < prevProps.messages.length; index++) {
    if (prevProps.messages[index] !== nextProps.messages[index]) {
      return false;
    }
  }

  return true;
});

const AUTO_SCROLL_THRESHOLD_PX = 150;
const AT_BOTTOM_THRESHOLD_PX = 48;

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
              className="mx-auto mb-5 flex h-12 w-12 cursor-pointer items-center justify-center rounded-xl border border-[#1e2634] bg-push-grad-icon shadow-[0_12px_30px_rgba(0,0,0,0.55)] active:scale-95 transition-transform"
            >
              <PushMarkIcon
                className={`text-push-accent transition-colors ${hexTap ? 'hex-tap' : ''}`}
                pathClassName={`transition-all duration-300 ${hexTap ? 'fill-[#0070f3]/20' : 'fill-transparent'}`}
                height={22}
                onAnimationEnd={() => setHexTap(false)}
                width={22}
              />
            </button>
            <h2 className="mb-2.5 text-lg font-semibold text-[#fafafa]">
              {activeRepo ? activeRepo.name : hasSandbox ? 'Workspace' : 'Push'}
            </h2>
          </>
        )}
        {isChat && (
          <h2 className="mb-3 text-lg font-semibold text-[#fafafa]">
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
                className="cursor-pointer rounded-xl border border-push-edge bg-push-grad-card px-4 py-3 text-left text-sm text-push-fg-secondary shadow-push-card card-hover spring-press hover:border-push-edge-hover hover:text-[#f0f4ff] hover:shadow-push-card-hover"
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

  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const lastMessageRef = useRef<ChatMessage | null>(null);
  const lastMessageContent = messages.length > 0 ? messages[messages.length - 1]?.content : '';

  const updateBottomState = useCallback((container: HTMLDivElement) => {
    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    setIsAtBottom(distanceFromBottom <= AT_BOTTOM_THRESHOLD_PX);
  }, []);

  // Track scroll position and show/hide scroll button
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    updateBottomState(container);

    const handleScroll = () => {
      updateBottomState(container);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [updateBottomState]);

  // Auto-scroll to bottom when new messages arrive or content streams in.
  // State (isAtBottom) is managed by the scroll event handler above —
  // scrollIntoView triggers scroll events that feed into updateBottomState.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
    const previousLastMessage = lastMessageRef.current;

    // Check if this is a new message (not just content update)
    const isNewMessage = lastMessage &&
      (!previousLastMessage || lastMessage.id !== previousLastMessage.id);

    // Always scroll to bottom when user sends a new message
    if (isNewMessage && lastMessage.role === 'user') {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    } else {
      // For assistant messages (streaming), only scroll if user is near bottom
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      if (distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX) {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    }

    // Update ref to track the last message
    lastMessageRef.current = lastMessage;
  }, [messages, lastMessageContent]);

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    setIsAtBottom(true);
  };

  // Split messages into settled (all but the active streaming tail) and active.
  // SettledMessageList is memoized with a custom comparator, so streaming chunks
  // can create a fresh settled array without forcing re-renders when the
  // underlying settled message objects are unchanged.
  const lastMsg = messages.length > 0 ? messages[messages.length - 1] : null;
  const isLastStreaming = lastMsg?.status === 'streaming';
  const settledMessages = useMemo(
    () => (isLastStreaming ? messages.slice(0, -1) : messages),
    [isLastStreaming, messages],
  );
  const activeMessage = isLastStreaming ? lastMsg : null;

  const showScrollButton = !isAtBottom;
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

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        {interruptedCheckpoint && onResumeRun && onDismissResume && (
          <ResumeBanner checkpoint={interruptedCheckpoint} onResume={onResumeRun} onDismiss={onDismissResume} />
        )}
        {ciStatus && onDiagnoseCI && (
          <CIStatusBanner status={ciStatus} onDiagnose={onDiagnoseCI} />
        )}

        <EmptyState activeRepo={activeRepo} hasSandbox={hasSandbox} isChat={isChat} onSuggestion={onSuggestion} />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden relative">
      {interruptedCheckpoint && onResumeRun && onDismissResume && (
        <ResumeBanner checkpoint={interruptedCheckpoint} onResume={onResumeRun} onDismiss={onDismissResume} />
      )}
      {ciStatus && onDiagnoseCI && (
        <CIStatusBanner status={ciStatus} onDiagnose={onDiagnoseCI} />
      )}

      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto overscroll-contain"
      >
        <div className="flex-1" />
        <div className="py-4 space-y-1.5">
          {settledMessages.length > 0 && (
            <SettledMessageList
              messages={settledMessages}
              onCardAction={onCardAction}
              onPin={onPin}
              onEditUserMessage={onEditUserMessage}
              regeneratableAssistantMessageId={regeneratableAssistantMessageId}
              onRegenerateLastResponse={onRegenerateLastResponse}
            />
          )}
          {activeMessage && (
            <MessageBubble
              key={activeMessage.id}
              message={activeMessage}
              onCardAction={onCardAction}
              onPin={onPin}
              onEdit={activeMessage.role === 'user' && !activeMessage.isToolResult ? onEditUserMessage : undefined}
              canRegenerate={activeMessage.id === regeneratableAssistantMessageId}
              onRegenerate={activeMessage.id === regeneratableAssistantMessageId ? onRegenerateLastResponse : undefined}
            />
          )}
          <AgentStatusBar status={agentStatus} />
        </div>
        <div ref={bottomRef} />
      </div>

      {/* Scroll to bottom button */}
      <button
        onClick={scrollToBottom}
        className={`
          absolute left-1/2 -translate-x-1/2 bottom-8
          flex items-center justify-center
          w-10 h-10
          rounded-full
          z-20
          border border-push-edge
          bg-push-grad-card
          text-push-fg-secondary
          shadow-push-lg backdrop-blur-sm
          transition-all duration-300 ease-out
          hover:border-push-edge-hover hover:text-[#f0f4ff] hover:shadow-push-xl
          spring-press
          ${showScrollButton ? 'opacity-100 translate-y-0 pointer-events-auto' : 'opacity-0 translate-y-3 pointer-events-none'}
        `}
        aria-label="Scroll to bottom"
      >
        <ArrowDown size={18} />
      </button>

    </div>
  );
}
