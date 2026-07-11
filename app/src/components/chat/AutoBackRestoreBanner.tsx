import { Loader2, RotateCcw, X } from 'lucide-react';
import {
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_TOP_BANNER_STRIP_CLASS,
} from '@/components/chat/hub-styles';

interface AutoBackRestoreBannerProps {
  summary: string;
  restoring: boolean;
  error: string | null;
  onRestore: () => void;
  onDismiss: () => void;
}

function formatRestoreLabel(summary: string): string {
  const match = /^(\d+)\s+files?\s+changed\b/.exec(summary.trim());
  if (!match) return 'Uncommitted changes';
  const count = Number(match[1]);
  return `${count} uncommitted ${count === 1 ? 'change' : 'changes'}`;
}

export function AutoBackRestoreBanner({
  summary,
  restoring,
  error,
  onRestore,
  onDismiss,
}: AutoBackRestoreBannerProps) {
  const label = formatRestoreLabel(summary);
  const verb = label.startsWith('1 ') ? 'is' : 'are';

  return (
    <div
      data-push-toast-clearance
      className={`mx-4 mt-5 flex items-center justify-between gap-3 px-1 py-2.5 ${HUB_TOP_BANNER_STRIP_CLASS} border-sky-500/25`}
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-sky-200">
          {label} from your last auto-backup {verb} available
        </p>
        <p className="mt-0.5 truncate text-push-xs text-sky-200/60">
          {error || summary || 'Recovered backup differs from HEAD.'}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <button
          type="button"
          onClick={onRestore}
          disabled={restoring}
          className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} gap-1.5 px-3 text-sky-200`}
        >
          {restoring ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <RotateCcw className="h-3 w-3" />
          )}
          <span>{restoring ? 'Restoring...' : 'Restore'}</span>
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="flex h-7 w-7 items-center justify-center rounded-full text-sky-200/40 transition-colors hover:bg-sky-900/20 hover:text-sky-200/70 active:scale-95"
          aria-label="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
