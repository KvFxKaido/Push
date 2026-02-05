import { FileCode, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import type { TypeCheckCardData } from '@/types';

export function TypeCheckCard({ data }: { data: TypeCheckCardData }) {
  const passed = data.exitCode === 0;
  const Icon = passed ? CheckCircle2 : XCircle;
  const statusColor = passed ? 'text-[#22c55e]' : 'text-[#ef4444]';
  const statusBg = passed ? 'bg-[#22c55e]/10' : 'bg-[#ef4444]/10';

  const toolLabel = {
    tsc: 'TypeScript',
    pyright: 'Pyright',
    mypy: 'mypy',
    unknown: 'type check',
  }[data.tool];

  return (
    <div className="my-2 rounded-lg border border-[#1a1a1a] bg-[#0d0d0d] overflow-hidden max-w-full">
      {/* Header */}
      <div className={`px-3 py-2 flex items-center gap-2 border-b border-[#1a1a1a] ${statusBg}`}>
        <Icon className={`h-4 w-4 ${statusColor}`} />
        <span className={`text-[13px] font-medium ${statusColor}`}>
          {passed ? 'No Type Errors' : 'Type Errors Found'}
        </span>
        <span className="text-[12px] text-[#52525b]">{toolLabel}</span>
      </div>

      {/* Stats */}
      {(data.errorCount > 0 || data.warningCount > 0) && (
        <div className="px-3 py-2 flex items-center gap-4 border-b border-[#1a1a1a]">
          {data.errorCount > 0 && (
            <div className="flex items-center gap-1.5">
              <XCircle className="h-3.5 w-3.5 text-[#ef4444]" />
              <span className="text-[12px] text-[#e4e4e7]">
                {data.errorCount} error{data.errorCount !== 1 ? 's' : ''}
              </span>
            </div>
          )}
          {data.warningCount > 0 && (
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 text-[#f59e0b]" />
              <span className="text-[12px] text-[#e4e4e7]">
                {data.warningCount} warning{data.warningCount !== 1 ? 's' : ''}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Error list */}
      {data.errors.length > 0 && (
        <div className="divide-y divide-[#1a1a1a] max-h-[250px] overflow-y-auto">
          {data.errors.slice(0, 15).map((err, i) => (
            <div key={i} className="px-3 py-1.5">
              <div className="flex items-center gap-2 text-[12px]">
                <FileCode className="h-3 w-3 text-[#52525b] shrink-0" />
                <span className="text-[#0070f3] font-mono">
                  {err.file}:{err.line}
                  {err.column > 0 ? `:${err.column}` : ''}
                </span>
                {err.code && (
                  <span className="text-[#52525b] font-mono text-[11px]">{err.code}</span>
                )}
              </div>
              <p className="text-[11px] text-[#a1a1aa] mt-0.5 ml-5 truncate">{err.message}</p>
            </div>
          ))}
          {data.errors.length > 15 && (
            <div className="px-3 py-1.5 text-[11px] text-[#52525b]">
              +{data.errors.length - 15} more errors
            </div>
          )}
        </div>
      )}

      {data.truncated && (
        <div className="px-3 py-1.5 border-t border-[#1a1a1a] text-[11px] text-[#f59e0b]">
          Output truncated
        </div>
      )}
    </div>
  );
}
