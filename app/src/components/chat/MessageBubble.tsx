import { memo } from 'react';
import type { ChatMessage, CardAction } from '@/types';
import { CardRenderer } from '@/components/cards/CardRenderer';

interface MessageBubbleProps {
  message: ChatMessage;
  onCardAction?: (action: CardAction) => void;
}

export const MessageBubble = memo(({ message, onCardAction }: MessageBubbleProps) => {
  const isAssistant = message.role === 'assistant';
  // DONT render tool result messages anymore - they belong in the Activity Drawer
  if ((message.role as string) === 'tool') {
    return null;
  }

  return (
    <div className={`flex flex-col ${isAssistant ? 'items-start' : 'items-end'} mb-4 px-4 whitespace-pre-wrap`}>
      <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 ${isAssistant ? 'bg-[#121214] text-[#ececed] border border-[#1a1a1a]' : 'bg-[#0070f3] text-white'}`}>
        <div className="text-sm leading-relaxed">
          {message.content}
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
