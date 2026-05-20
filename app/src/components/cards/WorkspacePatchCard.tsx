import { useMemo } from 'react';
import type { WorkspacePatchCardData, WorkspacePatchApplyState } from '@/types';
import type { DiffPreviewCardData } from '@/types';
import { parseDiffStats } from '@/lib/diff-utils';
import { DIFF_MAX_BYTES } from '@/lib/sandbox-client';
import { CARD_PANEL_CLASS } from '@/lib/utils';
import { DiffPreviewCard } from './DiffPreviewCard';

/**
 * WorkspacePatchCard — UI for persisted `workspace-patch` cards (PR 4 of
 * persist-diffs). Composes {@link DiffPreviewCard} for the diff body and
 * adds a state-specific footer that reflects the card's `applyState`.
 *
 * V1 silent-transition semantics from PR 3 are preserved — the card
 * itself is the UI surface for state, and language is intentionally
 * calm: `refused` reads as "the safe thing", not "failure".
 */

/** Suffix appended by {@link clampConflictDetail} when conflict detail
 *  was clipped at the storage cap. Mirrored here so the renderer can
 *  promote it from end-of-string text into a distinct visual marker
 *  rather than relying on the reader noticing trailing characters. */
const CONFLICT_DETAIL_TRUNCATION_SUFFIX = '\n…[truncated]';

export function WorkspacePatchCard({ data }: { data: WorkspacePatchCardData }) {
  // The persisted card has the raw diff but not the file/addition counts
  // that DiffPreviewCard renders in its header. Computing them at render
  // time avoids a schema bump and keeps older captured cards readable.
  const diffPreviewData = useMemo<DiffPreviewCardData>(() => {
    const stats = parseDiffStats(data.diffBytes);
    return {
      diff: data.diffBytes,
      filesChanged: stats.filesChanged,
      additions: stats.additions,
      deletions: stats.deletions,
      truncated: data.truncated,
    };
  }, [data.diffBytes, data.truncated]);

  return (
    <div className="flex flex-col gap-1.5">
      <DiffPreviewCard data={diffPreviewData} />
      <WorkspacePatchStatusRow applyState={data.applyState} />
    </div>
  );
}

type StatusTone = 'neutral' | 'success' | 'amber' | 'error';

const TONE_CLASS: Record<StatusTone, string> = {
  neutral: 'border-push-edge-subtle text-push-fg-secondary',
  success: 'border-push-status-success/30 text-push-status-success',
  amber: 'border-push-status-warning/30 text-push-status-warning',
  error: 'border-push-status-error/30 text-push-status-error',
};

interface StatusContent {
  tone: StatusTone;
  title: string;
  detail: string;
  conflictDetail?: string;
}

function statusContent(applyState: WorkspacePatchApplyState): StatusContent {
  switch (applyState.kind) {
    case 'pending':
      return {
        tone: 'neutral',
        title: 'Pending replay',
        detail: 'Will be attempted if this sandbox is replaced.',
      };
    case 'applied':
      // The reverse-check guard sets note='already-applied' when the
      // patch was already present in the new tree (snapshot edge case,
      // re-entry, etc.). Phrase it as the no-op it is.
      if (applyState.note === 'already-applied') {
        return {
          tone: 'success',
          title: 'Already applied',
          detail: 'The new sandbox already had these changes — nothing to replay.',
        };
      }
      return {
        tone: 'success',
        title: 'Replayed',
        detail: 'These changes were applied to the new sandbox.',
      };
    case 'refused':
      return {
        tone: 'amber',
        title: 'Replay refused',
        detail: refusalCopy(applyState.reason),
      };
    case 'conflict':
      return {
        tone: 'error',
        title: 'Replay produced a conflict',
        detail: 'Files in the new sandbox carry merge markers — resolve before continuing.',
        conflictDetail: applyState.detail,
      };
    default: {
      // Exhaustiveness check + runtime fallback. The validator in
      // protocol-schema.ts rejects unknown `kind` values at load
      // time, but a forward-compat card persisted by a newer client
      // could reach us if validation is bypassed — render the safe
      // thing instead of returning `undefined` and crashing the
      // status row.
      const _exhaustive: never = applyState;
      void _exhaustive;
      return {
        tone: 'amber',
        title: 'Unknown replay state',
        detail: "This card was written by a newer version of Push and can't be rendered here.",
      };
    }
  }
}

function refusalCopy(reason: 'truncated' | 'binary-placeholder' | 'base-mismatch'): string {
  switch (reason) {
    case 'truncated':
      return `The captured diff was clipped at ${formatCapKB(DIFF_MAX_BYTES)}, so it isn't safe to replay verbatim.`;
    case 'binary-placeholder':
      return "The captured diff includes binary changes that can't be replayed.";
    case 'base-mismatch':
      return 'Replay refused because the sandbox HEAD no longer matches the captured base.';
    default: {
      const _exhaustive: never = reason;
      void _exhaustive;
      return 'Replay refused.';
    }
  }
}

/** Format the diff cap as `"N KB"`. Sourced from {@link DIFF_MAX_BYTES}
 *  so the user-facing copy can't drift from the actual capture limit. */
function formatCapKB(bytes: number): string {
  return `${Math.round(bytes / 1024)} KB`;
}

function WorkspacePatchStatusRow({ applyState }: { applyState: WorkspacePatchApplyState }) {
  const content = statusContent(applyState);
  const toneClass = TONE_CLASS[content.tone];

  return (
    <div className={`${CARD_PANEL_CLASS} ${toneClass} px-3.5 py-2.5`}>
      <div className="flex flex-col gap-1">
        <div className="text-push-sm font-medium">{content.title}</div>
        <div className="text-push-xs text-push-fg-dim">{content.detail}</div>
        {content.conflictDetail !== undefined && (
          <ConflictDetailBlock detail={content.conflictDetail} />
        )}
      </div>
    </div>
  );
}

function ConflictDetailBlock({ detail }: { detail: string }) {
  const isTruncated = detail.endsWith(CONFLICT_DETAIL_TRUNCATION_SUFFIX);
  const body = isTruncated ? detail.slice(0, -CONFLICT_DETAIL_TRUNCATION_SUFFIX.length) : detail;

  return (
    <div className="mt-1.5 flex flex-col gap-1">
      <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-push-edge-subtle bg-push-bg-elevated/40 px-2.5 py-1.5 font-mono text-push-xs text-push-fg-secondary">
        {body}
      </pre>
      {isTruncated && (
        <div className="text-push-xs italic text-push-fg-dim">
          Conflict detail truncated for storage.
        </div>
      )}
    </div>
  );
}
