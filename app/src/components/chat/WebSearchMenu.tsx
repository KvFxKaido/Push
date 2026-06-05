import { useState } from 'react';
import { Globe } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  WEB_SEARCH_MODES,
  WEB_SEARCH_MODE_LABELS,
  getAutoNativeSearchLabel,
  getWebSearchMode,
  getWebSearchModeUnavailableReason,
  setWebSearchMode,
  type WebSearchMode,
} from '@/lib/web-search-mode';
import { getTavilyKey } from '@/hooks/useTavilyConfig';
import { getGoogleKey } from '@/hooks/useGoogleConfig';
import { getOllamaKey } from '@/hooks/useOllamaConfig';
import { getActiveProvider } from '@/lib/orchestrator-provider-routing';

interface WebSearchMenuProps {
  /** Shared header round-button class so the trigger matches sibling icons. */
  triggerClassName: string;
}

export function WebSearchMenu({ triggerClassName }: WebSearchMenuProps) {
  const activeProvider = getActiveProvider();
  const [mode, setMode] = useState<WebSearchMode>(() => getWebSearchMode());
  const [open, setOpen] = useState(false);

  // Re-read the pref on open so a setting change made elsewhere (Settings
  // sheet, tab restore) is reflected. Doing it in the onOpenChange handler
  // — not a useEffect — keeps it in the user's interaction tick.
  const handleOpenChange = (next: boolean) => {
    if (next) setMode(getWebSearchMode());
    setOpen(next);
  };

  const ctx = {
    activeProvider,
    hasTavilyKey: Boolean(getTavilyKey()),
    hasGoogleKey: Boolean(getGoogleKey()),
    hasOllamaKey: Boolean(getOllamaKey()),
  };

  const indicator = mode === 'off' ? null : mode === 'auto' ? 'auto' : 'on';

  // What "Auto" resolves to for the current chat: the active provider's
  // native web search (OpenRouter / Anthropic / Gemini), or null when the
  // provider has no native tool. Shown on the Auto row so the menu reflects
  // live state instead of hiding which native search is in play.
  const autoNativeLabel = getAutoNativeSearchLabel(activeProvider);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={triggerClassName}
          aria-label={`Web search: ${WEB_SEARCH_MODE_LABELS[mode]}`}
          title={`Web search: ${WEB_SEARCH_MODE_LABELS[mode]}`}
        >
          <Globe
            className={`relative z-10 h-3.5 w-3.5 ${mode === 'off' ? 'text-push-fg-dim' : ''}`}
          />
          {indicator && (
            <span
              className={`absolute top-1.5 right-1.5 h-2 w-2 rounded-full ${
                indicator === 'on' ? 'bg-push-accent' : 'bg-push-fg-dim'
              }`}
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={8}
        className="w-[240px] rounded-xl border border-push-edge bg-push-grad-panel p-2 text-push-fg-soft shadow-[0_12px_36px_rgba(0,0,0,0.55),0_4px_12px_rgba(0,0,0,0.25)]"
      >
        <div className="px-2 pt-1 pb-2 text-push-2xs font-medium uppercase tracking-wide text-push-fg-faint">
          Web search
        </div>
        <ul className="space-y-0.5">
          {WEB_SEARCH_MODES.map((option) => {
            const reason = getWebSearchModeUnavailableReason(option, ctx);
            const disabled = reason !== null;
            const selected = option === mode;
            return (
              <li key={option}>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    setWebSearchMode(option);
                    setMode(option);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-push-xs transition-colors ${
                    selected
                      ? 'bg-push-accent/15 text-push-accent'
                      : disabled
                        ? 'cursor-not-allowed text-push-fg-muted opacity-50'
                        : 'text-push-fg-secondary hover:bg-white/[0.04] hover:text-push-fg'
                  }`}
                  title={reason ?? undefined}
                  aria-pressed={selected}
                >
                  <span>{WEB_SEARCH_MODE_LABELS[option]}</span>
                  {disabled && reason ? (
                    <span className="ml-2 truncate text-push-2xs text-push-fg-dim">{reason}</span>
                  ) : option === 'auto' && autoNativeLabel ? (
                    <span className="ml-2 shrink-0 text-push-2xs text-push-fg-dim">
                      {autoNativeLabel}
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
