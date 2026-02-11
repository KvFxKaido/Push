import { useState } from 'react';
import { ChevronRight, Terminal, CheckCircle2, XCircle } from 'lucide-react';
import type { SandboxCardData } from '@/types';

export function SandboxCard({ data }: { data: SandboxCardData }) {
  const [expanded, setExpanded] = useState(data.exitCode !== 0);
  const isSuccess = data.exitCode === 0;

  return (
    <div className="my-2.5 max-w-full overflow-hidden rounded-xl border border-push-edge bg-[linear-gradient(180deg,#090d14_0%,#06090f_100%)] shadow-push-card">
      {/* Header */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full px-3.5 py-3 flex items-center gap-2.5 hover:bg-[#0d1119] transition-colors duration-200"
      >
        <Terminal className="h-4 w-4 shrink-0 text-push-fg-secondary" />
        <code className="flex-1 text-[13px] text-[#e4e4e7] font-mono text-left truncate">
          {data.command}
        </code>
        <div className="flex items-center gap-2 shrink-0">
          {data.durationMs !== undefined && (
            <span className="text-[11px] text-push-fg-dim font-mono">
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
            className={`h-3 w-3 text-push-fg-dim transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          />
        </div>
      </button>

      {/* Output */}
      {expanded && (
        <div className="border-t border-push-edge expand-in">
          {data.stdout && (
            <pre className="px-3 py-2 overflow-x-auto">
              <code className="font-mono text-[12px] text-push-fg-secondary leading-relaxed whitespace-pre-wrap break-all">
                {data.stdout}
              </code>
            </pre>
          )}
          {data.stderr && (
            <pre className="px-3 py-2 bg-[#05080e] overflow-x-auto">
              <code className="font-mono text-[12px] text-[#ef4444]/70 leading-relaxed whitespace-pre-wrap break-all">
                {data.stderr}
              </code>
            </pre>
          )}
          {data.truncated && (
            <div className="px-3 py-1.5 text-[11px] text-push-fg-dim italic border-t border-push-edge">
              Output truncated
            </div>
          )}
          {!data.stdout && !data.stderr && (
            <div className="px-3 py-2 text-[12px] text-push-fg-dim italic">
              No output
            </div>
          )}
        </div>
      )}
    </div>
  );
}
