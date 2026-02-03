import { useRef, useEffect, useMemo } from 'react';
import type { ChatMessage, AgentStatus, ActiveRepo, CardAction } from '@/types';
import { MessageBubble } from './MessageBubble';
import { AgentStatusBar } from './AgentStatusBar';

interface ChatContainerProps {
  messages: ChatMessage[];
  agentStatus: AgentStatus;
  activeRepo?: ActiveRepo | null;
  onSuggestion?: (text: string) => void;
  onCardAction?: (action: CardAction) => void;
}

function EmptyState({
  activeRepo,
  onSuggestion,
}: {
  activeRepo?: ActiveRepo | null;
  onSuggestion?: (text: string) => void;
}) {
  const suggestions = useMemo(() => {
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
  }, [activeRepo]);

  return (
    <div className="flex flex-1 items-center justify-center px-8">
      <div className="text-center max-w-sm">
        <div className="mx-auto mb-5 flex h-10 w-10 items-center justify-center rounded-xl bg-[#111113] border border-[#1a1a1e]">
          <svg
            width="18"
            height="18"
            viewBox="0 0 16 16"
            fill="none"
            className="text-[#0070f3]"
          >
            <path
              d="M8 1L14.5 5V11L8 15L1.5 11V5L8 1Z"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-[#fafafa] mb-2">
          {activeRepo ? activeRepo.name : 'Push'}
        </h2>
        <p className="text-sm text-[#a1a1aa] leading-relaxed">
          {activeRepo
            ? `Focused on ${activeRepo.full_name}. Ask about PRs, recent changes, or the codebase.`
            : 'AI coding agent with direct repo access. Review PRs, explore codebases, and ship changes — all from here.'}
        </p>
        <div className="mt-6 flex flex-col gap-2">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              onClick={() => onSuggestion?.(suggestion)}
              className="rounded-xl border border-[#1a1a1e] bg-[#111113] px-4 py-2.5 text-left text-sm text-[#a1a1aa] transition-colors duration-200 hover:border-[#27272a] hover:text-[#d4d4d8] cursor-pointer active:scale-[0.99]"
            >
              {suggestion}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ChatContainer({ messages, agentStatus, activeRepo, onSuggestion, onCardAction }: ChatContainerProps) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive or content streams in
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Only auto-scroll if user is near the bottom (within 150px)
    const isNearBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight < 150;

    if (isNearBottom) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, messages.length > 0 ? messages[messages.length - 1]?.content : '']);

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <EmptyState activeRepo={activeRepo} onSuggestion={onSuggestion} />
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex flex-1 flex-col overflow-y-auto overscroll-contain"
    >
      <div className="flex-1" />
      <div className="py-4 space-y-1">
        {messages.map((msg) => (
          <MessageBubble key={msg.id} message={msg} onCardAction={onCardAction} />
        ))}
        <AgentStatusBar status={agentStatus} />
      </div>
      <div ref={bottomRef} />
    </div>
  );
}
