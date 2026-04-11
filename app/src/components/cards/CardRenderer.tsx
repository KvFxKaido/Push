import { Component, Suspense, type ComponentType, type ErrorInfo, type ReactNode } from 'react';
import type { ChatCard, CardAction } from '@/types';
import { CARD_PANEL_CLASS } from '@/lib/utils';
import { lazyWithRecovery, toDefaultExport } from '@/lib/lazy-import';
import { MAX_COMPONENT_STACK_CHARS, reportError } from '@/lib/error-reporting';
import { DiffPreviewCard } from './DiffPreviewCard';
import { AuditVerdictCard } from './AuditVerdictCard';

// --- Lazy-loaded card components (code-split) ---
const PRCard = lazyWithRecovery(
  toDefaultExport(
    () => import('./PRCard'),
    (module) => module.PRCard,
  ),
);
const PRListCard = lazyWithRecovery(
  toDefaultExport(
    () => import('./PRListCard'),
    (module) => module.PRListCard,
  ),
);
const CommitListCard = lazyWithRecovery(
  toDefaultExport(
    () => import('./CommitListCard'),
    (module) => module.CommitListCard,
  ),
);
const FileCard = lazyWithRecovery(
  toDefaultExport(
    () => import('./FileCard'),
    (module) => module.FileCard,
  ),
);
const BranchListCard = lazyWithRecovery(
  toDefaultExport(
    () => import('./BranchListCard'),
    (module) => module.BranchListCard,
  ),
);
const FileListCard = lazyWithRecovery(
  toDefaultExport(
    () => import('./FileListCard'),
    (module) => module.FileListCard,
  ),
);
const SandboxCard = lazyWithRecovery(
  toDefaultExport(
    () => import('./SandboxCard'),
    (module) => module.SandboxCard,
  ),
);
const CommitReviewCard = lazyWithRecovery(
  toDefaultExport(
    () => import('./CommitReviewCard'),
    (module) => module.CommitReviewCard,
  ),
);
const CIStatusCard = lazyWithRecovery(
  toDefaultExport(
    () => import('./CIStatusCard'),
    (module) => module.CIStatusCard,
  ),
);
const EditorCard = lazyWithRecovery(
  toDefaultExport(
    () => import('./EditorCard'),
    (module) => module.EditorCard,
  ),
);
const FileSearchCard = lazyWithRecovery(
  toDefaultExport(
    () => import('./FileSearchCard'),
    (module) => module.FileSearchCard,
  ),
);
const CommitFilesCard = lazyWithRecovery(
  toDefaultExport(
    () => import('./CommitFilesCard'),
    (module) => module.CommitFilesCard,
  ),
);
const TestResultsCard = lazyWithRecovery(
  toDefaultExport(
    () => import('./TestResultsCard'),
    (module) => module.TestResultsCard,
  ),
);
const TypeCheckCard = lazyWithRecovery(
  toDefaultExport(
    () => import('./TypeCheckCard'),
    (module) => module.TypeCheckCard,
  ),
);
const SandboxDownloadCard = lazyWithRecovery(
  toDefaultExport(
    () => import('./SandboxDownloadCard'),
    (module) => module.SandboxDownloadCard,
  ),
);
const WorkflowRunsCard = lazyWithRecovery(
  toDefaultExport(
    () => import('./WorkflowRunsCard'),
    (module) => module.WorkflowRunsCard,
  ),
);
const WorkflowLogsCard = lazyWithRecovery(
  toDefaultExport(
    () => import('./WorkflowLogsCard'),
    (module) => module.WorkflowLogsCard,
  ),
);
const WebSearchCard = lazyWithRecovery(
  toDefaultExport(
    () => import('./WebSearchCard'),
    (module) => module.WebSearchCard,
  ),
);
const DelegationResultCard = lazyWithRecovery(
  toDefaultExport(
    () => import('./DelegationResultCard'),
    (module) => module.DelegationResultCard,
  ),
);
const CoderProgressCard = lazyWithRecovery(
  toDefaultExport(
    () => import('./CoderProgressCard'),
    (module) => module.CoderProgressCard,
  ),
);
const AskUserCard = lazyWithRecovery(
  toDefaultExport(
    () => import('./AskUserCard'),
    (module) => module.AskUserCard,
  ),
);

