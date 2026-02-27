import { ListTodo, FileCode, CheckCircle2, CircleDashed, ClipboardList } from 'lucide-react';
import type { CoderWorkingMemory } from '@/types';

interface CoderProgressCardProps {
  data: CoderWorkingMemory;
}

export function CoderProgressCard({ data }: CoderProgressCardProps) {
  const hasTasks = !!(data.openTasks && data.openTasks.length > 0);
  const hasCompleted = !!(data.completedPhases && data.completedPhases.length > 0);
  const hasFiles = !!(data.filesTouched && data.filesTouched.length > 0);

  return (
    <div className="my-2.5 overflow-hidden rounded-xl border border-push-edge bg-push-grad-card shadow-push-card">
      <div className="px-3 py-2.5 border-b border-push-edge flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <ClipboardList className="h-4 w-4 text-push-accent shrink-0" />
          <span className="text-[13px] text-[#e4e4e7] font-medium truncate">Coder Progress</span>
        </div>
        {data.currentPhase && (
          <div className="flex items-center gap-1.5">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-push-accent opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-push-accent"></span>
            </span>
            <span className="text-[11px] text-push-accent font-medium truncate max-w-[120px]">
              {data.currentPhase}
            </span>
          </div>
        )}
      </div>

      <div className="px-3 py-3 space-y-4">
        {data.plan && (
          <div className="space-y-1.5">
            <div className="text-[11px] text-push-fg-muted font-medium uppercase tracking-wider">Plan</div>
            <p className="text-[12px] text-push-fg-secondary leading-relaxed">{data.plan}</p>
          </div>
        )}

        {hasTasks && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5 text-[11px] text-push-fg-muted font-medium uppercase tracking-wider">
              <ListTodo className="h-3 w-3" />
              <span>Open Tasks</span>
            </div>
            <div className="space-y-1.5">
              {data.openTasks?.map((task, idx) => (
                <div key={idx} className="flex items-start gap-2 text-[12px] text-push-fg-secondary bg-white/5 border border-white/5 rounded-lg px-2.5 py-1.5">
                  <CircleDashed className="h-3.5 w-3.5 mt-0.5 text-push-fg-dim shrink-0" />
                  <span>{task}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 pt-1">
          {hasCompleted && (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-[11px] text-push-fg-muted font-medium uppercase tracking-wider">
                <CheckCircle2 className="h-3 w-3 text-[#22c55e]" />
                <span>Done</span>
              </div>
              <div className="space-y-1">
                {data.completedPhases?.map((phase, idx) => (
                  <div key={idx} className="text-[11px] text-[#22c55e]/80 truncate">
                    • {phase}
                  </div>
                ))}
              </div>
            </div>
          )}

          {hasFiles && (
            <div className="space-y-2">
              <div className="flex items-center gap-1.5 text-[11px] text-push-fg-muted font-medium uppercase tracking-wider">
                <FileCode className="h-3 w-3" />
                <span>Files</span>
              </div>
              <div className="space-y-1">
                {data.filesTouched?.map((file, idx) => (
                  <div key={idx} className="text-[11px] text-push-fg-dim font-mono truncate">
                    / {file}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}