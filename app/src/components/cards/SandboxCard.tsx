import { useState } from 'react';
import { ChevronRight, Terminal, CheckCircle2, XCircle } from 'lucide-react';
import type { SandboxCardData } from '@/types';

export function SandboxCard({ data }: { data: SandboxCardData }) {
  const [expanded, setExpanded] = useState(data.exitCode !== 0);
  const isSuccess = data.exitCode === 0;

  return (
    <div className="my-2 rounded-lg border border-[#1a1a1e] bg-[#111113] overflow-hidden max-w-full">
      {/* Header */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full px-3 py-2.5 flex items-center gap-2 hover:bg-[#161618] transition-colors"
      >
        <Terminal className="h-4 w-4 shrink-0 text-[#a1a1aa]" />
        <code className="flex-1 text-[13px] text-[#e4e4e7] font-mono text-left truncate">
          {data.command}
        </code>
        <div className="flex items-center gap-2 shrink-0">
          {data.durationMs !== undefined && (
            <span className="text-[11px] text-[#52525b] font-mono">
              {data.durationMs < 1000 ? `${data.durationMs}ms` : `${(data.durationMs / 1000).toFixed(1)}s`}
            </span>
          )}
          {isSuccess ? (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full bg-[#22c55e]/15 text-[#22c55e]">
              <CheckCircle2 className="h-3 w-3" />
              0
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 text-[11px] font-medium px-1.5 py-0.5 rounded-full bg-[#ef4444]/15 text-[#ef4444]">
              <XCircle className="h-3 w-3" />
              {data.exitCode}
            </span>
          )}
          <ChevronRight
            className={`h-3 w-3 text-[#52525b] transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          />
        </div>
      </button>

      {/* Output */}
      {expanded && (
        <div className="border-t border-[#1a1a1e]">
          {data.stdout && (
            <pre className="px-3 py-2 overflow-x-auto">
              <code className="font-mono text-[12px] text-[#a1a1aa] leading-relaxed whitespace-pre-wrap break-all">
                {data.stdout}
              </code>
            </pre>
          )}
          {data.stderr && (
            <pre className="px-3 py-2 bg-[#0a0a0c] overflow-x-auto">
              <code className="font-mono text-[12px] text-[#ef4444]/70 leading-relaxed whitespace-pre-wrap break-all">
                {data.stderr}
              </code>
            </pre>
          )}
          {data.truncated && (
            <div className="px-3 py-1.5 text-[11px] text-[#52525b] italic border-t border-[#1a1a1e]">
              Output truncated
            </div>
          )}
          {!data.stdout && !data.stderr && (
            <div className="px-3 py-2 text-[12px] text-[#52525b] italic">
              No output
            </div>
          )}
        </div>
      )}
    </div>
  );
}
