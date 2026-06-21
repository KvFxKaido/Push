import { useEffect, useState } from 'react';
import { AlertCircle, Check, GitBranch, Loader2, Plus, X } from 'lucide-react';
import type { CommitReviewCardData, CardAction } from '@/types';
import { DiffPreviewCard } from './DiffPreviewCard';
import { AuditVerdictCard } from './AuditVerdictCard';
import {
  CARD_SHELL_CLASS,
  CARD_BUTTON_CLASS,
  CARD_INPUT_CLASS,
  CARD_PANEL_CLASS,
  CARD_HEADER_BG_SUCCESS,
  CARD_HEADER_BG_ERROR,
  CARD_HEADER_BG_INFO,
} from '@/lib/utils';
import { CommitPulseIcon } from '@/components/icons/push-custom-icons';

interface CommitReviewCardProps {
  data: CommitReviewCardData;
  messageId: string;
  cardIndex: number;
  onAction?: (action: CardAction) => void;
}

interface CommitMessageEditorProps {
  initialMessage: string;
  messageId: string;
  cardIndex: number;
  isError: boolean;
  /**
   * Push-kind card (Gate-at-Push): the commits already exist, so there is no
   * commit message to edit — hide the editor and never gate the actions on an
   * empty message (otherwise the SAFE push card can't be approved).
   */
  isPush: boolean;
  onAction?: (action: CardAction) => void;
}

function CommitMessageEditor({
  initialMessage,
  messageId,
  cardIndex,
  isError,
  isPush,
  onAction,
}: CommitMessageEditorProps) {
  const [editedMessage, setEditedMessage] = useState(initialMessage);

  const commitMessage = editedMessage.trim() || initialMessage;
  // A commit message is only required (and editable) for commit-kind cards.
  const actionsDisabled = !isPush && !editedMessage.trim();

  return (
    <>
      {!isPush && (
        <textarea
          value={editedMessage}
          onChange={(e) => setEditedMessage(e.target.value)}
          rows={1}
          placeholder="Enter commit message..."
          className={`${CARD_INPUT_CLASS} resize-none leading-relaxed`}
          style={{ minHeight: '38px', maxHeight: '80px' }}
          onInput={(e) => {
            const target = e.target as HTMLTextAreaElement;
            target.style.height = 'auto';
            target.style.height = Math.min(target.scrollHeight, 80) + 'px';
          }}
        />
      )}

      <div className="flex items-center gap-2 px-3 pb-3">
        <button
          onClick={() =>
            onAction?.({
              type: 'commit-approve',
              messageId,
              cardIndex,
              commitMessage,
            })
          }
          disabled={actionsDisabled}
          className={`${CARD_BUTTON_CLASS} h-11 flex-1 text-emerald-300`}
          style={{ minHeight: '44px' }}
        >
          <Check className="h-4 w-4" />
          {isError ? 'Try again' : 'Approve & Push'}
        </button>
        <button
          onClick={() =>
            onAction?.({
              type: 'commit-refresh',
              messageId,
              cardIndex,
              commitMessage,
            })
          }
          disabled={actionsDisabled}
          className={`${CARD_BUTTON_CLASS} h-11`}
          style={{ minHeight: '44px' }}
        >
          <Loader2 className="h-4 w-4" />
          Refresh
        </button>
        {!isError && (
          <button
            onClick={() =>
              onAction?.({
                type: 'commit-reject',
                messageId,
                cardIndex,
              })
            }
            className={`${CARD_BUTTON_CLASS} h-11`}
            style={{ minHeight: '44px' }}
          >
            <X className="h-4 w-4" />
            Reject
          </button>
        )}
      </div>
    </>
  );
}

// The green check that marks a commit landing on the remote plays the shared
// earned-success beat once. Encapsulated here (rather than inline in the header)
// so its replay guard sits next to the icon it guards, and so CommitReviewCard's
// own body stays hook-free. Keyed by the card's stable identity
// (messageId:cardIndex): the first time a given card commits it animates; a later
// Virtuoso scroll-remount (mountTime well past the recorded play) is suppressed,
// while an instant remount (StrictMode in dev) falls inside the window and
// re-plays — the same guard AuditVerdictCard uses for its SAFE shield.
const lastLanded = new Map<string, number>();
const REPLAY_SUPPRESS_MS = 1000;

function CommitLandedCheck({ messageId, cardIndex }: { messageId: string; cardIndex: number }) {
  const cardKey = `${messageId}:${cardIndex}`;
  const [mountTime] = useState(() => Date.now());
  const lastPlay = lastLanded.get(cardKey);
  const animate = lastPlay === undefined || mountTime - lastPlay < REPLAY_SUPPRESS_MS;

  useEffect(() => {
    if (animate) lastLanded.set(cardKey, Date.now());
  }, [animate, cardKey]);

  return (
    <Check
      className={`h-4 w-4 shrink-0 text-push-status-success${animate ? ' commit-landed-icon' : ''}`}
    />
  );
}

