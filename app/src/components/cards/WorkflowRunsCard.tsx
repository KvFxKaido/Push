import { GitBranch, Play } from 'lucide-react';
import type { WorkflowRunsCardData } from '@/types';
import { timeAgo, CARD_SHELL_CLASS } from '@/lib/utils';
import {
  checkToneBgClass,
  checkToneColorClass,
  getCheckTone,
  getWorkflowRunsHeaderTone,
  renderCheckToneIcon,
} from './ci-status-helpers';

interface WorkflowRunsCardProps {
  data: WorkflowRunsCardData;
}

export function WorkflowRunsCard({ data }: WorkflowRunsCardProps) {
  const headerTone = getWorkflowRunsHeaderTone(data.runs);

  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Header */}
      <div className={`px-3 py-2.5 flex items-center gap-2 ${checkToneBgClass(headerTone)}`}>
        {data.runs.length === 0
          ? <Play className="h-4 w-4 shrink-0 text-push-fg-dim" />
          : renderCheckToneIcon(headerTone, 'h-4 w-4 shrink-0')}
        <span className={`text-sm font-medium ${checkToneColorClass(headerTone)}`}>
          Workflow Runs
        </span>
        {data.workflow && (
          <span className="text-[11px] text-push-fg-dim truncate">
            {data.workflow}
          </span>
        )}
        <span className="ml-auto text-[11px] text-push-fg-dim">
          {data.runs.length} run{data.runs.length !== 1 ? 's' : ''}
        </span>
      </div>

      {/* Run list */}
      {data.runs.length > 0 ? (
        <div className="px-3 py-2 space-y-1.5">
          {data.runs.map((run) => (
            <div key={run.id} className="flex items-start gap-2 min-h-[28px]">
              <div className="mt-0.5">{renderCheckToneIcon(getCheckTone(run.status, run.conclusion), 'h-3.5 w-3.5 shrink-0')}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="text-[13px] text-[#e4e4e7] truncate">
                    #{run.runNumber} {run.name}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-[12px] text-push-fg-dim">
                  <GitBranch className="h-3 w-3 shrink-0" />
                  <span className="truncate">{run.branch}</span>
                  <span>·</span>
                  <span>{run.event}</span>
                  <span>·</span>
                  <span>{run.actor}</span>
                  <span>·</span>
                  <span className="shrink-0">{timeAgo(run.createdAt)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="px-3 py-3">
          <p className="text-[12px] text-push-fg-dim">No workflow runs found.</p>
        </div>
      )}

      {/* Truncated notice */}
      {data.truncated && (
        <div className="px-3 pb-2">
          <p className="text-[11px] text-push-fg-dim text-center">
            More runs available — narrow with workflow or branch filter
          </p>
        </div>
      )}
    </div>
  );
}
