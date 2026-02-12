import { useMemo } from 'react';
import { detectAnyToolCall } from '@/lib/tool-dispatch';
import type { ChatMessage } from '@/types';

interface HubConsoleTabProps {
  messages: ChatMessage[];
}

export function HubConsoleTab({ messages }: HubConsoleTabProps) {
  const logs = useMemo(() => {
    const items: Array<{ type: 'call' | 'result'; content: string; timestamp: number }> = [];
    messages.forEach((m) => {
      if (m.role === 'assistant') {
        const toolCall = detectAnyToolCall(m.content);
        if (toolCall) {
          const args = JSON.stringify((toolCall.call as { args?: unknown }).args ?? '').slice(0, 280);
          items.push({
            type: 'call',
            content: `> ${(toolCall.call as { tool?: string }).tool}: ${args}`,
            timestamp: m.timestamp,
          });
        }
      } else if (m.isToolResult) {
        items.push({ type: 'result', content: m.content, timestamp: m.timestamp });
      }
    });
    return items;
  }, [messages]);

  return (
    <div className="h-full overflow-y-auto p-3 font-mono text-xs leading-relaxed text-push-fg-secondary">
      <div className="space-y-2">
        {logs.map((log, idx) => (
          <div
            key={`${log.timestamp}-${idx}`}
            className={log.type === 'call' ? 'text-push-fg-secondary' : 'ml-2 border-l border-push-edge pl-2 text-push-fg-dim'}
          >
            {log.content}
          </div>
        ))}
        {logs.length === 0 && (
          <p className="text-push-fg-dim">No tool logs yet.</p>
        )}
      </div>
    </div>
  );
}
