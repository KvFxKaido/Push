import { lazy, Suspense, type ComponentType } from 'react';
import type { ChatCard, CardAction } from '@/types';

// --- Lazy-loaded card components (code-split) ---
const PRCard = lazy(() => import('./PRCard').then(m => ({ default: m.PRCard })));
const PRListCard = lazy(() => import('./PRListCard').then(m => ({ default: m.PRListCard })));
const CommitListCard = lazy(() => import('./CommitListCard').then(m => ({ default: m.CommitListCard })));
const FileCard = lazy(() => import('./FileCard').then(m => ({ default: m.FileCard })));
const BranchListCard = lazy(() => import('./BranchListCard').then(m => ({ default: m.BranchListCard })));
const FileListCard = lazy(() => import('./FileListCard').then(m => ({ default: m.FileListCard })));
const SandboxCard = lazy(() => import('./SandboxCard').then(m => ({ default: m.SandboxCard })));
const DiffPreviewCard = lazy(() => import('./DiffPreviewCard').then(m => ({ default: m.DiffPreviewCard })));
const AuditVerdictCard = lazy(() => import('./AuditVerdictCard').then(m => ({ default: m.AuditVerdictCard })));
const CommitReviewCard = lazy(() => import('./CommitReviewCard').then(m => ({ default: m.CommitReviewCard })));
const CIStatusCard = lazy(() => import('./CIStatusCard').then(m => ({ default: m.CIStatusCard })));
const EditorCard = lazy(() => import('./EditorCard').then(m => ({ default: m.EditorCard })));
const FileSearchCard = lazy(() => import('./FileSearchCard').then(m => ({ default: m.FileSearchCard })));
const CommitFilesCard = lazy(() => import('./CommitFilesCard').then(m => ({ default: m.CommitFilesCard })));
const TestResultsCard = lazy(() => import('./TestResultsCard').then(m => ({ default: m.TestResultsCard })));
const TypeCheckCard = lazy(() => import('./TypeCheckCard').then(m => ({ default: m.TypeCheckCard })));
const SandboxDownloadCard = lazy(() => import('./SandboxDownloadCard').then(m => ({ default: m.SandboxDownloadCard })));
const WorkflowRunsCard = lazy(() => import('./WorkflowRunsCard').then(m => ({ default: m.WorkflowRunsCard })));
const WorkflowLogsCard = lazy(() => import('./WorkflowLogsCard').then(m => ({ default: m.WorkflowLogsCard })));
const WebSearchCard = lazy(() => import('./WebSearchCard').then(m => ({ default: m.WebSearchCard })));
const CoderProgressCard = lazy(() => import('./CoderProgressCard').then(m => ({ default: m.CoderProgressCard })));

interface CardRendererProps {
  card: ChatCard;
  messageId?: string;
  cardIndex?: number;
  onAction?: (action: CardAction) => void;
}

// ---------------------------------------------------------------------------
// Component registries — data-only cards vs cards that receive action props
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DATA_ONLY_CARDS: Record<string, ComponentType<{ data: any }>> = {
  'pr':                  PRCard,
  'pr-list':             PRListCard,
  'commit-list':         CommitListCard,
  'file':                FileCard,
  'branch-list':         BranchListCard,
  'file-list':           FileListCard,
  'sandbox':             SandboxCard,
  'diff-preview':        DiffPreviewCard,
  'audit-verdict':       AuditVerdictCard,
  'file-search':         FileSearchCard,
  'commit-files':        CommitFilesCard,
  'test-results':        TestResultsCard,
  'type-check':          TypeCheckCard,
  'sandbox-download':    SandboxDownloadCard,
  'workflow-runs':       WorkflowRunsCard,
  'workflow-logs':       WorkflowLogsCard,
  'web-search':          WebSearchCard,
  'coder-progress':      CoderProgressCard,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ACTION_CARDS: Record<string, ComponentType<{ data: any; messageId: string; cardIndex: number; onAction?: (action: CardAction) => void }>> = {
  'commit-review': CommitReviewCard,
  'ci-status':     CIStatusCard,
  'editor':        EditorCard,
};

// ---------------------------------------------------------------------------

function renderCard(card: ChatCard, messageId?: string, cardIndex?: number, onAction?: (action: CardAction) => void) {
  if (card.type === 'sandbox-state') return null;

  const ActionComp = ACTION_CARDS[card.type];
  if (ActionComp) {
    return <ActionComp data={card.data} messageId={messageId || ''} cardIndex={cardIndex ?? 0} onAction={onAction} />;
  }

  const DataComp = DATA_ONLY_CARDS[card.type];
  if (DataComp) return <DataComp data={card.data} />;

  // Unknown card type — show a tombstone so older persisted chats degrade
  // visibly rather than silently losing content.
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-xs text-zinc-500">
      [{card.type}] — card type no longer supported
    </div>
  );
}

export function CardRenderer({ card, messageId, cardIndex, onAction }: CardRendererProps) {
  const inner = renderCard(card, messageId, cardIndex, onAction);
  if (!inner) return null;
  return (
    <Suspense fallback={<div className="h-16 animate-pulse rounded-lg bg-zinc-900/50" />}>
      <div className="animate-card-expand">{inner}</div>
    </Suspense>
  );
}
