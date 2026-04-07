import { Bot, CheckCircle2, Clock3, Search, TriangleAlert, Workflow } from 'lucide-react';
import type { DelegationResultCardData } from '@/types';
import {
  CARD_BADGE_ERROR,
  CARD_BADGE_INFO,
  CARD_BADGE_SUCCESS,
  CARD_BADGE_WARNING,
  CARD_HEADER_BG_ERROR,
  CARD_HEADER_BG_SUCCESS,
  CARD_HEADER_BG_WARNING,
  CARD_LIST_CLASS,
  CARD_PANEL_SUBTLE_CLASS,
  CARD_SHELL_CLASS,
  CARD_TEXT_ERROR,
  CARD_TEXT_SUCCESS,
  CARD_TEXT_WARNING,
  formatElapsedTime,
} from '@/lib/utils';
import { useExpandable } from '@/hooks/useExpandable';
import { ExpandChevron, ExpandableCardPanel } from './expandable';

function getAgentLabel(agent: DelegationResultCardData['agent']): string {
  switch (agent) {
    case 'explorer':
      return 'Explorer';
    case 'coder':
      return 'Coder';
    case 'task_graph':
      return 'Task Graph';
  }
}

const AGENT_ICONS: Record<DelegationResultCardData['agent'], typeof Search> = {
  explorer: Search,
  coder: Bot,
  task_graph: Workflow,
};

function getStatusLabel(status: DelegationResultCardData['status']): string {
  switch (status) {
    case 'complete':
      return 'Complete';
    case 'incomplete':
      return 'Needs follow-up';
    case 'inconclusive':
      return 'Stopped early';
  }
}

function getStatusClasses(status: DelegationResultCardData['status']) {
  switch (status) {
    case 'complete':
      return {
        header: CARD_HEADER_BG_SUCCESS,
        text: CARD_TEXT_SUCCESS,
        badge: CARD_BADGE_SUCCESS,
      };
    case 'incomplete':
      return {
        header: CARD_HEADER_BG_WARNING,
        text: CARD_TEXT_WARNING,
        badge: CARD_BADGE_WARNING,
      };
    case 'inconclusive':
      return {
        header: CARD_HEADER_BG_ERROR,
        text: CARD_TEXT_ERROR,
        badge: CARD_BADGE_ERROR,
      };
  }
}

