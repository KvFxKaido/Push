import { useState } from 'react';
import { X } from 'lucide-react';
import { HUB_TOP_BANNER_STRIP_CLASS } from '@/components/chat/hub-styles';
import { isAprilFirst } from '@/lib/april-fools';

/**
 * A light-hearted Easter egg banner shown on April 1st as a playful nod to
 * GitHub Mobile's Copilot-tab announcement. Dismissed per-session via local
 * component state — no persistence needed.
 */
export function AprilFoolsBanner() {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed || !isAprilFirst()) return null;

  return (
    <div
      className={`mx-4 mt-4 flex items-start justify-between gap-3 rounded-xl px-3 py-2.5 ${HUB_TOP_BANNER_STRIP_CLASS} border-push-accent/20`}
      role="status"
      aria-label="April Fools notice"
    >
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-push-accent">
          Happy April 1st 🐙
        </p>
        <p className="mt-0.5 text-push-xs text-push-fg-dim leading-snug">
          GitHub Mobile just announced a &ldquo;Copilot tab with native session
          logs.&rdquo; We&rsquo;ve been doing this since day one.{' '}
          <span className="text-push-fg-secondary">Push on.</span>
        </p>
      </div>
      <button
        onClick={() => setDismissed(true)}
        aria-label="Dismiss April Fools notice"
        className="mt-0.5 shrink-0 text-push-fg-dim transition-colors hover:text-push-fg-secondary"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
