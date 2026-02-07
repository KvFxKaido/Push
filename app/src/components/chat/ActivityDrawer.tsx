import { useEffect } from 'react';
import { X, Terminal, TerminalSquare } from 'lucide-react';
import type { ChatMessage } from '@/types';
import { detectAnyToolCall } from '@/lib/tool-dispatch';

interface ActivityDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  messages: ChatMessage[];
}

export function ActivityDrawer({ isOpen, onClose, messages }: ActivityDrawerProps) {
  // Filter for messages that contain tool calls or results
  const activityLog = messages.filter(m => 
    m.role === 'assistant' && detectAnyToolCall(m.content) || 
    (m.role as string) === 'tool'
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  return (
    <>
      <div
        className={`fixed inset-0 bg-black/50 z-40 transition-opacity duration-300 md:hidden ${
          isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        onClick={onClose}
      />

      <div
        className={`fixed z-50 bg-[#000] border-[#1a1a1a] transition-transform duration-300 ease-out flex flex-col
          inset-x-0 bottom-0 h-[70vh] rounded-t-2xl border-t border-x
          md:inset-y-0 md:right-0 md:left-auto md:w-[450px] md:h-full md:rounded-none md:rounded-l-2xl md:border-l
          ${isOpen ? 'translate-y-0 md:translate-x-0' : 'translate-y-full md:translate-x-full'}
        `}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1a1a1a] shrink-0">
          <div className="flex items-center gap-2">
            <TerminalSquare className="h-4 w-4 text-[#0070f3]" />
            <h2 className="text-sm font-semibold text-[#fafafa]">Activity Log (Vigil)</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-[#1a1a1a] rounded-lg transition-colors">
            <X className="h-4 w-4 text-[#52525b]" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 font-mono text-[12px] leading-relaxed select-text">
          {activityLog.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-[#3f3f46] gap-2">
              <Terminal className="h-8 w-8 opacity-20" />
              <p>No activity recorded this session</p>
            </div>
          ) : (
            <div className="space-y-4">
              {activityLog.map((msg, i) => (
                <div key={i} className={`p-3 rounded-lg border ${msg.role === 'assistant' ? 'bg-[#0a0a0c] border-[#1a1a1a]' : 'bg-[#050505] border-[#111]'}`}>
                  <div className="flex items-center justify-between mb-2 opacity-50">
                    <span className="uppercase text-[10px] tracking-wider font-bold">
                      {msg.role === 'assistant' ? 'â†ª Agent Request' : 'â†« Tool Output'}
                    </span>
                    <span>{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                  </div>
                  <pre className="whitespace-pre-wrap break-words text-[#a1a1aa]">
                    {msg.content}
                  </pre>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
} 
