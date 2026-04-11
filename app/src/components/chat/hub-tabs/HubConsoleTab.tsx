import { useMemo, useState } from 'react';
import { Copy, Download, Check } from 'lucide-react';
import { detectAnyToolCall } from '@/lib/tool-dispatch';
import { HUB_MATERIAL_PILL_BUTTON_CLASS, HubControlGlow } from '@/components/chat/hub-styles';
import type {
  AgentStatusEvent,
  AgentStatusSource,
  ChatMessage,
  RunEvent,
  RunEventSubagent,
} from '@/types';

interface HubConsoleTabProps {
  messages: ChatMessage[];
  agentEvents: AgentStatusEvent[];
  runEvents: RunEvent[];
}

interface ConsoleLogItem {
  type: 'call' | 'result' | 'status' | 'malformed' | 'lifecycle';
  content: string;
  timestamp: number;
  source?: AgentStatusSource;
  detail?: string;
}

function getSourceLabel(source: AgentStatusSource): string {
  switch (source) {
    case 'coder':
      return 'Coder';
    case 'explorer':
      return 'Explorer';
    case 'auditor':
      return 'Auditor';
    case 'system':
      return 'System';
    default:
      return 'Orchestrator';
  }
}

function getSubagentLabel(agent: RunEventSubagent): string {
  switch (agent) {
    case 'coder':
      return 'Coder';
    case 'explorer':
      return 'Explorer';
    case 'auditor':
      return 'Auditor';
    case 'task_graph':
      return 'Task Graph';
    default:
      return 'Planner';
  }
}

function getTaskGraphTaskLabel(agent: 'explorer' | 'coder', taskId: string): string {
  return `Task Graph · ${agent === 'explorer' ? 'Explorer' : 'Coder'} · ${taskId}`;
}

