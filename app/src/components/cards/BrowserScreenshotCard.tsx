import { Globe, ExternalLink, AlertTriangle } from 'lucide-react';
import type { BrowserScreenshotCardData } from '@/types';
import { CARD_SHELL_CLASS } from '@/lib/utils';

export function BrowserScreenshotCard({ data }: { data: BrowserScreenshotCardData }) {
  if (data.error) {
    return (
      <div className={CARD_SHELL_CLASS}>
        <div className="px-3 py-2 border-b border-push-edge bg-[#0b1018]">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-push-fg-secondary shrink-0" />
            <span className="text-[13px] text-[#e4e4e7] font-medium truncate">Screenshot failed</span>
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

  const imageSrc = `data:${data.mimeType};base64,${data.imageBase64}`;

  return (
    <div className={CARD_SHELL_CLASS}>
      <div className="px-3 py-2 border-b border-push-edge bg-[#0b1018]">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-push-fg-secondary shrink-0" />
          <span className="text-[13px] text-[#e4e4e7] font-medium truncate">{data.title || 'Browser Screenshot'}</span>
        </div>
        <div className="mt-1 text-[11px] text-push-fg-muted break-all">
          {data.finalUrl || data.url}
        </div>
        <div className="mt-1 flex items-center gap-2 text-[11px] text-push-fg-dim">
          {data.statusCode !== null && <span>HTTP {data.statusCode}</span>}
          {data.truncated && <span>Image truncated</span>}
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
      </div>

      <div className="p-2">
        <img
          src={imageSrc}
          alt={`Screenshot of ${data.finalUrl || data.url}`}
          className="w-full rounded border border-push-edge bg-black"
          loading="lazy"
        />
      </div>
    </div>
  );
}
