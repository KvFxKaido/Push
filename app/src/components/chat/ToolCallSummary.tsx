import { memo, useState } from 'react';
import { ChevronRight, AlertCircle } from 'lucide-react';
import type { CardAction } from '@/types';
import { CardRenderer } from '@/components/cards/CardRenderer';
import { type ToolCallPair, getLabel, buildSummaryLine } from './tool-call-utils';

interface ToolCallSummaryProps {
  items: ToolCallPair[];
  onCardAction?: (action: CardAction) => void;
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
          className={`h-3 w-3 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="font-medium truncate max-w-[260px] sm:max-w-[360px]">{summary}</span>
      </button>

      {expanded && (
        <div className="mt-1.5 ml-5 space-y-2 border-l border-push-edge pl-3">
          {items.map((item, i) => {
            const toolName =
              item.resultMsg.toolMeta?.toolName ?? item.callMsg.toolMeta?.toolName ?? 'unknown';
            const { icon: Icon } = getLabel(toolName);
            const duration = item.resultMsg.toolMeta?.durationMs;
            const isError = item.resultMsg.toolMeta?.isError;
            const cards = item.callMsg.cards?.filter((c) => c.type !== 'sandbox-state') ?? [];

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
                      {/* ms < 1000 → show raw ms, otherwise rounded seconds */}(
                      {duration < 1000 ? `${duration}ms` : `${(duration / 1000).toFixed(1)}s`})
                    </span>
                  )}
                  {isError && <AlertCircle className="h-3 w-3 text-red-400" />}
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
