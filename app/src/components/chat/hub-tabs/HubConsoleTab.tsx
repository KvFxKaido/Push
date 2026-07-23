import { useMemo, useState } from 'react';
import { Copy, Download, Check } from 'lucide-react';
import { detectAnyToolCall } from '@/lib/tool-dispatch';
import { HUB_MATERIAL_PILL_BUTTON_CLASS } from '@/components/chat/hub-styles';
import { getRoleDisplay, getSourceLabel, getSubagentLabel } from '@push/lib/role-display';
import { taskLedgerCounts } from '@push/lib/task-ledger';
import { resolveToolName } from '@/lib/tool-registry';
import { cn } from '@/lib/utils';
import {
  Sandbox,
  SandboxContent,
  SandboxHeader,
  SandboxTabContent,
  SandboxTabs,
  SandboxTabsBar,
  SandboxTabsList,
  SandboxTabsTrigger,
  type SandboxState,
} from '@/components/cards/sandbox-console';
import type { AgentStatusEvent, AgentStatusSource, ChatMessage, RunEvent } from '@/types';

interface HubConsoleTabProps {
  messages: ChatMessage[];
  agentEvents: AgentStatusEvent[];
  runEvents: RunEvent[];
}

interface ConsoleSandboxPayload {
  /** Command line (from the execution_complete `target`); empty while running. */
  command: string;
  /** Output summary (from the execution_complete `preview`). */
  output: string;
  state: SandboxState;
  durationMs?: number;
}

interface ConsoleLogItem {
  type: 'call' | 'result' | 'status' | 'warning' | 'malformed' | 'lifecycle' | 'sandbox';
  content: string;
  timestamp: number;
  source?: AgentStatusSource;
  detail?: string;
  sandbox?: ConsoleSandboxPayload;
}

function formatSandboxDuration(durationMs: number): string {
  return durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;
}

// Run events carry the tool's *public* name (`getToolName` → `getToolPublicName`),
// so `sandbox_exec` arrives as `exec`. Resolve through the registry so the card
// matches by canonical name regardless of which alias the event carries (web
// emits `exec`, and aliases/canonical must work on every surface).
function isSandboxExecEvent(toolName: string): boolean {
  return resolveToolName(toolName) === 'sandbox_exec';
}

// A non-zero `sandbox_exec` exit is NOT a tool error: `sandbox-tools.ts` wraps it
// in a `[Tool Result — sandbox_exec]` envelope (with `Exit code: N`), and `isError`
// is only set for dispatch/unreachable failures (`[Tool Error]`). So a failing
// command would otherwise read as "Completed". Recover the exit code from the
// summarized preview to flag the card as failed (matching SandboxCard's
// expand-on-non-zero behavior). Returns null when no exit code is present (e.g. a
// command long enough to push it past the preview cap) — the card then falls back
// to `isError` alone.
function parseExitCodeFromPreview(preview: string): number | null {
  const match = preview.match(/Exit code:\s*(-?\d+)/);
  return match ? Number.parseInt(match[1], 10) : null;
}

function ConsoleSandboxItem({ item }: { item: ConsoleSandboxPayload }) {
  return (
    <Sandbox defaultOpen={item.state !== 'completed'}>
      <SandboxHeader title={item.command || 'sandbox_exec'} state={item.state} />
      <SandboxContent>
        {/* On failure, open straight to the Console tab so the error output is
            visible without an extra click (the command is still one tab away). */}
        <SandboxTabs defaultValue={item.state === 'error' ? 'console' : 'code'}>
          <SandboxTabsBar>
            <SandboxTabsList>
              <SandboxTabsTrigger value="code">Code</SandboxTabsTrigger>
              <SandboxTabsTrigger value="console">Console</SandboxTabsTrigger>
            </SandboxTabsList>
            {item.durationMs !== undefined && (
              <span className="ml-auto px-3 font-mono text-push-xs text-push-fg-dim">
                {formatSandboxDuration(item.durationMs)}
              </span>
            )}
          </SandboxTabsBar>
          <SandboxTabContent value="code">
            <pre className="overflow-auto whitespace-pre-wrap break-all bg-push-surface-inset p-3 font-mono text-push-xs text-push-fg-secondary">
              {item.command || '—'}
            </pre>
          </SandboxTabContent>
          <SandboxTabContent value="console">
            <pre
              className={cn(
                'overflow-auto whitespace-pre-wrap break-all bg-push-surface-inset p-3 font-mono text-push-xs',
                item.state === 'error' ? 'text-push-status-error/80' : 'text-push-fg-secondary',
              )}
            >
              {item.output || (item.state === 'running' ? 'Running…' : 'No output')}
            </pre>
          </SandboxTabContent>
        </SandboxTabs>
      </SandboxContent>
    </Sandbox>
  );
}

// User-facing labels come from the shared display seam (`lib/role-display.ts`),
// never spelled here — so the console can't drift from the rest of the UI.
// `getSourceLabel` (source attribution, incl. orchestrator → "Assistant") and
// `getSubagentLabel` (lifecycle lines) are imported from the seam directly.
function getTaskGraphTaskLabel(agent: 'explorer' | 'coder', taskId: string): string {
  return `Task Graph · ${getRoleDisplay(agent).phase ?? 'Working'} · ${taskId}`;
}

