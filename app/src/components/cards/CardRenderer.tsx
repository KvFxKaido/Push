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

interface CardRendererProps {
  card: ChatCard;
  messageId?: string;
  cardIndex?: number;
  onAction?: (action: CardAction) => void;
}

export function CardRenderer({ card, messageId, cardIndex, onAction }: CardRendererProps) {
  switch (card.type) {
    case 'pr':
      return <PRCard data={card.data} />;
    case 'pr-list':
      return <PRListCard data={card.data} />;
    case 'commit-list':
      return <CommitListCard data={card.data} />;
    case 'file':
      return <FileCard data={card.data} />;
    case 'branch-list':
      return <BranchListCard data={card.data} />;
    case 'file-list':
      return <FileListCard data={card.data} />;
    case 'sandbox':
      return <SandboxCard data={card.data} />;
    case 'diff-preview':
      return <DiffPreviewCard data={card.data} />;
    case 'audit-verdict':
      return <AuditVerdictCard data={card.data} />;
    case 'commit-review':
      return (
        <CommitReviewCard
          data={card.data}
          messageId={messageId || ''}
          cardIndex={cardIndex ?? 0}
          onAction={onAction}
        />
      );
    case 'ci-status':
      return (
        <CIStatusCard
          data={card.data}
          messageId={messageId || ''}
          cardIndex={cardIndex ?? 0}
          onAction={onAction}
        />
      );
    case 'editor':
      return (
        <EditorCard
          data={card.data}
          messageId={messageId}
          cardIndex={cardIndex}
          onAction={onAction}
        />
      );
    default:
      return null;
  }
}
