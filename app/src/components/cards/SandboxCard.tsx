import { useState } from 'react';
import { CheckCircle2, XCircle, Copy, Download, Check } from 'lucide-react';
import type { SandboxCardData } from '@/types';
import { useExpandable } from '@/hooks/useExpandable';
import {
  CARD_SHELL_CLASS,
  CARD_BADGE_SUCCESS,
  CARD_BADGE_ERROR,
  CARD_ICON_BUTTON_CLASS,
} from '@/lib/utils';
import { TerminalCrateIcon } from '@/components/icons/push-custom-icons';
import { ExpandChevron, ExpandableCardPanel } from './expandable';
import { CardCodeBlock } from './card-code-block';

export function SandboxCard({ data }: { data: SandboxCardData }) {
  const { expanded, toggleExpanded } = useExpandable(data.exitCode !== 0, { collapseOnMobile: true });
  const [copied, setCopied] = useState(false);
  const isSuccess = data.exitCode === 0;

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    const output = [data.stdout, data.stderr].filter(Boolean).join('\n---\n');
    if (!output) return;
    navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    const output = [data.stdout, data.stderr].filter(Boolean).join('\n---\n');
    if (!output) return;
    const blob = new Blob([output], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `sandbox-output-${timestamp}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className={CARD_SHELL_CLASS}>
      {/* Header */}
      <button
        onClick={toggleExpanded}
        className="flex w-full items-center gap-2.5 px-3.5 py-3 transition-colors duration-200 hover:bg-white/[0.02]"
      >
        <TerminalCrateIcon className="h-4 w-4 shrink-0 text-push-fg-secondary" />
        <code className="flex-1 text-push-base text-push-fg font-mono text-left truncate">
          {data.command}
        </code>
        <div className="flex items-center gap-2 shrink-0">
          {expanded && (data.stdout || data.stderr) && (
            <div className="flex items-center gap-1 mr-1">
              <button
                onClick={handleCopy}
                className={`${CARD_ICON_BUTTON_CLASS} h-7 w-7`}
                title="Copy output"
              >
                {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
              </button>
              <button
                onClick={handleDownload}
                className={`${CARD_ICON_BUTTON_CLASS} h-7 w-7`}
                title="Download output"
              >
                <Download className="h-3 w-3" />
              </button>
            </div>
          )}
          {data.durationMs !== undefined && (
            <span className="text-push-xs text-push-fg-dim font-mono">
              {data.durationMs < 1000 ? `${data.durationMs}ms` : `${(data.durationMs / 1000).toFixed(1)}s`}
            </span>
          )}
          {isSuccess ? (
            <span className={`inline-flex items-center gap-1 text-push-xs font-medium px-1.5 py-0.5 rounded-full ${CARD_BADGE_SUCCESS}`}>
              <CheckCircle2 className="h-3 w-3" />
              0
            </span>
          ) : (
            <span className={`inline-flex items-center gap-1 text-push-xs font-medium px-1.5 py-0.5 rounded-full ${CARD_BADGE_ERROR}`}>
              <XCircle className="h-3 w-3" />
              {data.exitCode}
            </span>
          )}
          <ExpandChevron expanded={expanded} />
        </div>
      </button>

      {/* Output */}
      <ExpandableCardPanel expanded={expanded}>
        {data.stdout && (
          <CardCodeBlock codeClassName="text-push-fg-secondary whitespace-pre-wrap break-all">
            {data.stdout}
          </CardCodeBlock>
        )}
        {data.stderr && (
          <CardCodeBlock preClassName="bg-push-surface-inset" codeClassName="text-push-status-error/70 whitespace-pre-wrap break-all">
            {data.stderr}
          </CardCodeBlock>
        )}
        {data.truncated && (
          <div className="px-3 py-1.5 text-push-xs text-push-fg-dim italic border-t border-push-edge">
            Output truncated
          </div>
        )}
        {!data.stdout && !data.stderr && (
          <div className="px-3 py-2 text-push-sm text-push-fg-dim italic">
            No output
          </div>
        )}
      </ExpandableCardPanel>
    </div>
  );
}
