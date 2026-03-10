import { useState } from 'react';
import { Check, X, Loader2, AlertCircle, GitCommit } from 'lucide-react';
import type { CommitReviewCardData, CardAction } from '@/types';
import { DiffPreviewCard } from './DiffPreviewCard';
import { AuditVerdictCard } from './AuditVerdictCard';
import { CARD_SHELL_CLASS } from '@/lib/utils';

interface CommitReviewCardProps {
  data: CommitReviewCardData;
  messageId: string;
  cardIndex: number;
  onAction?: (action: CardAction) => void;
}

export function CommitReviewCard({ data, messageId, cardIndex, onAction }: CommitReviewCardProps) {
  const [editedMessage, setEditedMessage] = useState(data.commitMessage);

  const isPending = data.status === 'pending';
  const isApproved = data.status === 'approved';
  const isPushing = data.status === 'pushing';
  const isCommitted = data.status === 'committed';
  const isRejected = data.status === 'rejected';
  const isError = data.status === 'error';
  const isBusy = isApproved || isPushing;

  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Header */}
      <div className={`px-3 py-2.5 flex items-center gap-2 ${
        isCommitted ? 'bg-push-status-success/5' :
        isRejected ? 'bg-push-fg-dim/10' :
        isError ? 'bg-push-status-error/5' :
        'bg-push-link/10'
      }`}>
        {isCommitted ? (
          <Check className="h-4 w-4 shrink-0 text-push-status-success" />
        ) : isRejected ? (
          <X className="h-4 w-4 shrink-0 text-push-fg-dim" />
        ) : isError ? (
          <AlertCircle className="h-4 w-4 shrink-0 text-push-status-error" />
        ) : isBusy ? (
          <Loader2 className="h-4 w-4 shrink-0 text-push-link animate-spin" />
        ) : (
          <GitCommit className="h-4 w-4 shrink-0 text-push-link" />
        )}
        <span className={`text-sm font-medium ${
          isCommitted ? 'text-push-status-success' :
          isRejected ? 'text-push-fg-dim' :
          isError ? 'text-push-status-error' :
          'text-push-fg'
        }`}>
          {isCommitted ? 'Committed and pushed!' :
           isRejected ? 'Commit rejected' :
           isError ? 'Commit failed' :
           isPushing ? 'Pushing…' :
           isApproved ? 'Committing…' :
           'Review commit'}
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

      {/* Commit message */}
      <div className="px-3 pb-3">
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-push-xs text-push-fg-dim font-medium">
            Commit message
          </label>
          {isPending && (
            <span className="text-push-2xs text-push-fg-dim italic">
              auto-filled · tap to edit
            </span>
          )}
        </div>
        {isPending ? (
          <textarea
            value={editedMessage}
            onChange={(e) => setEditedMessage(e.target.value)}
            rows={1}
            placeholder="Enter commit message..."
            className="w-full rounded-lg border border-push-edge bg-push-surface-inset px-3 py-2 text-push-base text-push-fg font-mono placeholder:text-push-fg-dim focus:outline-none focus:border-push-sky/50 resize-none leading-relaxed"
            style={{ minHeight: '38px', maxHeight: '80px' }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = 'auto';
              target.style.height = Math.min(target.scrollHeight, 80) + 'px';
            }}
          />
        ) : (
          <div className="rounded-lg border border-push-edge bg-push-surface-inset px-3 py-2">
            <p className="text-push-base text-push-fg-secondary font-mono">
              {data.commitMessage}
            </p>
          </div>
        )}
      </div>

      {/* Error message */}
      {isError && data.error && (
        <div className="px-3 pb-3">
          <p className="text-push-sm text-push-status-error">{data.error}</p>
        </div>
      )}

      {/* Actions */}
      {(isPending || isError) && (
        <div className="flex items-center gap-2 px-3 pb-3">
          <button
            onClick={() => onAction?.({
              type: 'commit-approve',
              messageId,
              cardIndex,
              commitMessage: editedMessage.trim() || data.commitMessage,
            })}
            disabled={!editedMessage.trim()}
            className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-push-status-success px-4 py-2.5 text-push-base font-medium text-[#0a0a0c] transition-all duration-200 hover:bg-push-status-success active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ minHeight: '44px' }}
          >
            <Check className="h-4 w-4" />
            {isError ? 'Try again' : 'Approve & Push'}
          </button>
          {!isError && (
            <button
              onClick={() => onAction?.({
                type: 'commit-reject',
                messageId,
                cardIndex,
              })}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-push-edge px-4 py-2.5 text-push-base font-medium text-push-fg-secondary transition-all duration-200 hover:bg-push-surface-active hover:text-push-fg active:scale-[0.98]"
              style={{ minHeight: '44px' }}
            >
              <X className="h-4 w-4" />
              Reject
            </button>
          )}
        </div>
      )}

      {/* Busy state */}
      {isBusy && (
        <div className="flex items-center gap-2 px-3 pb-3">
          <div className="flex-1 flex items-center justify-center gap-1.5 rounded-lg bg-push-status-success/20 px-4 py-2.5 text-push-base font-medium text-push-status-success opacity-60" style={{ minHeight: '44px' }}>
            <Loader2 className="h-4 w-4 animate-spin" />
            {isPushing ? 'Pushing…' : 'Committing…'}
          </div>
        </div>
      )}
    </div>
  );
}
