import { memo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ChatMessage, CardAction } from '@/types';
import { CardRenderer } from '@/components/cards/CardRenderer';

interface MessageBubbleProps {
  message: ChatMessage;
  onCardAction?: (action: CardAction) => void;
}

function formatInline(text: string): React.ReactNode[] {
  const result: React.ReactNode[] = [];
  const regex = /(\*\*(.+?)\*\*)|(`([^`]+?)`)|([^*`]+)/g;
  let match; let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match[2]) result.push(<strong key={key++} className="font-semibold text-[#fafafa]">{match[2]}</strong>);
    else if (match[4]) result.push(<code key={key++} className="font-mono text-[13px] bg-[#0d0d0d] border border-[#1a1a1a] rounded px-1.5 py-0.5 text-[#e4e4e7]">{match[4]}</code>);
    else if (match[5]) result.push(<span key={key++}>{match[5]}</span>);
  }
  return result;
}

function isToolCall(code: string): boolean {
  try {
    const trimmed = code.trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return false;
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && 'tool' in parsed;
  } catch {
    return false;
  }
}

function formatContent(content: string): React.ReactNode[] {
  if (!content) return [];
  const parts: React.ReactNode[] = [];
  const lines = content.split('\n');
  let inCodeBlock = false; let codeLines: string[] = []; let codeKey = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      if (inCodeBlock) {
        const fullCode = codeLines.join('\n');
        if (!isToolCall(fullCode)) {
          parts.push(
            <pre key={`code-${codeKey++}`} className="my-2 rounded-lg bg-[#0a0a0c] border border-[#1a1a1a] px-3 py-2.5 overflow-x-auto">
              <code className="font-mono text-[13px] text-[#e4e4e7]">{fullCode}</code>
            </pre>
          );
        }
        codeLines = []; inCodeBlock = false;
      } else inCodeBlock = true;
      continue;
    }
    if (inCodeBlock) { codeLines.push(line); continue; }
    parts.push(<span key={`line-${i}`}>{i > 0 && <br />}{formatInline(line)}</span>);
  }
  return parts;
}

function ThinkingBlock({ thinking, isStreaming }: { thinking: string; isStreaming: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const preview = thinking.length > 80 ? '...' + thinking.slice(-80).trim() : thinking.trim();
  return (
    <div className="mb-2">
      <button onClick={() => setExpanded(!expanded)} className="flex items-center gap-1 text-[11px] text-[#52525b] hover:text-[#888] transition-colors">
        <ChevronRight className={`h-3 w-3 transition-transform ${expanded ? 'rotate-90' : ''}`} />
        <span className="font-medium">{isStreaming ? 'Reasoning' : 'Thought process'}</span>
      </button>
      {expanded ? <div className="mt-1.5 ml-4 pl-3 border-l border-[#1a1a1a] text-[12px] text-[#52525b] whitespace-pre-wrap">{thinking}</div> : <div className="text-[12px] text-[#3a3a3e] mt-1 ml-4 italic line-clamp-2">{preview}</div>}
    </div>
  );
}

export const MessageBubble = memo(({ message, onCardAction }: MessageBubbleProps) => {
  const isAssistant = message.role === 'assistant';
  if ((message.role as string) === 'tool') return null; // VIGIL Filter

  return (
    <div className={`flex flex-col ${isAssistant ? 'items-start' : 'items-end'} mb-4 px-4`}>
      <div className={`max-w-[90%] rounded-2xl px-4 py-2.5 ${isAssistant ? 'bg-[#121214] text-[#ececed] border border-[#1a1a1a]' : 'bg-[#0070f3] text-white animate-in slide-in-from-right-2'}`}>
        {isAssistant && message.thinking && <ThinkingBlock thinking={message.thinking} isStreaming={false} />}
        <div className="text-sm leading-relaxed whitespace-pre-wrap">
          {formatContent(message.content || '')}
        </div>
        {message.cards?.map((card, i) => (
          <div key={i} className="mt-3">
            <CardRenderer card={card} onAction={onCardAction} />
          </div>
        ))}
      </div>
    </div>
  );
});
