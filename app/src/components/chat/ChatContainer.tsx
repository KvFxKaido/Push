import { useRef, useEffect, useMemo, useState, useCallback } from 'react';
import { ArrowDown } from 'lucide-react';
import type { ChatMessage, AgentStatus, ActiveRepo, CardAction } from '@/types';
import { MessageBubble } from './MessageBubble';
import { AgentStatusBar } from './AgentStatusBar';

interface ChatContainerProps {
  messages: ChatMessage[];
  agentStatus: AgentStatus;
  activeRepo?: ActiveRepo | null;
  isSandboxMode?: boolean;
  onSuggestion?: (text: string) => void;
  onCardAction?: (action: CardAction) => void;
}

const AUTO_SCROLL_THRESHOLD_PX = 150;
const AT_BOTTOM_THRESHOLD_PX = 48;
const SCROLL_IDLE_MS = 180;

function EmptyState({
  activeRepo,
  isSandboxMode,
  onSuggestion,
}: {
  activeRepo?: ActiveRepo | null;
  isSandboxMode?: boolean;
  onSuggestion?: (text: string) => void;
}) {
  const [hexTap, setHexTap] = useState(false);

  const handleHexTap = () => {
    setHexTap(false);
    // Force reflow so re-adding the class restarts the animation
    requestAnimationFrame(() => setHexTap(true));
  };

  const suggestions = useMemo(() => {
    if (isSandboxMode) {
      return [
        "I'm not sure what I'm building yet — let's explore",
        'Help me prototype an idea',
        'I want to test an idea quickly',
      ];
    }
    if (activeRepo) {
      return [
        `Show open PRs on ${activeRepo.name}`,
        `What changed recently in ${activeRepo.name}?`,
        `Summarize the ${activeRepo.name} codebase`,
      ];
    }
    return [
      'Review my latest PR',
      'What changed in main today?',
      'Show my open pull requests',
    ];
  }, [activeRepo, isSandboxMode]);

  return (
    <div className="flex flex-1 items-center justify-center px-8">
      <div className="text-center max-w-sm">
        <button
          type="button"
          onClick={handleHexTap}
          className="mx-auto mb-5 flex h-12 w-12 cursor-pointer items-center justify-center rounded-xl border border-[#1e2634] bg-push-grad-icon shadow-[0_12px_30px_rgba(0,0,0,0.55)] active:scale-95 transition-transform"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 16 16"
            fill="none"
            className={`text-push-accent transition-colors ${hexTap ? 'hex-tap' : ''}`}
            onAnimationEnd={() => setHexTap(false)}
          >
            <path
              d="M8 1L14.5 5V11L8 15L1.5 11V5L8 1Z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
              className={`transition-all duration-300 ${hexTap ? 'fill-[#0070f3]/20' : 'fill-transparent'}`}
            />
          </svg>
        </button>
        <h2 className="text-lg font-semibold text-[#fafafa] mb-2.5">
          {activeRepo ? activeRepo.name : isSandboxMode ? 'Sandbox' : 'Push'}
        </h2>
        <p className="text-sm leading-relaxed text-push-fg-secondary">
          {activeRepo
            ? `Focused on ${activeRepo.full_name}. Ask about PRs, recent changes, or the codebase.`
            : isSandboxMode
            ? 'Ephemeral workspace — write code, run commands, and prototype ideas from scratch.'
            : 'AI coding agent with direct repo access. Review PRs, explore codebases, and ship changes — all from here.'}
        </p>
        <div className="mt-6 flex flex-col gap-2.5 stagger-in">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              onClick={() => onSuggestion?.(suggestion)}
              className="cursor-pointer rounded-xl border border-push-edge bg-push-grad-card px-4 py-3 text-left text-sm text-push-fg-secondary shadow-push-card card-hover spring-press hover:border-[#31425a] hover:text-[#f0f4ff] hover:shadow-push-card-hover"
            >
              {suggestion}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ChatContainer({ messages, agentStatus, activeRepo, isSandboxMode, onSuggestion, onCardAction }: ChatContainerProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const lastMessageRef = useRef<ChatMessage | null>(null);
  const lastMessageContent = messages.length > 0 ? messages[messages.length - 1]?.content : '';
  const scrollIdleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      setIsUserScrolling(true);

      if (scrollIdleTimeoutRef.current) clearTimeout(scrollIdleTimeoutRef.current);
      scrollIdleTimeoutRef.current = setTimeout(() => {
        updateBottomState(container);
        setIsUserScrolling(false);
        scrollIdleTimeoutRef.current = null;
      }, SCROLL_IDLE_MS);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      container.removeEventListener('scroll', handleScroll);
      if (scrollIdleTimeoutRef.current) clearTimeout(scrollIdleTimeoutRef.current);
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
    setIsUserScrolling(false);
  };

  const showScrollButton = !isAtBottom && !isUserScrolling;

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <EmptyState activeRepo={activeRepo} isSandboxMode={isSandboxMode} onSuggestion={onSuggestion} />
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col overflow-hidden relative">
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto overscroll-contain"
      >
        <div className="flex-1" />
        <div className="py-4 space-y-1.5">
          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} onCardAction={onCardAction} />
          ))}
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
          border border-push-edge
          bg-push-grad-card
          text-push-fg-secondary
          shadow-push-lg backdrop-blur-sm
          transition-all duration-300 ease-out
          hover:border-[#31425a] hover:text-[#f0f4ff] hover:shadow-push-xl
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
