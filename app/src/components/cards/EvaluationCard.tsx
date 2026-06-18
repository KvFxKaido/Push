import { CircleCheck, CircleAlert } from 'lucide-react';
import type { EvaluationCardData } from '@/types';
import {
  CARD_SHELL_CLASS,
  CARD_TEXT_SUCCESS,
  CARD_TEXT_WARNING,
  CARD_HEADER_BG_SUCCESS,
  CARD_HEADER_BG_WARNING,
  CARD_PANEL_SUBTLE_CLASS,
} from '@/lib/utils';

/**
 * Renders the inline lead's completion-evaluation verdict. This is the
 * task-completion gate (`complete | incomplete`) — distinct from the
 * commit-safety `audit-verdict` card. The inline lane only ever attaches this
 * card for an `incomplete` verdict (a `complete` turn surfaces no card), but
 * the component handles both for completeness.
 */
export function EvaluationCard({ data }: { data: EvaluationCardData }) {
  const isComplete = data.verdict === 'complete';

  return (
    <div className={CARD_SHELL_CLASS}>
      <div
        className={`px-3.5 py-3 flex items-center gap-2.5 ${
          isComplete ? CARD_HEADER_BG_SUCCESS : CARD_HEADER_BG_WARNING
        }`}
      >
        {isComplete ? (
          <CircleCheck className={`h-4 w-4 shrink-0 ${CARD_TEXT_SUCCESS}`} />
        ) : (
          <CircleAlert className={`h-4 w-4 shrink-0 ${CARD_TEXT_WARNING}`} />
        )}
        <span
          className={`text-sm font-medium ${isComplete ? CARD_TEXT_SUCCESS : CARD_TEXT_WARNING}`}
        >
          {isComplete ? 'Complete' : 'Needs follow-up'}
        </span>
      </div>

      <div className="px-3 py-2">
        <p className="text-push-base text-push-fg-secondary leading-relaxed">{data.summary}</p>
      </div>

      {data.gaps.length > 0 && (
        <div className="px-3 pb-2.5 space-y-1.5">
          {data.gaps.map((gap, i) => (
            <div
              key={i}
              className={`${CARD_PANEL_SUBTLE_CLASS} flex items-start gap-2 px-2.5 py-2`}
            >
              <CircleAlert className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${CARD_TEXT_WARNING}`} />
              <span className="text-push-sm text-push-fg-secondary leading-relaxed">{gap}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
