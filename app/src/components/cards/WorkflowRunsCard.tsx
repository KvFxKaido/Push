import { CheckCircle2, XCircle, Clock, MinusCircle, GitBranch, Play } from 'lucide-react';
import type { WorkflowRunsCardData, WorkflowRunItem } from '@/types';

interface WorkflowRunsCardProps {
  data: WorkflowRunsCardData;
}

function runStatusIcon(run: WorkflowRunItem) {
  if (run.status !== 'completed') {
    return <Clock className="h-3.5 w-3.5 shrink-0 text-[#f59e0b]" />;
  }
  switch (run.conclusion) {
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

function headerBg(runs: WorkflowRunItem[]): string {
  if (runs.length === 0) return 'bg-push-fg-dim/10';
  const first = runs[0];
  if (first.status !== 'completed') return 'bg-[#f59e0b]/5';
  switch (first.conclusion) {
    case 'success': return 'bg-[#22c55e]/5';
    case 'failure': return 'bg-[#ef4444]/5';
    default: return 'bg-push-fg-dim/10';
  }
}

function headerColor(runs: WorkflowRunItem[]): string {
  if (runs.length === 0) return 'text-push-fg-secondary';
  const first = runs[0];
  if (first.status !== 'completed') return 'text-[#f59e0b]';
  switch (first.conclusion) {
    case 'success': return 'text-[#22c55e]';
    case 'failure': return 'text-[#ef4444]';
    default: return 'text-push-fg-secondary';
  }
}

function headerIcon(runs: WorkflowRunItem[]) {
  if (runs.length === 0) return <Play className="h-4 w-4 shrink-0 text-push-fg-dim" />;
  const first = runs[0];
  if (first.status !== 'completed') return <Clock className="h-4 w-4 shrink-0 text-[#f59e0b]" />;
  switch (first.conclusion) {
    case 'success': return <CheckCircle2 className="h-4 w-4 shrink-0 text-[#22c55e]" />;
    case 'failure': return <XCircle className="h-4 w-4 shrink-0 text-[#ef4444]" />;
    default: return <MinusCircle className="h-4 w-4 shrink-0 text-push-fg-secondary" />;
  }
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

export function WorkflowRunsCard({ data }: WorkflowRunsCardProps) {
  return (
    <div className="my-2.5 max-w-full overflow-hidden rounded-xl border border-push-edge bg-[linear-gradient(180deg,#090d14_0%,#06090f_100%)] shadow-push-card">
      {/* Header */}
      <div className={`px-3 py-2.5 flex items-center gap-2 ${headerBg(data.runs)}`}>
        {headerIcon(data.runs)}
        <span className={`text-sm font-medium ${headerColor(data.runs)}`}>
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
              <div className="mt-0.5">{runStatusIcon(run)}</div>
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
