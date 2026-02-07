import { useRef, useEffect, useState } from 'react';
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
        <div className="flex flex-col min-h-full py-4 relative">
          {messages.map((m) => (
            <MessageBubble key={m.id} message={m} onCardAction={onCardAction} />
          ))}
          <div ref={bottomRef} className="h-4 w-full" />
        </div>
      </div>
      
      <button
        onClick={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
        className={`fixed bottom-24 right-5 rounded-full bg-[#111] p-2 text-[#a1a1aa] shadow-lg border border-[#1a1a1a] transition-opacity ${showScrollButton ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
      >
        <ArrowDown className="h-5 w-5" />
      </button>

      <div className="border-t border-[#1a1a1a] bg-[#000] sticky bottom-0">
        <div className="flex items-center justify-between">
          <AgentStatusBar status={agentStatus} />
          <button onClick={() => setIsVigilOpen(true)} className="flex items-center gap-2 px-3 py-1.5 mr-4 my-2 rounded-full bg-[#1a1a1a] border border-[#27272a] text-[10px] font-mono text-[#a1a1aa] hover:text-white">
            <TerminalSquare className="h-3 w-3" />
            <span>VIGIL</span>
            {agentStatus.active && <span className="animate-pulse w-1.5 h-1.5 rounded-full bg-[#0070f3]" />}
          </button>
        </div>
      </div>
      <ActivityDrawer isOpen={isVigilOpen} onClose={() => setIsVigilOpen(false)} messages={messages} />
    </div>
  );
}
