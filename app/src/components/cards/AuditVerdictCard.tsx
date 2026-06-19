import { useEffect, useState } from 'react';
import { ShieldCheck, ShieldAlert } from 'lucide-react';
import type { AuditVerdictCardData } from '@/types';
import {
  CARD_SHELL_CLASS,
  CARD_TEXT_SUCCESS,
  CARD_TEXT_ERROR,
  CARD_BADGE_SUCCESS,
  CARD_BADGE_WARNING,
  CARD_BADGE_ERROR,
  CARD_HEADER_BG_SUCCESS,
  CARD_HEADER_BG_ERROR,
  CARD_PANEL_SUBTLE_CLASS,
} from '@/lib/utils';
import { getRoleLabel } from '@push/lib/role-display';

const riskColors = {
  low: CARD_BADGE_SUCCESS,
  medium: CARD_BADGE_WARNING,
  high: CARD_BADGE_ERROR,
};

// SAFE verdicts play a one-shot pop+glow on arrival. The transcript virtualizes
// (react-virtuoso), so this card unmounts/remounts as it scrolls, and StrictMode
// remounts it once in dev — both would replay a naive mount animation. The data
// carries no id, so key on its content and record when each distinct verdict last
// celebrated. Suppress a replay only when the previous play was long enough ago to
// be a real scroll-back; an instant remount (StrictMode, or scroll jitter) falls
// inside the window and re-animates, so the beat is still visible in dev.
const lastCelebrated = new Map<string, number>();
const REPLAY_SUPPRESS_MS = 1000;

export function AuditVerdictCard({ data }: { data: AuditVerdictCardData }) {
  const isSafe = data.verdict === 'safe';
  const sig = `${data.verdict}|${data.filesReviewed}|${data.summary}`;

  // When this card instance mounted. Captured in a lazy initializer (render-safe
  // per react-hooks/purity — the same pattern AgentStatusBar uses) so we have a
  // comparable "now" without calling Date.now() in the render body.
  const [mountTime] = useState(() => Date.now());

  // Decide in render so the icon paints with the class on the first frame — the
  // keyframe starts at opacity:0, so applying it post-paint would flash the
  // settled icon first. Suppress only when this instance mounted well after the
  // last play (a real scroll-back); an instant remount falls inside the window
  // and re-animates. The effect records the play time after commit.
  const lastPlay = lastCelebrated.get(sig);
  const animateSafe =
    isSafe && (lastPlay === undefined || mountTime - lastPlay < REPLAY_SUPPRESS_MS);

  useEffect(() => {
    if (animateSafe) lastCelebrated.set(sig, Date.now());
  }, [animateSafe, sig]);

  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Verdict header */}
      <div
        className={`px-3.5 py-3 flex items-center gap-2.5 ${isSafe ? CARD_HEADER_BG_SUCCESS : CARD_HEADER_BG_ERROR}`}
      >
        {isSafe ? (
          <ShieldCheck
            className={`h-4 w-4 shrink-0 ${CARD_TEXT_SUCCESS} ${animateSafe ? 'verdict-safe-icon' : ''}`}
          />
        ) : (
          <ShieldAlert className={`h-4 w-4 shrink-0 ${CARD_TEXT_ERROR}`} />
        )}
        <span className={`text-sm font-medium ${isSafe ? CARD_TEXT_SUCCESS : CARD_TEXT_ERROR}`}>
          {isSafe ? 'SAFE' : 'UNSAFE'} — {getRoleLabel('auditor')} Verdict
        </span>
        <span className="ml-auto text-push-xs text-push-fg-dim">
          {data.filesReviewed} file{data.filesReviewed !== 1 ? 's' : ''} reviewed
        </span>
      </div>

      {/* Summary */}
      <div className="px-3 py-2">
        <p className="text-push-base text-push-fg-secondary leading-relaxed">{data.summary}</p>
      </div>

      {/* Risks */}
      {data.risks.length > 0 && (
        <div className="px-3 pb-2 space-y-1.5">
          {data.risks.map((risk, i) => (
            <div
              key={i}
              className={`${CARD_PANEL_SUBTLE_CLASS} flex items-start gap-2 px-2.5 py-2`}
            >
              <span
                className={`inline-flex items-center text-push-2xs font-medium px-1.5 py-0.5 rounded-full mt-0.5 shrink-0 uppercase ${riskColors[risk.level]}`}
              >
                {risk.level}
              </span>
              <span className="text-push-sm text-push-fg-secondary leading-relaxed">
                {risk.description}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
