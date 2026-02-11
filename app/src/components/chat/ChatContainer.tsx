import { useRef, useEffect, useMemo, useState } from 'react';
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
          className="mx-auto mb-5 flex h-12 w-12 cursor-pointer items-center justify-center rounded-xl border border-[#1e2634] bg-[linear-gradient(180deg,#0d1119_0%,#070a10_100%)] shadow-[0_12px_30px_rgba(0,0,0,0.55)] active:scale-95 transition-transform"
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
              className="cursor-pointer rounded-xl border border-push-edge bg-[linear-gradient(180deg,#090d14_0%,#06090f_100%)] px-4 py-3 text-left text-sm text-push-fg-secondary shadow-push-card card-hover spring-press hover:border-[#31425a] hover:text-[#f0f4ff] hover:shadow-push-card-hover"
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
  const [showScrollButton, setShowScrollButton] = useState(false);
  const lastMessageRef = useRef<ChatMessage | null>(null);
  const lastMessageContent = messages.length > 0 ? messages[messages.length - 1]?.content : '';

  // Track scroll position and show/hide scroll button
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      setShowScrollButton(distanceFromBottom > 300);
    };

    container.addEventListener('scroll', handleScroll);
    handleScroll();

    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  // Auto-scroll to bottom when new messages arrive or content streams in
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
      const isNearBottom = distanceFromBottom < 150;

      if (isNearBottom) {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      }
    }

    // Update ref to track the last message
    lastMessageRef.current = lastMessage;
  }, [messages, lastMessageContent]);

  const scrollToBottom = () => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

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
          fixed right-4 bottom-24
          flex items-center justify-center
          w-10 h-10
          rounded-full
          border border-push-edge
          bg-[linear-gradient(180deg,#090d14_0%,#06090f_100%)]
          text-push-fg-secondary
          shadow-push-lg backdrop-blur-sm
          transition-all duration-300 cubic-bezier(0.16, 1, 0.3, 1)
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
