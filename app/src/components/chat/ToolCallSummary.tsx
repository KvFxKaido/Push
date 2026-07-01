import { memo } from 'react';
import { ChevronDown, AlertCircle } from 'lucide-react';
import type { CardAction } from '@/types';
import { CardRenderer } from '@/components/cards/CardRenderer';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { CARD_BADGE_INFO } from '@/lib/utils';
import {
  type ToolCallPair,
  getLabel,
  buildSummaryLine,
  isPendingActionCard,
} from './tool-call-utils';

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
  const summary = buildSummaryLine(items);

  return (
    <div className="my-0.5 px-4 animate-fade-in">
      <Collapsible defaultOpen={false}>
        <CollapsibleTrigger asChild className="group">
          <button className="flex items-center gap-1.5 text-push-xs text-push-fg-dim hover:text-push-fg-secondary transition-colors duration-150">
            <span className="font-mono font-medium truncate max-w-[260px] sm:max-w-[360px]">
              {summary}
            </span>
            <ChevronDown className="h-3 w-3 transition-transform duration-200 group-data-[state=open]:rotate-180" />
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent className="outline-none data-[state=closed]:animate-out data-[state=open]:animate-in data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2">
          <div className="mt-1.5 ml-5 space-y-2 border-l border-push-edge pl-3">
            {items.map((item, i) => {
              const toolName =
                item.resultMsg.toolMeta?.toolName ?? item.callMsg.toolMeta?.toolName ?? 'unknown';
              const { icon: Icon } = getLabel(toolName);
              const duration = item.resultMsg.toolMeta?.durationMs;
              const isError = item.resultMsg.toolMeta?.isError;
              const target = item.callMsg.toolMeta?.target ?? item.resultMsg.toolMeta?.target;
              // Keep original indices: card actions index into `callMsg.cards`.
              // Pending action cards are hoisted out of the collapsed group by
              // the segment renderer, so skip them here to avoid double-render.
              const cards = (item.callMsg.cards ?? []).map((card, originalIndex) => ({
                card,
                originalIndex,
              }));

              return (
                <div key={i} className="space-y-1.5">
                  {/* Tool header — mono so tool names + timings read as terminal
                      machinery, rhyming with the TUI (CardRenderer output below
                      keeps its own formatting). The target (file/command) gets
                      its own badge so it reads apart from the verb. */}
                  <div className="flex items-center gap-1.5 text-push-2xs font-mono">
                    <Icon className={`h-3 w-3 ${isError ? 'text-red-400' : 'text-push-fg-dim'}`} />
                    <span
                      className={`font-medium ${isError ? 'text-red-400' : 'text-push-fg-dim'}`}
                    >
                      {toolName}
                    </span>
                    {target && (
                      <span
                        className={`${CARD_BADGE_INFO} min-w-0 max-w-[200px] truncate rounded-md px-1.5 py-0.5 text-push-2xs`}
                      >
                        {target}
                      </span>
                    )}
                    {duration != null && (
                      <span className="text-push-fg-muted">
                        {/* ms < 1000 → show raw ms, otherwise rounded seconds */}(
                        {duration < 1000 ? `${duration}ms` : `${(duration / 1000).toFixed(1)}s`})
                      </span>
                    )}
                    {isError && <AlertCircle className="h-3 w-3 text-red-400" />}
                  </div>

                  {/* Cards — sandbox-state is internal; pending action cards are
                      hoisted out of the collapsed group and rendered prominently. */}
                  {cards.some(
                    ({ card }) => card.type !== 'sandbox-state' && !isPendingActionCard(card),
                  ) && (
                    <div className="space-y-1">
                      {cards.map(({ card, originalIndex }) =>
                        card.type === 'sandbox-state' || isPendingActionCard(card) ? null : (
                          <CardRenderer
                            key={originalIndex}
                            card={card}
                            messageId={item.callMsg.id}
                            cardIndex={originalIndex}
                            onAction={onCardAction}
                          />
                        ),
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
});
