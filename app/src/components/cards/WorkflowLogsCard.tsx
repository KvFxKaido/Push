import { useState } from 'react';
import { CheckCircle2, XCircle, Clock, MinusCircle, ChevronDown, ChevronRight, ExternalLink } from 'lucide-react';
import type { WorkflowLogsCardData, WorkflowJob, WorkflowJobStep } from '@/types';
import { CARD_SHELL_CLASS } from '@/lib/utils';

interface WorkflowLogsCardProps {
  data: WorkflowLogsCardData;
}

function jobIcon(job: WorkflowJob) {
  if (job.status !== 'completed') {
    return <Clock className="h-3.5 w-3.5 shrink-0 text-[#f59e0b]" />;
  }
  switch (job.conclusion) {
    case 'success':
      return <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[#22c55e]" />;
    case 'failure':
      return <XCircle className="h-3.5 w-3.5 shrink-0 text-[#ef4444]" />;
    case 'cancelled':
    case 'timed_out':
      return <XCircle className="h-3.5 w-3.5 shrink-0 text-[#f59e0b]" />;
    default:
      return <MinusCircle className="h-3.5 w-3.5 shrink-0 text-push-fg-secondary" />;
  }
}

function stepIcon(step: WorkflowJobStep) {
  if (step.status !== 'completed') {
    return <Clock className="h-3 w-3 shrink-0 text-[#f59e0b]" />;
  }
  switch (step.conclusion) {
    case 'success':
      return <CheckCircle2 className="h-3 w-3 shrink-0 text-[#22c55e]" />;
    case 'failure':
      return <XCircle className="h-3 w-3 shrink-0 text-[#ef4444]" />;
    case 'skipped':
      return <MinusCircle className="h-3 w-3 shrink-0 text-push-fg-dim" />;
    default:
      return <MinusCircle className="h-3 w-3 shrink-0 text-push-fg-secondary" />;
  }
}

function headerBg(conclusion: string | null): string {
  switch (conclusion) {
    case 'success': return 'bg-[#22c55e]/5';
    case 'failure': return 'bg-[#ef4444]/5';
    default: return 'bg-[#f59e0b]/5';
  }
}

function headerColor(conclusion: string | null): string {
  switch (conclusion) {
    case 'success': return 'text-[#22c55e]';
    case 'failure': return 'text-[#ef4444]';
    default: return 'text-[#f59e0b]';
  }
}

function headerIcon(conclusion: string | null) {
  switch (conclusion) {
    case 'success':
      return <CheckCircle2 className="h-4 w-4 shrink-0 text-[#22c55e]" />;
    case 'failure':
      return <XCircle className="h-4 w-4 shrink-0 text-[#ef4444]" />;
    default:
      return <Clock className="h-4 w-4 shrink-0 text-[#f59e0b]" />;
  }
}

function getInitialExpanded(jobs: WorkflowJob[]): Set<number> {
  // Auto-expand first failed job, or first job if all pass
  const failedIdx = jobs.findIndex(j => j.conclusion === 'failure');
  return new Set([failedIdx >= 0 ? failedIdx : 0]);
}

export function WorkflowLogsCard({ data }: WorkflowLogsCardProps) {
  const [expanded, setExpanded] = useState<Set<number>>(() => getInitialExpanded(data.jobs));

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
      <div className={`px-3 py-2.5 flex items-center gap-2 ${headerBg(data.conclusion)}`}>
        {headerIcon(data.conclusion)}
        <div className="flex-1 min-w-0">
          <span className={`text-sm font-medium ${headerColor(data.conclusion)}`}>
            {data.runName}
          </span>
          <span className="text-[11px] text-push-fg-dim ml-1.5">
            #{data.runNumber}
          </span>
        </div>
        <span className="text-[11px] text-push-fg-dim uppercase shrink-0">
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
              className="w-full px-3.5 py-3 flex items-center gap-2 text-left hover:bg-[#0d1119] transition-colors duration-200"
            >
              {expanded.has(idx)
                ? <ChevronDown className="h-3 w-3 shrink-0 text-push-fg-dim" />
                : <ChevronRight className="h-3 w-3 shrink-0 text-push-fg-dim" />
              }
              {jobIcon(job)}
              <span className="text-[13px] text-[#e4e4e7] truncate flex-1">
                {job.name}
              </span>
              <span className="text-[11px] text-push-fg-dim shrink-0">
                {job.conclusion || job.status}
              </span>
            </button>

            {/* Steps — shown when expanded */}
            {expanded.has(idx) && job.steps.length > 0 && (
              <div className="px-3 pb-2 pl-10 space-y-0.5 expand-in">
                {job.steps.map((step) => (
                  <div key={step.number} className="flex items-center gap-2 min-h-[22px]">
                    {stepIcon(step)}
                    <span className="text-[12px] text-push-fg-muted">
                      {step.number}.
                    </span>
                    <span className="text-[12px] text-push-fg-secondary truncate flex-1">
                      {step.name}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Footer — View on GitHub */}
      <div className="px-3 py-2 border-t border-push-edge">
        <a
          href={data.htmlUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-1.5 text-[12px] text-push-link hover:text-[#86ccff] transition-colors"
        >
          <ExternalLink className="h-3 w-3" />
          View on GitHub
        </a>
      </div>
    </div>
  );
}
