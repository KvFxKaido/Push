import { memo } from 'react';
import { AlertCircle, type LucideIcon } from 'lucide-react';
import type { CardAction } from '@/types';
import { CardRenderer } from '@/components/cards/CardRenderer';
import {
  ChainOfThought,
  ChainOfThoughtContent,
  ChainOfThoughtHeader,
  ChainOfThoughtStep,
} from '@/components/ai/chain-of-thought';
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

/** ms < 1000 → raw ms, otherwise rounded seconds. */
function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

/**
 * A collapsed tool-call group, rendered as a `ChainOfThought` step timeline —
 * each call is a node on the rail with its icon, name, target, and timing.
 * The primitive supplies the structure (icon nodes + connector rail + collapse
 * animation); the classNames restyle it into Push's terminal aesthetic (mono
 * machinery text, `push-*` tokens) rather than the primitive's default shadcn
 * look. `getLabel`'s icons are all lucide, so the casts to the primitive's
 * `LucideIcon` prop are sound.
 *
 * Every pair here is settled (a call is only grouped once its result lands —
 * see `groupChatMessages`), so steps render `complete`; in-flight calls live in
 * the streaming tail, not here. Errors recolor the row (the rail icon inherits
 * the row's `currentColor`).
 */
export const ToolCallSummary = memo(function ToolCallSummary({
  items,
  onCardAction,
}: ToolCallSummaryProps) {
  const summary = buildSummaryLine(items);
  // Representative glyph for the collapsed header — the group's first tool. A
  // homogeneous batch ("Read 3 files") leads with the file icon; a mixed group
  // leads with whatever ran first.
  const firstName =
    items[0]?.resultMsg.toolMeta?.toolName ?? items[0]?.callMsg.toolMeta?.toolName ?? 'unknown';
  const HeaderIcon = getLabel(firstName).icon as LucideIcon;

  // classNames restyle the primitive's default shadcn look into Push's mono
  // terminal aesthetic. The `text-push-*` size tokens override the primitive's
  // baked `text-sm` cleanly now that `cn` (lib/utils) registers that scale with
  // tailwind-merge.
  return (
    <ChainOfThought
      defaultOpen={false}
      className="my-0.5 max-w-none space-y-0 px-4 animate-fade-in"
    >
      <ChainOfThoughtHeader
        icon={HeaderIcon}
        className="font-mono font-medium text-push-xs text-push-fg-dim hover:text-push-fg-secondary"
      >
        {summary}
      </ChainOfThoughtHeader>

      <ChainOfThoughtContent className="mt-1.5 ml-1 space-y-2">
        {items.map((item, i) => {
          const toolName =
            item.resultMsg.toolMeta?.toolName ?? item.callMsg.toolMeta?.toolName ?? 'unknown';
          const { icon } = getLabel(toolName);
          const duration = item.resultMsg.toolMeta?.durationMs;
          const isError = item.resultMsg.toolMeta?.isError;
          const target = item.callMsg.toolMeta?.target ?? item.resultMsg.toolMeta?.target;
          // Keep original indices: card actions index into `callMsg.cards`.
          // Pending action cards are hoisted out of the collapsed group by the
          // segment renderer, so skip them here to avoid double-render.
          const visibleCards = (item.callMsg.cards ?? [])
            .map((card, originalIndex) => ({ card, originalIndex }))
            .filter(({ card }) => card.type !== 'sandbox-state' && !isPendingActionCard(card));

          return (
            <ChainOfThoughtStep
              // biome-ignore lint/suspicious/noArrayIndexKey: settled groups are
              // append-only; index is stable and pairs carry no stable id.
              key={i}
              icon={icon as LucideIcon}
              hasConnector={i < items.length - 1}
              // Override the primitive's default `text-sm text-muted-foreground`
              // with Push's mono machinery text; error rows go red so the rail
              // icon (inheriting currentColor) reads as failed at a glance.
              className={`gap-1.5 font-mono text-push-2xs ${
                isError ? 'text-red-400' : 'text-push-fg-dim'
              }`}
              label={
                <span className="flex items-center gap-1.5">
                  <span className="font-medium">{toolName}</span>
                  {target && (
                    <span
                      className={`${CARD_BADGE_INFO} min-w-0 max-w-[200px] truncate rounded-md px-1.5 py-0.5 text-push-2xs`}
                    >
                      {target}
                    </span>
                  )}
                  {duration != null && (
                    <span className="text-push-fg-muted">({formatDuration(duration)})</span>
                  )}
                  {isError && <AlertCircle className="h-3 w-3 shrink-0" />}
                </span>
              }
            >
              {visibleCards.length > 0 && (
                <div className="space-y-1">
                  {visibleCards.map(({ card, originalIndex }) => (
                    <CardRenderer
                      key={originalIndex}
                      card={card}
                      messageId={item.callMsg.id}
                      cardIndex={originalIndex}
                      onAction={onCardAction}
                    />
                  ))}
                </div>
              )}
            </ChainOfThoughtStep>
          );
        })}
      </ChainOfThoughtContent>
    </ChainOfThought>
  );
});
