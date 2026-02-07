import { useRef, useEffect, useMemo, useState } from 'react';
import { ArrowDown, TerminalSquare } from 'lucide-react';
import type { ChatMessage, AgentStatus, ActiveRepo, CardAction } from '@/types';
import { MessageBubble } from './MessageBubble';
import { AgentStatusBar } from './AgentStatusBar';
import { ActivityDrawer } from './ActivityDrawer';

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
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-xl bg-[#111] border border-[#1a1a1a]">
          <div className="text-[#0070f3] w-6 h-6">
            <TerminalSquare />
          </div>
        </div>
        <h2 className="text-lg font-semibold text-[#fafafa] mb-2">
          {activeRepo ? activeRepo.name : 'Push'}
        </h2>
        <p className="text-sm text-[#a1a1aa] leading-relaxed mb-6">
          AI coding agent with direct repo access. Review PRs, explore codebases, and ship changes.
        </p>
        <div className="flex flex-col gap-2">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              onClick={() => onSuggestion?.(suggestion)}
              className="rounded-xl border border-[#1a1a1a] bg-[#0d0d0d] px-4 py-2.5 text-left text-sm text-[#a1a1aa] transition-colors hover:border-[#27272a] hover:text-[#d4d4d8]"
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
  const [isVigilOpen, setIsVigilOpen] = useState(false);
  const [showScrollButton, setShowScrollButton] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const handleScroll = () => {
      const dist = container.scrollHeight - container.scrollTop - container.clientHeight;
      setShowScrollButton(dist > 300);
    };
    container.addEventListener('scroll', handleScroll);
    return () => container.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, agentStatus.active]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden relative">
      <div ref={containerRef} className="flex-1 overflow-y-auto no-scrollbar scroll-smooth">
        {messages.length === 0 ? (
          <EmptyState activeRepo={activeRepo} onSuggestion={onSuggestion} />
        ) : (
          <div className="flex flex-col min-h-full py-4 relative">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} onCardAction={onCardAction} />
            ))}
            <div ref={bottomRef} className="h-4 w-full" />
          </div>
        )}
      </div>
      
      <button
        onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
        className={`fixed bottom-24 right-5 rounded-full bg-[#111] p-2 text-[#a1a1aa] shadow-lg border border-[#1a1a1a] transition-opacity ${showScrollButton ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      >
        <ArrowDown size={18} />
      </button>

      <div className="border-t border-[#1a1a1a] bg-[#000] sticky bottom-0 z-10">
        <div className="flex items-center justify-between min-h-[40px]">
          <div className="flex-1">
            <AgentStatusBar status={agentStatus} />
          </div>
          <button onClick={() => setIsVigilOpen(true)} className="flex items-center gap-2 px-3 py-1.5 mr-4 my-2 rounded-full bg-[#1a1a1a] border border-[#27272a] text-[10px] font-mono text-[#a1a1aa] hover:text-white transition-colors">
            <TerminalSquare size={12} />
            <span>VIGIL</span>
            {agentStatus.active && <span className="animate-pulse w-1.5 h-1.5 rounded-full bg-[#0070f3]" />}
          </button>
        </div>
      </div>
      <ActivityDrawer isOpen={isVigilOpen} onClose={() => setIsVigilOpen(false)} messages={messages} />
    </div>
  );
}