export function CommitReviewCard({ data, messageId, cardIndex, onAction }: CommitReviewCardProps) {
  const isPush = data.kind === 'push';
  const isPending = data.status === 'pending';
  const isRefreshing = data.status === 'refreshing';
  const isApproved = data.status === 'approved';
  const isPushing = data.status === 'pushing';
  const isCommitted = data.status === 'committed';
  const isRejected = data.status === 'rejected';
  const isError = data.status === 'error';
  const isBusy = isRefreshing || isApproved || isPushing;
  const defaultBranch = data.defaultBranch?.trim();
  const committedBranch = data.committedBranch?.trim();
  const showSwitchToDefault =
    isCommitted &&
    Boolean(defaultBranch) &&
    Boolean(committedBranch) &&
    committedBranch !== defaultBranch;

  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Header */}
      <div
        className={`px-3 py-2.5 flex items-center gap-2 ${
          isCommitted
            ? CARD_HEADER_BG_SUCCESS
            : isRejected
              ? CARD_HEADER_BG_INFO
              : isError
                ? CARD_HEADER_BG_ERROR
                : CARD_HEADER_BG_INFO
        }`}
      >
        {isCommitted ? (
          <CommitLandedCheck messageId={messageId} cardIndex={cardIndex} />
        ) : isRejected ? (
          <X className="h-4 w-4 shrink-0 text-push-fg-dim" />
        ) : isError ? (
          <AlertCircle className="h-4 w-4 shrink-0 text-push-status-error" />
        ) : isBusy ? (
          <Loader2 className="h-4 w-4 shrink-0 text-push-link animate-spin" />
        ) : (
          <CommitPulseIcon className="h-4 w-4 shrink-0 text-push-link" />
        )}
        <span
          className={`text-sm font-medium ${
            isCommitted
              ? 'text-push-status-success'
              : isRejected
                ? 'text-push-fg-dim'
                : isError
                  ? 'text-push-status-error'
                  : 'text-push-fg'
          }`}
        >
          {isCommitted
            ? 'Committed and pushed!'
            : isRejected
              ? 'Commit rejected'
              : isError
                ? 'Commit failed'
                : isRefreshing
                  ? 'Refreshing review…'
                  : isPushing
                    ? 'Pushing…'
                    : isApproved
                      ? 'Committing…'
                      : 'Review commit'}
        </span>
      </div>

      {/* Embedded diff preview */}
      <div className="px-3 py-2">
        <DiffPreviewCard data={data.diff} />
      </div>

      {/* Embedded audit verdict */}
      <div className="px-3 pb-2">
        <AuditVerdictCard data={data.auditVerdict} />
      </div>

      {/* Ref-only push plan summary (push-kind only) — what the push does to
          origin: creates the branch or fast-forwards it, and by how much. */}
      {isPush &&
        data.pushPlan &&
        (data.pushPlan.kind === 'create' || data.pushPlan.kind === 'fast-forward') && (
          <div className="flex items-center gap-1.5 px-3 pb-2 text-push-xs text-push-fg-dim">
            {data.pushPlan.kind === 'create' ? (
              <Plus className="h-3.5 w-3.5 shrink-0" />
            ) : (
              <GitBranch className="h-3.5 w-3.5 shrink-0" />
            )}
            <span>
              {data.pushPlan.kind === 'create' ? 'Creates this branch on origin' : 'Fast-forward'}
              {typeof data.pushPlan.ahead === 'number' && data.pushPlan.ahead > 0
                ? ` · ${data.pushPlan.ahead} commit${data.pushPlan.ahead === 1 ? '' : 's'} ahead`
                : ''}
            </span>
          </div>
        )}

      {isCommitted && (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-3">
          {showSwitchToDefault && defaultBranch && (
            <button
              onClick={() =>
                onAction?.({
                  type: 'commit-switch-default',
                  messageId,
                  cardIndex,
                  targetBranch: defaultBranch,
                })
              }
              className={`${CARD_BUTTON_CLASS} h-9 px-3 text-push-sky`}
            >
              <GitBranch className="h-3.5 w-3.5" />
              Switch to {defaultBranch}
            </button>
          )}
          <button
            onClick={() =>
              onAction?.({
                type: 'commit-fork-from-here',
                messageId,
                cardIndex,
                fromBranch: committedBranch,
              })
            }
            className={`${CARD_BUTTON_CLASS} h-9 px-3 text-push-link`}
          >
            <Plus className="h-3.5 w-3.5" />
            New branch from here
          </button>
        </div>
      )}

      {/* Commit message */}
      {/* Commit message section — commit-kind only; push-kind has no message. */}
      {!isPush && (
        <div className="px-3 pb-3">
          <div className="flex items-center justify-between mb-1.5">
            <label className="text-push-xs text-push-fg-dim font-medium">Commit message</label>
            {isPending && (
              <span className="text-push-2xs text-push-fg-dim italic">
                auto-filled · tap to edit
              </span>
            )}
          </div>
          {!(isPending || isError) && (
            <div className={`${CARD_PANEL_CLASS} px-3 py-2`}>
              <p className="text-push-base text-push-fg-secondary font-mono">
                {data.commitMessage}
              </p>
            </div>
          )}
        </div>
      )}
      {/* Action row — editor (commit-kind) or bare buttons (push-kind). */}
      {(isPending || isError) && (
        <CommitMessageEditor
          key={data.commitMessage}
          initialMessage={data.commitMessage}
          messageId={messageId}
          cardIndex={cardIndex}
          isError={isError}
          isPush={isPush}
          onAction={onAction}
        />
      )}

      {/* Error message */}
      {isError && data.error && (
        <div className="px-3 pb-3">
          <div className="rounded-[16px] border border-red-500/20 bg-red-500/10 px-3 py-2">
            <p className="text-push-sm text-push-status-error">{data.error}</p>
          </div>
        </div>
      )}

      {/* Busy state */}
      {isBusy && (
        <div className="flex items-center gap-2 px-3 pb-3">
          <div
            className={`${CARD_PANEL_CLASS} flex flex-1 items-center justify-center gap-1.5 px-4 py-2.5 text-push-base font-medium text-push-status-success opacity-70`}
            style={{ minHeight: '44px' }}
          >
            <Loader2 className="h-4 w-4 animate-spin" />
            {isRefreshing ? 'Refreshing review…' : isPushing ? 'Pushing…' : 'Committing…'}
          </div>
        </div>
      )}
    </div>
  );
}
