import type { CSSProperties } from 'react';
import { ArrowDown } from 'lucide-react';

/**
 * Shared scroll-to-bottom affordance. Identical markup across the plain and
 * virtualized paths so the two scroll containers present the same control.
 */
export function ScrollToBottomButton({
  visible,
  onClick,
}: {
  visible: boolean;
  onClick: () => void;
}) {
  // Reveal uses the shared `.panel-reveal` primitive (Y-slide + fade +
  // cross-blur on the `--panel-*` tokens) driven by `data-open`, so this floats
  // in on the same motion as the sheets. Horizontal centering uses `left-1/2`
  // + `-ml-5` (half of `w-10`) rather than `-translate-x-1/2`, because
  // panel-reveal owns the `transform` (translateY) and the two can't share it.
  // `--panel-translate-y` overrides the throw to `--distance-medium` (12px).
  return (
    <button
      onClick={onClick}
      data-open={visible}
      style={{ '--panel-translate-y': 'var(--distance-medium)' } as CSSProperties}
      className={`
        panel-reveal
        absolute left-1/2 -ml-5 bottom-8
        flex items-center justify-center
        w-10 h-10
        rounded-full
        z-20
        border border-push-edge
        bg-push-grad-card
        text-push-fg-secondary
        shadow-push-lg backdrop-blur-sm
        hover:border-push-edge-hover hover:text-push-fg hover:shadow-push-xl
        spring-press
      `}
      aria-label="Scroll to bottom"
    >
      <ArrowDown size={18} />
    </button>
  );
}
