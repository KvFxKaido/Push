import type { CSSProperties } from 'react';
import { ArrowDown } from 'lucide-react';

/**
 * Shared scroll-to-bottom affordance. Identical markup across the plain and
 * virtualized paths so the two scroll containers present the same control.
 */
export function ScrollToBottomButton({
  visible,
  streaming = false,
  onClick,
}: {
  visible: boolean;
  /**
   * True while a response is still streaming. When the reader has scrolled away
   * (`visible`), a pulsing dot on the button surfaces that content is arriving
   * out of view — shadcn point 8, "show what's happening out of view" — so the
   * affordance reads as "new content below", not just "you can scroll down".
   */
  streaming?: boolean;
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
      aria-label={streaming ? 'Jump to latest (still responding)' : 'Scroll to bottom'}
    >
      <ArrowDown size={18} />
      {visible && streaming && (
        // Ping ring + solid core, on the accent token. Gated on `visible` too so
        // the `animate-ping` never churns offscreen while the button is hidden at
        // the live edge. `aria-hidden` because the streaming state is already
        // carried by the button's `aria-label`.
        <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 flex h-2.5 w-2.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-push-accent opacity-75" />
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-push-accent" />
        </span>
      )}
    </button>
  );
}
