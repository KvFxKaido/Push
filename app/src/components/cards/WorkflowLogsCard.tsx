import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import type { WorkflowLogsCardData, WorkflowJob } from '@/types';
import { CARD_SHELL_CLASS } from '@/lib/utils';
import {
  checkToneBgClass,
  checkToneColorClass,
  getCheckTone,
  getWorkflowLogsHeaderTone,
  renderCheckToneIcon,
} from './ci-status-helpers';
import { ExpandChevron, ExpandableCardPanel } from './expandable';

interface WorkflowLogsCardProps {
  data: WorkflowLogsCardData;
}

function getInitialExpanded(jobs: WorkflowJob[]): Set<number> {
  // Auto-expand first failed job, or first job if all pass
  const failedIdx = jobs.findIndex(j => j.conclusion === 'failure');
  return new Set([failedIdx >= 0 ? failedIdx : 0]);
}

export function WorkflowLogsCard({ data }: WorkflowLogsCardProps) {
  const [expanded, setExpanded] = useState<Set<number>>(() => getInitialExpanded(data.jobs));
  const headerTone = getWorkflowLogsHeaderTone(data.conclusion);

  const toggleJob = (idx: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };

  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Header */}
      <div className={`px-3 py-2.5 flex items-center gap-2 ${checkToneBgClass(headerTone)}`}>
        {renderCheckToneIcon(headerTone, 'h-4 w-4 shrink-0')}
        <div className="flex-1 min-w-0">
          <span className={`text-sm font-medium ${checkToneColorClass(headerTone)}`}>
            {data.runName}
          </span>
          <span className="text-push-xs text-push-fg-dim ml-1.5">
            #{data.runNumber}
          </span>
        </div>
        <span className="text-push-xs text-push-fg-dim uppercase shrink-0">
          {data.conclusion || data.status}
        </span>
      </div>

      {/* Jobs */}
      <div className="max-h-[300px] overflow-y-auto">
        {data.jobs.map((job, idx) => (
          <div key={idx} className="border-t border-push-edge first:border-t-0">
            {/* Job header — clickable */}
            <button
              onClick={() => toggleJob(idx)}
              className="w-full px-3.5 py-3 flex items-center gap-2 text-left hover:bg-push-surface-hover transition-colors duration-200"
            >
              <ExpandChevron expanded={expanded.has(idx)} className="shrink-0" />
              {renderCheckToneIcon(getCheckTone(job.status, job.conclusion), 'h-3.5 w-3.5 shrink-0')}
              <span className="text-push-base text-push-fg truncate flex-1">
                {job.name}
              </span>
              <span className="text-push-xs text-push-fg-dim shrink-0">
                {job.conclusion || job.status}
              </span>
            </button>

            {/* Steps — shown when expanded */}
            <ExpandableCardPanel
              expanded={expanded.has(idx) && job.steps.length > 0}
              bordered={false}
              className="px-3 pb-2 pl-10 space-y-0.5"
            >
              {job.steps.map((step) => (
                <div key={step.number} className="flex items-center gap-2 min-h-[22px]">
                  {renderCheckToneIcon(
                    getCheckTone(step.status, step.conclusion),
                    'h-3 w-3 shrink-0',
                    { neutralClassName: 'text-push-fg-dim' },
                  )}
                  <span className="text-push-sm text-push-fg-muted">
                    {step.number}.
                  </span>
                  <span className="text-push-sm text-push-fg-secondary truncate flex-1">
                    {step.name}
                  </span>
                </div>
              ))}
            </ExpandableCardPanel>
          </div>
        ))}
      </div>

      {/* Footer — View on GitHub */}
      <div className="px-3 py-2 border-t border-push-edge">
        <a
          href={data.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-1.5 text-push-sm text-push-link hover:text-[#86ccff] transition-colors"
        >
          <ExternalLink className="h-3 w-3" />
          View on GitHub
        </a>
      </div>
    </div>
  );
}
