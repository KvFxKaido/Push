import { CheckCircle2, GitBranch, ShieldAlert, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ApprovalCardData, CardAction } from '@/types';
import {
  CARD_BUTTON_CLASS,
  CARD_HEADER_BG_ERROR,
  CARD_HEADER_BG_INFO,
  CARD_HEADER_BG_SUCCESS,
  CARD_HEADER_BG_WARNING,
  CARD_PANEL_CLASS,
  CARD_SHELL_CLASS,
} from '@/lib/utils';

interface ConfirmationCardProps {
  data: ApprovalCardData;
  messageId: string;
  cardIndex: number;
  onAction?: (action: CardAction) => void;
}

interface HeaderStyle {
  band: string;
  Icon: LucideIcon;
  iconClass: string;
  titleClass: string;
  title: string;
}

/** Header band + icon are an honest severity signal: amber for destructive /
 *  guard-bypass holds, sky for a remote change, green/red once resolved. */
function headerStyle(data: ApprovalCardData): HeaderStyle {
  if (data.status === 'approved') {
    return {
      band: CARD_HEADER_BG_SUCCESS,
      Icon: CheckCircle2,
      iconClass: 'text-push-status-success',
      titleClass: 'text-push-status-success',
      title: 'Approved',
    };
  }
  if (data.status === 'rejected') {
    return {
      band: CARD_HEADER_BG_ERROR,
      Icon: XCircle,
      iconClass: 'text-push-status-error',
      titleClass: 'text-push-status-error',
      title: 'Rejected',
    };
  }
  if (data.category === 'remote_side_effect') {
    return {
      band: CARD_HEADER_BG_INFO,
      Icon: GitBranch,
      iconClass: 'text-push-link',
      titleClass: 'text-push-fg',
      title: 'Approval needed',
    };
  }
  // destructive_sandbox · git_override · capability_violation → caution
  return {
    band: CARD_HEADER_BG_WARNING,
    Icon: ShieldAlert,
    iconClass: 'text-push-status-warning',
    titleClass: 'text-push-fg',
    title: 'Approval needed',
  };
}

export function ConfirmationCard({ data, messageId, cardIndex, onAction }: ConfirmationCardProps) {
  const resolved = data.status === 'approved' || data.status === 'rejected';
  const { band, Icon, iconClass, titleClass, title } = headerStyle(data);

  const decide = (approved: boolean) => {
    if (!onAction) return;
    onAction({
      type: approved ? 'approval-approve' : 'approval-reject',
      messageId,
      cardIndex,
      approvalId: data.approvalId,
    });
  };

  const lead = resolved
    ? data.status === 'approved'
      ? 'You approved this action.'
      : 'You rejected this action — it was not run.'
    : data.summary;

  return (
    <div className={CARD_SHELL_CLASS}>
      <div className={`px-3 py-2.5 flex items-center gap-2 ${band}`}>
        <Icon className={`h-4 w-4 shrink-0 ${iconClass}`} />
        <span className={`text-sm font-medium ${titleClass}`}>{title}</span>
      </div>

      <div className="px-3 py-3">
        <div className={`${CARD_PANEL_CLASS} px-3 py-3`}>
          <p className="text-push-base leading-relaxed text-push-fg">{lead}</p>
          {data.command && (
            <pre className="mt-2.5 overflow-x-auto whitespace-pre-wrap break-words rounded-[10px] border border-push-edge-subtle bg-black/30 px-2.5 py-2 font-mono text-push-sm text-push-fg">
              {data.command}
            </pre>
          )}
          {!resolved && data.reason && (
            <p className="mt-2.5 text-push-xs leading-relaxed text-push-fg-dim">{data.reason}</p>
          )}
        </div>
      </div>

      {!resolved && (
        <div className="flex items-center justify-end gap-2 px-3 pb-3">
          <button
            type="button"
            onClick={() => decide(false)}
            className={`${CARD_BUTTON_CLASS} h-8`}
            style={{ minHeight: '44px' }}
          >
            Reject
          </button>
          <button
            type="button"
            onClick={() => decide(true)}
            className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full border border-push-accent/40 bg-push-accent/10 px-3 text-push-sm font-medium text-push-accent transition-all duration-200 hover:border-push-accent/60 hover:brightness-110 active:scale-[0.98]"
            style={{ minHeight: '44px' }}
          >
            Approve
          </button>
        </div>
      )}
    </div>
  );
}
