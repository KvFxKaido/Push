interface ContextMeterProps {
  used: number;
  max: number;
  percent: number;
}

// The runtime starts compacting the working window once it approaches the
// model's context budget (~85% of the budget; see `lib/context-budget.ts`).
// The meter's job is to make that approach legible *before* it happens, so the
// thresholds below are tuned to that boundary rather than a generic 50/80
// split: amber as it fills, red + pulse once compaction is imminent.
const COMPACTION_NEAR_PERCENT = 80;
const FILLING_PERCENT = 55;

export function ContextMeter({ used, percent }: ContextMeterProps) {
  // Only show when there's meaningful usage (> 5%)
  if (percent < 5) return null;

  const nearCompaction = percent >= COMPACTION_NEAR_PERCENT;

  const color = nearCompaction
    ? 'bg-red-500'
    : percent >= FILLING_PERCENT
      ? 'bg-amber-500'
      : 'bg-push-edge-hover';

  const textColor = nearCompaction
    ? 'text-red-400'
    : percent >= FILLING_PERCENT
      ? 'text-amber-500'
      : 'text-push-fg-dim';

  const label = used >= 1000 ? `${Math.round(used / 1000)}k` : `${used}`;

  return (
    <div
      className="flex items-center gap-2"
      title={
        nearCompaction
          ? `Context ~${percent}% full — the runtime will compact older turns soon`
          : `Context ~${percent}% full`
      }
    >
      <div className="h-1 w-12 rounded-full bg-push-edge overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color} ${
            nearCompaction ? 'animate-pulse' : ''
          }`}
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </div>
      <span className={`text-push-2xs tabular-nums ${textColor}`}>{label}</span>
    </div>
  );
}