export function HubConsoleTab({ messages, agentEvents, runEvents }: HubConsoleTabProps) {
  const [copied, setCopied] = useState(false);

  const logs = useMemo(() => {
    const items: ConsoleLogItem[] = [];
    const firstStructuredEventAt = runEvents[0]?.timestamp ?? Number.POSITIVE_INFINITY;
    // `sandbox_exec` runs render as a tabbed Sandbox card rather than the flat
    // call/result lines. The command + output only land on the
    // `tool.execution_complete` event (`target` + `preview`); a start with no
    // matching complete is a still-running exec. Pre-scan completes so a
    // running placeholder isn't emitted for a run that has already finished.
    const completedSandboxExecIds = new Set(
      runEvents
        .filter(
          (event) => event.type === 'tool.execution_complete' && isSandboxExecEvent(event.toolName),
        )
        .map(
          (event) => (event as Extract<RunEvent, { type: 'tool.execution_complete' }>).executionId,
        ),
    );

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
          if (isSandboxExecEvent(event.toolName)) {
            // A completed run renders from execution_complete below; only emit a
            // running card when no completion exists for this execution yet.
            if (!completedSandboxExecIds.has(event.executionId)) {
              items.push({
                type: 'sandbox',
                content: 'sandbox_exec',
                timestamp: event.timestamp,
                sandbox: { command: '', output: '', state: 'running' },
              });
            }
            break;
          }
          items.push({
            type: 'call',
            content: `> ${event.toolName}`,
            timestamp: event.timestamp,
          });
          break;
        case 'tool.execution_complete':
          if (isSandboxExecEvent(event.toolName)) {
            const exitCode = parseExitCodeFromPreview(event.preview);
            const failed = event.isError || (exitCode !== null && exitCode !== 0);
            items.push({
              type: 'sandbox',
              content: event.target || 'sandbox_exec',
              timestamp: event.timestamp,
              sandbox: {
                command: event.target || '',
                output: event.preview,
                state: failed ? 'error' : 'completed',
                durationMs: event.durationMs,
              },
            });
            break;
          }
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
        case 'task.ledger_snapshot': {
          const counts = taskLedgerCounts(event.steps);
          const current = event.steps.find((step) => step.status === 'in_progress');
          items.push({
            type: 'lifecycle',
            content: `Task ledger · ${counts.completed}/${event.steps.length} done`,
            detail: current?.activeForm || `${event.scope.repoFullName} @ ${event.scope.branch}`,
            timestamp: event.timestamp,
          });
          break;
        }
        case 'task.drift_changed':
          items.push({
            type: event.health === 'possibly_stalled' ? 'warning' : 'lifecycle',
            content:
              event.health === 'possibly_stalled'
                ? 'Task possibly stalled'
                : 'Task progress resumed',
            detail:
              event.active.map((signal) => signal.detail).join('; ') ||
              (event.cleared.length > 0 ? `cleared: ${event.cleared.join(', ')}` : undefined),
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
        if (log.type === 'sandbox' && log.sandbox) {
          const { command, output, state, durationMs } = log.sandbox;
          const dur = durationMs !== undefined ? ` (${formatSandboxDuration(durationMs)})` : '';
          const stateLabel = state.charAt(0).toUpperCase() + state.slice(1);
          const outputLine = output ? `\n    ${output}` : '';
          return `[${date}] [Sandbox · ${stateLabel}] > ${command || 'sandbox_exec'}${dur}${outputLine}`;
        }
        if (log.type === 'lifecycle') {
          const detail = log.detail ? ` — ${log.detail}` : '';
          return `[${date}] [Lifecycle] ${log.content}${detail}`;
        }
        if (log.type === 'malformed') {
          const detail = log.detail ? ` — ${log.detail}` : '';
          return `[${date}] [MALFORMED] ${log.content}${detail}`;
        }
        if (log.type === 'warning') {
          const detail = log.detail ? ` — ${log.detail}` : '';
          return `[${date}] [Warning] ${log.content}${detail}`;
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
            {/* `icon-swap` fires on the incoming Check only; `copied` inits false
                so it plays once per click, never on mount/remount. */}
            {copied ? (
              <Check className="icon-swap h-3 w-3 text-push-status-success" />
            ) : (
              <Copy className="h-3 w-3" />
            )}
            <span>Copy All</span>
          </button>
          <button
            onClick={handleDownloadLogs}
            disabled={logs.length === 0}
            className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-2.5 text-push-fg-secondary`}
            title="Download logs as .txt"
          >
            <Download className="h-3 w-3" />
            <span>Download</span>
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-push-surface-inset p-3 font-mono text-xs leading-relaxed text-push-fg-secondary shadow-push-inset">
        <div className="space-y-2">
          {logs.map((log, idx) =>
            log.type === 'sandbox' && log.sandbox ? (
              <ConsoleSandboxItem key={`${log.timestamp}-${idx}`} item={log.sandbox} />
            ) : (
              <div
                key={`${log.timestamp}-${idx}`}
                className={
                  log.type === 'call'
                    ? 'text-push-fg-secondary'
                    : log.type === 'malformed' || log.type === 'warning'
                      ? 'text-amber-400'
                      : log.type === 'result'
                        ? 'ml-2 border-l border-push-edge pl-2 text-push-fg-dim'
                        : log.type === 'lifecycle'
                          ? 'ml-2 border-l border-push-edge/70 pl-2 text-push-status-success-soft'
                          : 'ml-2 border-l border-push-edge/70 pl-2 text-push-link'
                }
              >
                {log.type === 'status' && log.source ? `[${getSourceLabel(log.source)}] ` : ''}
                {log.type === 'lifecycle' ? '[Lifecycle] ' : ''}
                {log.type === 'warning' ? '[Warning] ' : ''}
                {log.content}
                {(log.type === 'status' ||
                  log.type === 'warning' ||
                  log.type === 'lifecycle' ||
                  log.type === 'malformed') &&
                log.detail
                  ? ` — ${log.detail}`
                  : ''}
              </div>
            ),
          )}
          {logs.length === 0 && <p className="text-push-fg-dim">No console logs yet.</p>}
        </div>
      </div>
    </div>
  );
}
