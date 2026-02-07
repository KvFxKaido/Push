import { useMemo } from 'react';
import { X, TerminalSquare } from 'lucide-react';
import type { ChatMessage } from '@/types';
import { detectAnyToolCall } from '@/lib/tool-dispatch';

interface ActivityDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  messages: ChatMessage[];
}

export function ActivityDrawer({ isOpen, onClose, messages }: ActivityDrawerProps) {
  const logs = useMemo(() => {
    const items: { type: 'call' | 'result', tool?: string, content: string, timestamp: number }[] = [];
    messages.forEach(m => {
      if (m.role === 'assistant') {
        const toolCall = detectAnyToolCall(m.content);
        if (toolCall) {
          const callObj = toolCall.call as any;
          const argsText = JSON.stringify(callObj.args || callObj.task || '');
          items.push({
            type: 'call', 
            tool: callObj.tool,
            content: `> ${callObj.tool}: ${argsText.slice(0, 500)}${argsText.length > 500 ? '...' : ''}`,
            timestamp: m.timestamp
          });
        }
      } else if ((m.role as string) === 'tool') {
        items.push({ type: 'result', content: m.content, timestamp: m.timestamp });
      }
    });
    return items;
  }, [messages]);

  return (
    <>
      <div className={`fixed inset-0 bg-black/40 z-40 transition-opacity ${isOpen ? 'opacity-100' : 'opacity-0 pointer-events-none'}`} onClick={onClose} />
      <div className={`fixed z-50 bg-[#050505] border-[#1a1a1a] transition-transform duration-300 ease-out flex flex-col inset-x-0 bottom-0 h-[75vh] rounded-t-2xl border-t border-x md:inset-y-0 md:right-0 md:left-auto md:w-[450px] md:h-full md:rounded-none md:rounded-l-2xl md:border-l ${isOpen ? 'translate-y-0' : 'translate-y-full'}`}>
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1a1a1a] bg-[#0a0a0a] rounded-t-2xl md:rounded-none">
          <div className="flex items-center gap-2">
            <TerminalSquare className="h-4 w-4 text-[#0070f3]" />
            <h2 className="text-[11px] font-bold uppercase tracking-widest text-[#52525b]">Vigil Output</h2>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-[#1a1a1a] rounded-lg"><X className="h-4 w-4 text-[#52525b]" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 font-mono text-[11px] leading-relaxed text-[#a1a1aa]">
          <div className="space-y-3">
            {logs.map((log, i) => (
              <div key={i} className={log.type === 'call' ? 'text-[#e4e4e7]' : 'text-[#52525b] border-l border-[#1a1a1a] ml-1 pl-3'}>
                {log.content}
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
