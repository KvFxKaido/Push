import { Globe, ExternalLink, AlertTriangle } from 'lucide-react';
import type { BrowserExtractCardData } from '@/types';

export function BrowserExtractCard({ data }: { data: BrowserExtractCardData }) {
  if (data.error) {
    return (
      <div className="my-2.5 max-w-full overflow-hidden rounded-xl border border-push-edge bg-[linear-gradient(180deg,#090d14_0%,#06090f_100%)] shadow-push-card">
        <div className="px-3 py-2 border-b border-push-edge bg-[#0b1018]">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-push-fg-secondary shrink-0" />
            <span className="text-[13px] text-[#e4e4e7] font-medium truncate">Extract failed</span>
          </div>
          <div className="mt-1 text-[11px] text-push-fg-muted break-all">
            {data.url}
          </div>
        </div>
        <div className="px-3 py-4 flex items-start gap-2.5">
          <AlertTriangle className="h-4 w-4 text-push-fg-secondary shrink-0 mt-0.5" />
          <div>
            <p className="text-[13px] text-push-fg-secondary leading-snug">{data.error.message}</p>
            <p className="mt-1 text-[11px] text-push-fg-dim">{data.error.code}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="my-2.5 max-w-full overflow-hidden rounded-xl border border-push-edge bg-[linear-gradient(180deg,#090d14_0%,#06090f_100%)] shadow-push-card">
      <div className="px-3 py-2 border-b border-push-edge bg-[#0b1018]">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-push-fg-secondary shrink-0" />
          <span className="text-[13px] text-[#e4e4e7] font-medium truncate">{data.title || 'Browser Extract'}</span>
        </div>
        <div className="mt-1 text-[11px] text-push-fg-muted break-all">
          {data.finalUrl || data.url}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-push-fg-dim">
          {data.statusCode !== null && <span>HTTP {data.statusCode}</span>}
          {data.truncated && <span>Content truncated</span>}
          <a
            href={data.finalUrl || data.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-push-fg-secondary hover:text-[#e4e4e7]"
          >
            Open
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        {data.instruction && (
          <p className="mt-1 text-[11px] text-push-fg-muted">
            Instruction: <span className="text-push-fg-secondary">{data.instruction}</span>
          </p>
        )}
      </div>

      <pre className="px-3 py-2 max-h-[280px] overflow-y-auto">
        <code className="font-mono text-[12px] text-[#d4d4d8] leading-relaxed whitespace-pre-wrap break-words">
          {data.content}
        </code>
      </pre>
    </div>
  );
}
