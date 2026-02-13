import { useState } from 'react';
import { ChevronRight, Terminal, CheckCircle2, XCircle, Copy, Download, Check } from 'lucide-react';
import type { SandboxCardData } from '@/types';
import { CARD_SHELL_CLASS } from '@/lib/utils';

export function SandboxCard({ data }: { data: SandboxCardData }) {
  const [expanded, setExpanded] = useState(data.exitCode !== 0);
  const [copied, setCopied] = useState(false);
  const isSuccess = data.exitCode === 0;

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const output = [data.stdout, data.stderr].filter(Boolean).join('\n---\n');
    if (!output) return;
    navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    const output = [data.stdout, data.stderr].filter(Boolean).join('\n---\n');
    if (!output) return;
    const blob = new Blob([output], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `sandbox-output-${timestamp}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className={CARD_SHELL_CLASS}>
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
          {expanded && (data.stdout || data.stderr) && (
            <div className="flex items-center gap-1 mr-1">
              <button
                onClick={handleCopy}
                className="p-1 rounded-md text-push-fg-dim hover:text-push-fg-secondary hover:bg-white/5 transition-colors"
                title="Copy output"
              >
                {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
              </button>
              <button
                onClick={handleDownload}
                className="p-1 rounded-md text-push-fg-dim hover:text-push-fg-secondary hover:bg-white/5 transition-colors"
                title="Download output"
              >
                <Download className="h-3 w-3" />
              </button>
            </div>
          )}
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
