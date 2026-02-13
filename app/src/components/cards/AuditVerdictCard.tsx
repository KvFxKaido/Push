import { ShieldCheck, ShieldAlert } from 'lucide-react';
import type { AuditVerdictCardData } from '@/types';
import { CARD_SHELL_CLASS } from '@/lib/utils';

const riskColors = {
  low: 'bg-[#22c55e]/15 text-[#22c55e]',
  medium: 'bg-[#f59e0b]/15 text-[#f59e0b]',
  high: 'bg-[#ef4444]/15 text-[#ef4444]',
};

export function AuditVerdictCard({ data }: { data: AuditVerdictCardData }) {
  const isSafe = data.verdict === 'safe';

  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Verdict header */}
      <div className={`px-3.5 py-3 flex items-center gap-2.5 ${isSafe ? 'bg-[#22c55e]/5' : 'bg-[#ef4444]/5'}`}>
        {isSafe ? (
          <ShieldCheck className="h-4 w-4 shrink-0 text-[#22c55e]" />
        ) : (
          <ShieldAlert className="h-4 w-4 shrink-0 text-[#ef4444]" />
        )}
        <span className={`text-sm font-medium ${isSafe ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
          {isSafe ? 'SAFE' : 'UNSAFE'} — Auditor Verdict
        </span>
        <span className="ml-auto text-[11px] text-push-fg-dim">
          {data.filesReviewed} file{data.filesReviewed !== 1 ? 's' : ''} reviewed
        </span>
      </div>

      {/* Summary */}
      <div className="px-3 py-2">
        <p className="text-[13px] text-push-fg-secondary leading-relaxed">
          {data.summary}
        </p>
      </div>

      {/* Risks */}
      {data.risks.length > 0 && (
        <div className="px-3 pb-2 space-y-1">
          {data.risks.map((risk, i) => (
            <div key={i} className="flex items-start gap-2">
              <span className={`inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded-full mt-0.5 shrink-0 uppercase ${riskColors[risk.level]}`}>
                {risk.level}
              </span>
              <span className="text-[12px] text-push-fg-secondary leading-relaxed">
                {risk.description}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
