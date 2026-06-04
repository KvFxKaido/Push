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
  return (
    <button
      onClick={onClick}
      className={`
        absolute left-1/2 -translate-x-1/2 bottom-8
        flex items-center justify-center
        w-10 h-10
        rounded-full
        z-20
        border border-push-edge
        bg-push-grad-card
        text-push-fg-secondary
        shadow-push-lg backdrop-blur-sm
        transition-all duration-300 ease-out
        hover:border-push-edge-hover hover:text-push-fg hover:shadow-push-xl
        spring-press
        ${visible ? 'opacity-100 translate-y-0 pointer-events-auto' : 'opacity-0 translate-y-3 pointer-events-none'}
      `}
      aria-label="Scroll to bottom"
    >
      <ArrowDown size={18} />
    </button>
  );
}