export function DelegationResultCard({ data }: { data: DelegationResultCardData }) {
  const { expanded, toggleExpanded } = useExpandable(false);
  const AgentIcon = AGENT_ICONS[data.agent];
  const status = getStatusClasses(data.status);
  const auditorVerdict = data.gateVerdicts.find((verdict) => verdict.gate === 'auditor');
  const hasDetails = Boolean(
    data.verifiedText
      || data.openText
      || data.missingRequirements.length > 0
      || data.nextRequiredAction
      || data.gateVerdicts.length > 0,
  );

  return (
    <div className={CARD_SHELL_CLASS}>
      <button
        type="button"
        onClick={hasDetails ? toggleExpanded : undefined}
        className="w-full text-left"
      >
        <div className={`flex items-center gap-2.5 border-b border-push-edge px-3.5 py-3 ${status.header}`}>
          <AgentIcon className={`h-4 w-4 shrink-0 ${status.text}`} />
          <span className={`text-push-base font-medium ${status.text}`}>
            {getAgentLabel(data.agent)}
          </span>
          <span className={`rounded-full px-2 py-0.5 text-push-2xs font-medium uppercase ${status.badge}`}>
            {getStatusLabel(data.status)}
          </span>
          {hasDetails && <ExpandChevron expanded={expanded} className="ml-auto" />}
        </div>

        <div className="px-3.5 py-3">
          <p className="text-push-base leading-relaxed text-push-fg-secondary">
            {data.summary}
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            {typeof data.fileCount === 'number' && (
              <span className={`rounded-full px-2 py-0.5 text-push-2xs font-medium ${CARD_BADGE_INFO}`}>
                {data.fileCount} file{data.fileCount === 1 ? '' : 's'} changed
              </span>
            )}
            {typeof data.taskCount === 'number' && (
              <span className={`rounded-full px-2 py-0.5 text-push-2xs font-medium ${CARD_BADGE_INFO}`}>
                {data.taskCount} task{data.taskCount === 1 ? '' : 's'}
              </span>
            )}
            {typeof data.checksTotal === 'number' && data.checksTotal > 0 && (
              <span className={`rounded-full px-2 py-0.5 text-push-2xs font-medium ${data.checksPassed === data.checksTotal ? CARD_BADGE_SUCCESS : CARD_BADGE_WARNING}`}>
                {data.checksPassed}/{data.checksTotal} checks
              </span>
            )}
            {auditorVerdict && (
              <span className={`rounded-full px-2 py-0.5 text-push-2xs font-medium ${
                auditorVerdict.outcome === 'passed'
                  ? CARD_BADGE_SUCCESS
                  : auditorVerdict.outcome === 'failed'
                    ? CARD_BADGE_ERROR
                    : CARD_BADGE_WARNING
              }`}>
                Auditor: {auditorVerdict.outcome}
              </span>
            )}
            <span className={`rounded-full px-2 py-0.5 text-push-2xs font-medium ${CARD_BADGE_INFO}`}>
              {data.rounds} round{data.rounds === 1 ? '' : 's'}
              {data.checkpoints > 0 ? `, ${data.checkpoints} checkpoint${data.checkpoints === 1 ? '' : 's'}` : ''}
            </span>
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-push-2xs font-medium ${CARD_BADGE_INFO}`}>
              <Clock3 className="h-3 w-3" />
              {formatElapsedTime(data.elapsedMs)}
            </span>
          </div>
        </div>
      </button>

      <ExpandableCardPanel expanded={expanded && hasDetails}>
        <div className={`px-3.5 py-3 ${CARD_LIST_CLASS}`}>
          {data.verifiedText && (
            <div className="pb-3">
              <div className="mb-1 text-push-xs uppercase tracking-wide text-push-fg-dim">Verified</div>
              <div className={`${CARD_PANEL_SUBTLE_CLASS} px-2.5 py-2 text-push-sm text-push-fg-secondary`}>
                {data.verifiedText}
              </div>
            </div>
          )}
          {data.openText && (
            <div className="py-3">
              <div className="mb-1 text-push-xs uppercase tracking-wide text-push-fg-dim">Open</div>
              <div className={`${CARD_PANEL_SUBTLE_CLASS} px-2.5 py-2 text-push-sm text-push-fg-secondary`}>
                {data.openText}
              </div>
            </div>
          )}
          {data.nextRequiredAction && (
            <div className="py-3">
              <div className="mb-1 text-push-xs uppercase tracking-wide text-push-fg-dim">Next required action</div>
              <div className={`${CARD_PANEL_SUBTLE_CLASS} px-2.5 py-2 text-push-sm text-push-fg-secondary`}>
                {data.nextRequiredAction}
              </div>
            </div>
          )}
          {data.missingRequirements.length > 0 && (
            <div className="py-3">
              <div className="mb-1 text-push-xs uppercase tracking-wide text-push-fg-dim">Missing requirements</div>
              <div className="space-y-1.5">
                {data.missingRequirements.map((requirement, index) => (
                  <div key={index} className={`${CARD_PANEL_SUBTLE_CLASS} flex items-start gap-2 px-2.5 py-2 text-push-sm text-push-fg-secondary`}>
                    <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-push-status-warning" />
                    <span>{requirement}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {data.gateVerdicts.length > 0 && (
            <div className="pt-3">
              <div className="mb-1 text-push-xs uppercase tracking-wide text-push-fg-dim">Gates</div>
              <div className="space-y-1.5">
                {data.gateVerdicts.map((verdict, index) => (
                  <div key={index} className={`${CARD_PANEL_SUBTLE_CLASS} flex items-start gap-2 px-2.5 py-2 text-push-sm text-push-fg-secondary`}>
                    <CheckCircle2 className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                      verdict.outcome === 'passed'
                        ? CARD_TEXT_SUCCESS
                        : verdict.outcome === 'failed'
                          ? CARD_TEXT_ERROR
                          : CARD_TEXT_WARNING
                    }`} />
                    <div>
                      <div className="text-push-sm text-push-fg">
                        {verdict.gate} — {verdict.outcome}
                      </div>
                      <div className="mt-0.5 text-push-xs text-push-fg-dim">
                        {verdict.summary}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </ExpandableCardPanel>
    </div>
  );
}
