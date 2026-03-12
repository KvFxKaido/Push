import { CheckCircle2, XCircle, MinusCircle } from 'lucide-react';
import type { TestResultsCardData } from '@/types';
import {
  CARD_SHELL_CLASS,
  CARD_TEXT_SUCCESS,
  CARD_TEXT_ERROR,
  CARD_HEADER_BG_SUCCESS,
  CARD_HEADER_BG_ERROR,
  CARD_PANEL_SUBTLE_CLASS,
} from '@/lib/utils';

export function TestResultsCard({ data }: { data: TestResultsCardData }) {
  const passed = data.exitCode === 0;
  const Icon = passed ? CheckCircle2 : XCircle;
  const statusColor = passed ? CARD_TEXT_SUCCESS : CARD_TEXT_ERROR;
  const statusBg = passed ? CARD_HEADER_BG_SUCCESS : CARD_HEADER_BG_ERROR;

  const frameworkLabel = {
    npm: 'npm test',
    pytest: 'pytest',
    cargo: 'cargo test',
    go: 'go test',
    unknown: 'tests',
  }[data.framework];

  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Header */}
      <div className={`px-3 py-2 flex items-center gap-2 border-b border-push-edge ${statusBg}`}>
        <Icon className={`h-4 w-4 ${statusColor}`} />
        <span className={`text-push-base font-medium ${statusColor}`}>
          Tests {passed ? 'Passed' : 'Failed'}
        </span>
        <span className="text-push-sm text-push-fg-dim">{frameworkLabel}</span>
        <span className="text-push-xs text-push-fg-dim ml-auto">
          {(data.durationMs / 1000).toFixed(1)}s
        </span>
      </div>

      {/* Stats */}
      {data.total > 0 && (
        <div className="flex items-center gap-4 border-b border-push-edge/80 px-3 py-2">
          <div className="flex items-center gap-1.5">
            <CheckCircle2 className="h-3.5 w-3.5 text-push-status-success" />
            <span className="text-push-sm text-push-fg">{data.passed} passed</span>
          </div>
          {data.failed > 0 && (
            <div className="flex items-center gap-1.5">
              <XCircle className="h-3.5 w-3.5 text-push-status-error" />
              <span className="text-push-sm text-push-fg">{data.failed} failed</span>
            </div>
          )}
          {data.skipped > 0 && (
            <div className="flex items-center gap-1.5">
              <MinusCircle className="h-3.5 w-3.5 text-push-fg-dim" />
              <span className="text-push-sm text-push-fg">{data.skipped} skipped</span>
            </div>
          )}
        </div>
      )}

      {/* Output preview */}
      <div className="px-3 py-2 max-h-[200px] overflow-y-auto">
        <div className={`${CARD_PANEL_SUBTLE_CLASS} p-3`}>
          <pre className="text-push-xs text-push-fg-secondary font-mono whitespace-pre-wrap break-all leading-relaxed">
            {data.output.slice(-2000)}
          </pre>
        </div>
        {data.truncated && (
          <span className="mt-2 inline-block text-push-xs text-push-status-warning">[output truncated]</span>
        )}
      </div>
    </div>
  );
}
