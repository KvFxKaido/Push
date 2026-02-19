import { Globe, ExternalLink } from 'lucide-react';
import type { WebSearchCardData } from '@/types';
import { CARD_SHELL_CLASS, CARD_LIST_CLASS } from '@/lib/utils';

export function WebSearchCard({ data }: { data: WebSearchCardData }) {
  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Header */}
      <div className="px-3 py-2 flex items-center gap-2 border-b border-push-edge">
        <Globe className="h-3.5 w-3.5 text-push-fg-secondary" />
        <span className="text-[13px] font-medium text-push-fg">
          {data.results.length} result{data.results.length !== 1 ? 's' : ''} for "{data.query}"
        </span>
      </div>

      {/* Results */}
      <div className={`${CARD_LIST_CLASS} max-h-[300px] overflow-y-auto`}>
        {data.results.map((result, i) => (
          <a
            key={i}
            href={result.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block px-3 py-2 hover:bg-push-surface/50 transition-colors"
          >
            <div className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[13px] text-push-link font-medium truncate">
                    {result.title}
                  </span>
                  <ExternalLink className="h-3 w-3 text-push-fg-dim shrink-0" />
                </div>
                <p className="text-[12px] text-push-fg-dim mt-0.5 line-clamp-2">
                  {result.content}
                </p>
              </div>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