export function HubConsoleTab({ messages, agentEvents, runEvents }: HubConsoleTabProps) {
  const [copied, setCopied] = useState(false);

  const logs = useMemo(() => {
    const items: ConsoleLogItem[] = [];
    const firstStructuredEventAt = runEvents[0]?.timestamp ?? Number.POSITIVE_INFINITY;

    messages.forEach((m) => {
      if (m.timestamp >= firstStructuredEventAt) return;
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
            const args = JSON.stringify((toolCall.call as { args?: unknown }).args ?? '').slice(
              0,
              280,
            );
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

    runEvents.forEach((event) => {
      switch (event.type) {
        case 'assistant.turn_start':
          items.push({
            type: 'lifecycle',
            content: `Turn ${event.round + 1} started`,
            timestamp: event.timestamp,
          });
          break;
        case 'assistant.turn_end':
          items.push({
            type: 'lifecycle',
            content:
              event.outcome === 'steered'
                ? `Turn ${event.round + 1} steered`
                : `Turn ${event.round + 1} ${event.outcome}`,
            timestamp: event.timestamp,
          });
          break;
        case 'tool.execution_start':
          items.push({
            type: 'call',
            content: `> ${event.toolName}`,
            timestamp: event.timestamp,
          });
          break;
        case 'tool.execution_complete':
          items.push({
            type: 'result',
            content: `${event.preview} (${event.durationMs}ms)`,
            timestamp: event.timestamp,
          });
          break;
        case 'tool.call_malformed':
          items.push({
            type: 'malformed',
            content: `malformed tool call${event.toolName ? `: ${event.toolName}` : ''} (${event.reason})`,
            detail: event.preview,
            timestamp: event.timestamp,
          });
          break;
        case 'subagent.started':
          items.push({
            type: 'lifecycle',
            content: `${getSubagentLabel(event.agent)} started`,
            detail: event.detail,
            timestamp: event.timestamp,
          });
          break;
        case 'subagent.completed':
          items.push({
            type: 'lifecycle',
            content: `${getSubagentLabel(event.agent)} completed`,
            detail: event.summary,
            timestamp: event.timestamp,
          });
          break;
        case 'subagent.failed':
          items.push({
            type: 'malformed',
            content: `${getSubagentLabel(event.agent)} failed`,
            detail: event.error,
            timestamp: event.timestamp,
          });
          break;
        case 'task_graph.task_ready':
          items.push({
            type: 'lifecycle',
            content: `${getTaskGraphTaskLabel(event.agent, event.taskId)} ready`,
            detail: event.detail,
            timestamp: event.timestamp,
          });
          break;
        case 'task_graph.task_started':
          items.push({
            type: 'lifecycle',
            content: `${getTaskGraphTaskLabel(event.agent, event.taskId)} started`,
            detail: event.detail,
            timestamp: event.timestamp,
          });
          break;
        case 'task_graph.task_completed':
          items.push({
            type: 'lifecycle',
            content: `${getTaskGraphTaskLabel(event.agent, event.taskId)} completed`,
            detail: `${event.summary}${event.elapsedMs !== undefined ? ` (${event.elapsedMs}ms)` : ''}`,
            timestamp: event.timestamp,
          });
          break;
        case 'task_graph.task_failed':
          items.push({
            type: 'malformed',
            content: `${getTaskGraphTaskLabel(event.agent, event.taskId)} failed`,
            detail: `${event.error}${event.elapsedMs !== undefined ? ` (${event.elapsedMs}ms)` : ''}`,
            timestamp: event.timestamp,
          });
          break;
        case 'task_graph.task_cancelled':
          items.push({
            type: 'lifecycle',
            content: `${getTaskGraphTaskLabel(event.agent, event.taskId)} cancelled`,
            detail: `${event.reason}${event.elapsedMs !== undefined ? ` (${event.elapsedMs}ms)` : ''}`,
            timestamp: event.timestamp,
          });
          break;
        case 'task_graph.graph_completed':
          items.push({
            type: 'lifecycle',
            content: `Task Graph ${event.aborted ? 'cancelled' : event.success ? 'completed' : 'finished with issues'}`,
            detail: `${event.summary} (${event.nodeCount} tasks, ${event.totalRounds} rounds, ${event.wallTimeMs}ms)`,
            timestamp: event.timestamp,
          });
          break;
        case 'user.follow_up_queued':
          items.push({
            type: 'lifecycle',
            content: `Queued follow-up #${event.position}`,
            detail: event.preview,
            timestamp: event.timestamp,
          });
          break;
        case 'user.follow_up_steered':
          items.push({
            type: 'lifecycle',
            content: event.replacedPending
              ? 'Updated steering request'
              : 'Steering request captured',
            detail: event.preview,
            timestamp: event.timestamp,
          });
          break;
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
  }, [messages, agentEvents, runEvents]);

  const getFormattedLogs = () => {
    return logs
      .map((log) => {
        const date = new Date(log.timestamp).toISOString();
        if (log.type === 'status' && log.source) {
          const detail = log.detail ? ` — ${log.detail}` : '';
          return `[${date}] [${getSourceLabel(log.source)}] ${log.content}${detail}`;
        }
        if (log.type === 'lifecycle') {
          const detail = log.detail ? ` — ${log.detail}` : '';
          return `[${date}] [Lifecycle] ${log.content}${detail}`;
        }
        if (log.type === 'malformed') {
          const detail = log.detail ? ` — ${log.detail}` : '';
          return `[${date}] [MALFORMED] ${log.content}${detail}`;
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
        <span className="text-push-xs font-medium uppercase tracking-wider text-push-fg-dim">
          Agent Console
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopyAll}
            disabled={logs.length === 0}
            className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-2.5 text-push-fg-secondary`}
            title="Copy all logs"
          >
            <HubControlGlow />
            {copied ? (
              <Check className="relative z-10 h-3 w-3 text-green-500" />
            ) : (
              <Copy className="relative z-10 h-3 w-3" />
            )}
            <span className="relative z-10">Copy All</span>
          </button>
          <button
            onClick={handleDownloadLogs}
            disabled={logs.length === 0}
            className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-2.5 text-push-fg-secondary`}
            title="Download logs as .txt"
          >
            <HubControlGlow />
            <Download className="relative z-10 h-3 w-3" />
            <span className="relative z-10">Download</span>
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
                      : log.type === 'lifecycle'
                        ? 'ml-2 border-l border-push-edge/70 pl-2 text-[#9edbaf]'
                        : 'ml-2 border-l border-push-edge/70 pl-2 text-[#86c5ff]'
              }
            >
              {log.type === 'status' && log.source ? `[${getSourceLabel(log.source)}] ` : ''}
              {log.type === 'lifecycle' ? '[Lifecycle] ' : ''}
              {log.content}
              {(log.type === 'status' || log.type === 'lifecycle' || log.type === 'malformed') &&
              log.detail
                ? ` — ${log.detail}`
                : ''}
            </div>
          ))}
          {logs.length === 0 && <p className="text-push-fg-dim">No console logs yet.</p>}
        </div>
      </div>
    </div>
  );
}