interface CardRendererProps {
  card: ChatCard;
  messageId?: string;
  cardIndex?: number;
  onAction?: (action: CardAction) => void;
}

interface CardErrorBoundaryProps {
  children: ReactNode;
}

interface CardErrorBoundaryState {
  hasError: boolean;
  message: string | null;
}

class CardErrorBoundary extends Component<CardErrorBoundaryProps, CardErrorBoundaryState> {
  state: CardErrorBoundaryState = {
    hasError: false,
    message: null,
  };

  static getDerivedStateFromError(error: Error): CardErrorBoundaryState {
    return {
      hasError: true,
      message: error.message,
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[CardRenderer] Failed to load card component', error);
    const stack = info.componentStack ?? '';
    reportError({
      source: 'card-render',
      error,
      attributes: stack
        ? { 'push.error.component_stack': stack.slice(0, MAX_COMPONENT_STACK_CHARS) }
        : undefined,
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          className={`${CARD_PANEL_CLASS} border-amber-500/20 bg-[linear-gradient(180deg,rgba(52,40,15,0.2)_0%,rgba(24,18,7,0.4)_100%)] px-3 py-2 text-xs text-amber-300`}
        >
          Card failed to load. Refresh Push to fetch the latest assets.
        </div>
      );
    }
    return this.props.children;
  }
}

// ---------------------------------------------------------------------------
// Component registries — data-only cards vs cards that receive action props
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DATA_ONLY_CARDS: Record<string, ComponentType<{ data: any }>> = {
  pr: PRCard,
  'pr-list': PRListCard,
  'commit-list': CommitListCard,
  file: FileCard,
  'branch-list': BranchListCard,
  'file-list': FileListCard,
  sandbox: SandboxCard,
  'diff-preview': DiffPreviewCard,
  'audit-verdict': AuditVerdictCard,
  'file-search': FileSearchCard,
  'commit-files': CommitFilesCard,
  'test-results': TestResultsCard,
  'type-check': TypeCheckCard,
  'sandbox-download': SandboxDownloadCard,
  'workflow-runs': WorkflowRunsCard,
  'workflow-logs': WorkflowLogsCard,
  'web-search': WebSearchCard,
  'delegation-result': DelegationResultCard,
  'coder-progress': CoderProgressCard,
};

const ACTION_CARDS: Record<
  string,
  ComponentType<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: any;
    messageId: string;
    cardIndex: number;
    onAction?: (action: CardAction) => void;
  }>
> = {
  'commit-review': CommitReviewCard,
  'ci-status': CIStatusCard,
  editor: EditorCard,
  'ask-user': AskUserCard,
};

// ---------------------------------------------------------------------------

function renderCard(
  card: ChatCard,
  messageId?: string,
  cardIndex?: number,
  onAction?: (action: CardAction) => void,
) {
  if (card.type === 'sandbox-state') return null;

  const ActionComp = ACTION_CARDS[card.type];
  if (ActionComp) {
    return (
      <ActionComp
        data={card.data}
        messageId={messageId || ''}
        cardIndex={cardIndex ?? 0}
        onAction={onAction}
      />
    );
  }

  const DataComp = DATA_ONLY_CARDS[card.type];
  if (DataComp) return <DataComp data={card.data} />;

  // Unknown card type — show a tombstone so older persisted chats degrade
  // visibly rather than silently losing content.
  return (
    <div className={`${CARD_PANEL_CLASS} border-push-edge/70 px-3 py-2 text-xs text-zinc-500`}>
      [{card.type}] — card type no longer supported
    </div>
  );
}

export function CardRenderer({ card, messageId, cardIndex, onAction }: CardRendererProps) {
  const inner = renderCard(card, messageId, cardIndex, onAction);
  if (!inner) return null;
  return (
    <CardErrorBoundary>
      <Suspense fallback={<div className={`${CARD_PANEL_CLASS} h-16 animate-pulse`} />}>
        <div className="animate-fade-in-up">{inner}</div>
      </Suspense>
    </CardErrorBoundary>
  );
}
