import { useMemo, useState } from 'react';
import { Copy, Download, Check } from 'lucide-react';
import { detectAnyToolCall } from '@/lib/tool-dispatch';
import type { AgentStatusEvent, AgentStatusSource, ChatMessage } from '@/types';

interface HubConsoleTabProps {
  messages: ChatMessage[];
  agentEvents: AgentStatusEvent[];
}

interface ConsoleLogItem {
  type: 'call' | 'result' | 'status' | 'malformed';
  content: string;
  timestamp: number;
  source?: AgentStatusSource;
  detail?: string;
}

function getSourceLabel(source: AgentStatusSource): string {
  switch (source) {
    case 'coder':
      return 'Coder';
    case 'auditor':
      return 'Auditor';
    case 'system':
      return 'System';
    default:
      return 'Orchestrator';
  }
}

export function HubConsoleTab({ messages, agentEvents }: HubConsoleTabProps) {
  const [copied, setCopied] = useState(false);

  const logs = useMemo(() => {
    const items: ConsoleLogItem[] = [];
    messages.forEach((m) => {
      if (m.role === 'assistant') {
        if (m.isMalformed) {
          const toolName = m.toolMeta?.toolName || 'unknown';
          items.push({
            type: 'malformed',
            content: `malformed tool call: ${toolName}`,
            timestamp: m.timestamp,
          });
        } else {
          const toolCall = detectAnyToolCall(m.content);
          if (toolCall) {
            const args = JSON.stringify((toolCall.call as { args?: unknown }).args ?? '').slice(0, 280);
            items.push({
              type: 'call',
              content: `> ${(toolCall.call as { tool?: string }).tool}: ${args}`,
              timestamp: m.timestamp,
            });
          }
        }
      } else if (m.isToolResult) {
        items.push({ type: 'result', content: m.content, timestamp: m.timestamp });
      }
    });

    agentEvents.forEach((event) => {
      items.push({
        type: 'status',
        content: event.phase,
        detail: event.detail,
        source: event.source,
        timestamp: event.timestamp,
      });
    });

    return items.sort((a, b) => a.timestamp - b.timestamp);
  }, [messages, agentEvents]);

  const getFormattedLogs = () => {
    return logs
      .map((log) => {
        const date = new Date(log.timestamp).toISOString();
        if (log.type === 'status' && log.source) {
          const detail = log.detail ? ` — ${log.detail}` : '';
          return `[${date}] [${getSourceLabel(log.source)}] ${log.content}${detail}`;
        }
        if (log.type === 'malformed') {
          return `[${date}] [MALFORMED] ${log.content}`;
        }
        return `[${date}] ${log.type === 'call' ? '' : '  '}${log.content}`;
      })
      .join('\n');
  };

  const handleCopyAll = () => {
    const text = getFormattedLogs();
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadLogs = () => {
    const text = getFormattedLogs();
    if (!text) return;
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `push-tool-logs-${timestamp}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Sticky Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-push-edge bg-push-bg-primary/80 px-3 py-2 backdrop-blur-md">
        <span className="text-[11px] font-medium uppercase tracking-wider text-push-fg-dim">
          Agent Console
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopyAll}
            disabled={logs.length === 0}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-push-fg-secondary transition-colors hover:bg-white/5 disabled:opacity-50"
            title="Copy all logs"
          >
            {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
            Copy All
          </button>
          <button
            onClick={handleDownloadLogs}
            disabled={logs.length === 0}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] text-push-fg-secondary transition-colors hover:bg-white/5 disabled:opacity-50"
            title="Download logs as .txt"
          >
            <Download className="h-3 w-3" />
            Download
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 font-mono text-xs leading-relaxed text-push-fg-secondary">
        <div className="space-y-2">
          {logs.map((log, idx) => (
            <div
              key={`${log.timestamp}-${idx}`}
              className={
                log.type === 'call'
                  ? 'text-push-fg-secondary'
                  : log.type === 'malformed'
                  ? 'text-amber-400'
                  : log.type === 'result'
                  ? 'ml-2 border-l border-push-edge pl-2 text-push-fg-dim'
                  : 'ml-2 border-l border-push-edge/70 pl-2 text-[#86c5ff]'
              }
            >
              {log.type === 'status' && log.source ? `[${getSourceLabel(log.source)}] ` : ''}
              {log.content}
              {log.type === 'status' && log.detail ? ` — ${log.detail}` : ''}
            </div>
          ))}
          {logs.length === 0 && (
            <p className="text-push-fg-dim">No console logs yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}
