import { memo, useState } from 'react';
import {
  ChevronRight,
  Terminal,
  FileText,
  Search,
  Globe,
  Hammer,
  Wrench,
  AlertCircle,
} from 'lucide-react';
import type { ChatMessage, CardAction } from '@/types';
import { CardRenderer } from '@/components/cards/CardRenderer';

export interface ToolCallPair {
  callMsg: ChatMessage;
  resultMsg: ChatMessage;
}

interface ToolCallSummaryProps {
  items: ToolCallPair[];
  onCardAction?: (action: CardAction) => void;
}

/* ------------------------------------------------------------------ */
/*  Icon + wording map                                                 */
/* ------------------------------------------------------------------ */

type ToolLabel = { noun: string; verb: string; icon: React.ElementType };

const LABELS: Record<string, ToolLabel> = {
  sandbox_exec: { noun: 'command', verb: 'Ran', icon: Terminal },
  read_file: { noun: 'file', verb: 'Read', icon: FileText },
  write_file: { noun: 'file', verb: 'Wrote', icon: FileText },
  edit_range: { noun: 'file', verb: 'Edited', icon: FileText },
  replace: { noun: 'file', verb: 'Edited', icon: FileText },
  search: { noun: 'search', verb: 'Searched', icon: Search },
  repo_search: { noun: 'search', verb: 'Searched', icon: Search },
  repo_grep: { noun: 'search', verb: 'Searched', icon: Search },
  repo_read: { noun: 'file', verb: 'Read', icon: FileText },
  repo_ls: { noun: 'list', verb: 'Listed', icon: FileText },
  web_search: { noun: 'search', verb: 'Searched', icon: Globe },
  delegate_coder: { noun: 'task', verb: 'Delegated', icon: Hammer },
  delegate_explorer: { noun: 'task', verb: 'Delegated', icon: Hammer },
  default: { noun: 'tool', verb: 'Used', icon: Wrench },
};

function getLabel(toolName: string): ToolLabel {
  return LABELS[toolName] ?? LABELS.default;
}

/* ------------------------------------------------------------------ */
/*  Summary-line builder                                               */
/* ------------------------------------------------------------------ */

function buildSummaryLine(items: ToolCallPair[]): string {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = item.resultMsg.toolMeta?.toolName ?? item.callMsg.toolMeta?.toolName ?? 'unknown';
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  const phrases: string[] = [];
  for (const [name, count] of counts) {
    const { noun, verb } = getLabel(name);
    phrases.push(`${verb} ${count} ${noun}${count > 1 ? 's' : ''}`);
  }

  // Single tool → drop count, e.g. "Ran a command"
  if (phrases.length === 1) {
    const [name] = counts.keys();
    const { noun, verb } = getLabel(name);
    const cnt = counts.get(name)!;
    return cnt === 1 ? `${verb} a ${noun}` : phrases[0];
  }

  return phrases.join(', ');
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export const ToolCallSummary = memo(function ToolCallSummary({
  items,
  onCardAction,
}: ToolCallSummaryProps) {
  const [expanded, setExpanded] = useState(false);
  const summary = buildSummaryLine(items);

  return (
    <div className="my-0.5 px-4 animate-fade-in">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="flex items-center gap-1.5 text-push-xs text-push-fg-dim hover:text-push-fg-secondary transition-colors duration-150 group"
      >
        <ChevronRight
          className={`h-3 w-3 transition-transform duration-200 ${
            expanded ? 'rotate-90' : ''
          }`}
        />
        <span className="font-medium truncate max-w-[260px] sm:max-w-[360px]">{summary}</span>
      </button>

      {expanded && (
        <div className="mt-1.5 ml-5 space-y-2 border-l border-push-edge pl-3">
          {items.map((item, i) => {
            const toolName =
              item.resultMsg.toolMeta?.toolName ??
              item.callMsg.toolMeta?.toolName ??
              'unknown';
            const { icon: Icon } = getLabel(toolName);
            const duration = item.resultMsg.toolMeta?.durationMs;
            const isError = item.resultMsg.toolMeta?.isError;
            const cards =
              item.callMsg.cards?.filter((c) => c.type !== 'sandbox-state') ?? [];

            return (
              <div key={i} className="space-y-1.5">
                {/* Tool header */}
                <div className="flex items-center gap-1.5 text-push-2xs">
                  <Icon className={`h-3 w-3 ${isError ? 'text-red-400' : 'text-push-fg-dim'}`} />
                  <span className={`font-medium ${isError ? 'text-red-400' : 'text-push-fg-dim'}`}>
                    {toolName}
                  </span>
                  {duration != null && (
                    <span className="text-push-fg-muted">
                      {/* ms < 1000 → show raw ms, otherwise rounded seconds */}
                      ({duration < 1000 ? `${duration}ms` : `${(duration / 1000).toFixed(1)}s`})
                    </span>
                  )}
                  {isError && (
                    <AlertCircle className="h-3 w-3 text-red-400" />
                  )}
                </div>

                {/* Cards */}
                {cards.length > 0 && (
                  <div className="space-y-1">
                    {cards.map((card, ci) => (
                      <CardRenderer
                        key={ci}
                        card={card}
                        messageId={item.callMsg.id}
                        cardIndex={ci}
                        onAction={onCardAction}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
