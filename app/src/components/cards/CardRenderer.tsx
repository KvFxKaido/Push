import type { ChatCard } from '@/types';
import { PRCard } from './PRCard';
import { PRListCard } from './PRListCard';
import { CommitListCard } from './CommitListCard';
import { FileCard } from './FileCard';
import { BranchListCard } from './BranchListCard';
import { SandboxCard } from './SandboxCard';
import { DiffPreviewCard } from './DiffPreviewCard';
import { AuditVerdictCard } from './AuditVerdictCard';

export function CardRenderer({ card }: { card: ChatCard }) {
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
    case 'sandbox':
      return <SandboxCard data={card.data} />;
    case 'diff-preview':
      return <DiffPreviewCard data={card.data} />;
    case 'audit-verdict':
      return <AuditVerdictCard data={card.data} />;
    default:
      return null;
  }
}
