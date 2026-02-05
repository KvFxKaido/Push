import { CheckCircle2, XCircle, MinusCircle } from 'lucide-react';
import type { TestResultsCardData } from '@/types';

export function TestResultsCard({ data }: { data: TestResultsCardData }) {
  const passed = data.exitCode === 0;
  const Icon = passed ? CheckCircle2 : XCircle;
  const statusColor = passed ? 'text-[#22c55e]' : 'text-[#ef4444]';
  const statusBg = passed ? 'bg-[#22c55e]/10' : 'bg-[#ef4444]/10';

  const frameworkLabel = {
    npm: 'npm test',
    pytest: 'pytest',
    cargo: 'cargo test',
    go: 'go test',
    unknown: 'tests',
  }[data.framework];

  return (
    <div className="my-2 rounded-lg border border-[#1a1a1a] bg-[#0d0d0d] overflow-hidden max-w-full">
      {/* Header */}
      <div className={`px-3 py-2 flex items-center gap-2 border-b border-[#1a1a1a] ${statusBg}`}>
        <Icon className={`h-4 w-4 ${statusColor}`} />
        <span className={`text-[13px] font-medium ${statusColor}`}>
          Tests {passed ? 'Passed' : 'Failed'}
        </span>
        <span className="text-[12px] text-[#52525b]">{frameworkLabel}</span>
        <span className="text-[11px] text-[#52525b] ml-auto">
          {(data.durationMs / 1000).toFixed(1)}s
        </span>
      </div>

      {/* Stats */}
      {data.total > 0 && (
        <div className="px-3 py-2 flex items-center gap-4 border-b border-[#1a1a1a]">
          <div className="flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-[#22c55e]" />
            <span className="text-[12px] text-[#e4e4e7]">{data.passed} passed</span>
          </div>
          {data.failed > 0 && (
            <div className="flex items-center gap-1.5">
              <XCircle className="h-3.5 w-3.5 text-[#ef4444]" />
              <span className="text-[12px] text-[#e4e4e7]">{data.failed} failed</span>
            </div>
          )}
          {data.skipped > 0 && (
            <div className="flex items-center gap-1.5">
              <MinusCircle className="h-3.5 w-3.5 text-[#52525b]" />
              <span className="text-[12px] text-[#e4e4e7]">{data.skipped} skipped</span>
            </div>
          )}
        </div>
      )}

      {/* Output preview */}
      <div className="px-3 py-2 max-h-[200px] overflow-y-auto">
        <pre className="text-[11px] text-[#a1a1aa] font-mono whitespace-pre-wrap break-all leading-relaxed">
          {data.output.slice(-2000)}
        </pre>
        {data.truncated && (
          <span className="text-[11px] text-[#f59e0b]">[output truncated]</span>
        )}
      </div>
    </div>
  );
}
