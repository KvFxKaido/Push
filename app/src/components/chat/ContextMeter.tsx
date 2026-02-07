interface ContextMeterProps {
  used: number;
  max: number;
  percent: number;
}

export function ContextMeter({ used, percent }: ContextMeterProps) {
  // Only show when there's meaningful usage (> 5%)
  if (percent < 5) return null;

  const color =
    percent >= 80 ? 'bg-red-500' :
    percent >= 50 ? 'bg-yellow-500' :
    'bg-[#3f3f46]';

  const textColor =
    percent >= 80 ? 'text-red-400' :
    percent >= 50 ? 'text-yellow-500' :
    'text-[#52525b]';

  const label =
    used >= 1000 ? `${Math.round(used / 1000)}k` : `${used}`;

  return (
    <div className="flex items-center gap-2">
      <div className="h-1 w-12 rounded-full bg-[#1a1a1a] overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${color}`}
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </div>
      <span className={`text-[10px] tabular-nums ${textColor}`}>
        {label}
      </span>
    </div>
  );
}
