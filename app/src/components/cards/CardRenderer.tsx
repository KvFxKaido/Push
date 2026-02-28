import type { ComponentType } from 'react';
import type { ChatCard, CardAction } from '@/types';
import { PRCard } from './PRCard';
import { PRListCard } from './PRListCard';
import { CommitListCard } from './CommitListCard';
import { FileCard } from './FileCard';
import { BranchListCard } from './BranchListCard';
import { FileListCard } from './FileListCard';
import { SandboxCard } from './SandboxCard';
import { DiffPreviewCard } from './DiffPreviewCard';
import { AuditVerdictCard } from './AuditVerdictCard';
import { CommitReviewCard } from './CommitReviewCard';
import { CIStatusCard } from './CIStatusCard';
import { EditorCard } from './EditorCard';
import { FileSearchCard } from './FileSearchCard';
import { CommitFilesCard } from './CommitFilesCard';
import { TestResultsCard } from './TestResultsCard';
import { TypeCheckCard } from './TypeCheckCard';
import { BrowserScreenshotCard } from './BrowserScreenshotCard';
import { BrowserExtractCard } from './BrowserExtractCard';
import { SandboxDownloadCard } from './SandboxDownloadCard';
import { WorkflowRunsCard } from './WorkflowRunsCard';
import { WorkflowLogsCard } from './WorkflowLogsCard';
import { WebSearchCard } from './WebSearchCard';
import { CoderProgressCard } from './CoderProgressCard';

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
  'browser-screenshot':  BrowserScreenshotCard,
  'browser-extract':     BrowserExtractCard,
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

  return null;
}

export function CardRenderer({ card, messageId, cardIndex, onAction }: CardRendererProps) {
  const inner = renderCard(card, messageId, cardIndex, onAction);
  if (!inner) return null;
  return <div className="animate-card-expand">{inner}</div>;
}
