import { FileCode, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import type { TypeCheckCardData } from '@/types';
import {
  CARD_SHELL_CLASS,
  CARD_TEXT_SUCCESS,
  CARD_TEXT_ERROR,
  CARD_HEADER_BG_SUCCESS,
  CARD_HEADER_BG_ERROR,
  CARD_LIST_CLASS,
  CARD_PANEL_SUBTLE_CLASS,
} from '@/lib/utils';

export function TypeCheckCard({ data }: { data: TypeCheckCardData }) {
  const passed = data.exitCode === 0;
  const Icon = passed ? CheckCircle2 : XCircle;
  const statusColor = passed ? CARD_TEXT_SUCCESS : CARD_TEXT_ERROR;
  const statusBg = passed ? CARD_HEADER_BG_SUCCESS : CARD_HEADER_BG_ERROR;

  const toolLabel = {
    tsc: 'TypeScript',
    pyright: 'Pyright',
    mypy: 'mypy',
    unknown: 'type check',
  }[data.tool];

  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Header */}
      <div className={`px-3 py-2 flex items-center gap-2 border-b border-push-edge ${statusBg}`}>
        <Icon className={`h-4 w-4 ${statusColor}`} />
        <span className={`text-push-base font-medium ${statusColor}`}>
          {passed ? 'No Type Errors' : 'Type Errors Found'}
        </span>
        <span className="text-push-sm text-push-fg-dim">{toolLabel}</span>
      </div>

      {/* Stats */}
      {(data.errorCount > 0 || data.warningCount > 0) && (
        <div className="flex items-center gap-4 border-b border-push-edge/80 px-3 py-2">
          {data.errorCount > 0 && (
            <div className="flex items-center gap-1.5">
              <XCircle className="h-3.5 w-3.5 text-push-status-error" />
              <span className="text-push-sm text-push-fg">
                {data.errorCount} error{data.errorCount !== 1 ? 's' : ''}
              </span>
            </div>
          )}
          {data.warningCount > 0 && (
            <div className="flex items-center gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 text-push-status-warning" />
              <span className="text-push-sm text-push-fg">
                {data.warningCount} warning{data.warningCount !== 1 ? 's' : ''}
              </span>
            </div>
          )}
        </div>
      )}

      {/* Error list */}
      {data.errors.length > 0 && (
        <div className={`${CARD_LIST_CLASS} max-h-[250px] overflow-y-auto`}>
          {data.errors.slice(0, 15).map((err, i) => (
            <div key={i} className="px-3 py-2">
              <div className={`${CARD_PANEL_SUBTLE_CLASS} px-2.5 py-2`}>
                <div className="flex items-center gap-2 text-push-sm">
                  <FileCode className="h-3 w-3 text-push-fg-dim shrink-0" />
                  <span className="text-push-link font-mono">
                    {err.file}:{err.line}
                    {err.column > 0 ? `:${err.column}` : ''}
                  </span>
                  {err.code && (
                    <span className="text-push-fg-dim font-mono text-push-xs">{err.code}</span>
                  )}
                </div>
                <p className="text-push-xs text-push-fg-secondary mt-0.5 ml-5 truncate">
                  {err.message}
                </p>
              </div>
            </div>
          ))}
          {data.errors.length > 15 && (
            <div className="px-3 py-1.5 text-push-xs text-push-fg-dim">
              +{data.errors.length - 15} more errors
            </div>
          )}
        </div>
      )}

      {data.truncated && (
        <div className="px-3 py-1.5 border-t border-push-edge text-push-xs text-push-status-warning">
          Output truncated
        </div>
      )}
    </div>
  );
}
