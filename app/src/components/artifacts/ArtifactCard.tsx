/**
 * Top-level dispatcher for artifact cards.
 *
 * Picks the right renderer based on `record.kind`. Each renderer is
 * code-split via `lazyWithRecovery` so chats that only show, say,
 * Mermaid diagrams don't pull Sandpack into their bundle, and vice
 * versa. The `Suspense` boundary in `CardRenderer` covers the load
 * fallback for every artifact kind in one place.
 */

import { Suspense } from 'react';
import { CARD_PANEL_CLASS, CARD_SHELL_CLASS } from '@/lib/utils';
import { lazyWithRecovery, toDefaultExport } from '@/lib/lazy-import';
import type { ArtifactCardData } from '@/types';
import type { ArtifactRecord } from '@push/lib/artifacts/types';

const StaticPreview = lazyWithRecovery(
  toDefaultExport(
    () => import('./StaticPreview'),
    (m) => m.StaticPreview,
  ),
);

const MermaidArtifact = lazyWithRecovery(
  toDefaultExport(
    () => import('./MermaidArtifact'),
    (m) => m.MermaidArtifact,
  ),
);

const FileTreeViewer = lazyWithRecovery(
  toDefaultExport(
    () => import('./FileTreeViewer'),
    (m) => m.FileTreeViewer,
  ),
);

const LivePreviewArtifact = lazyWithRecovery(
  toDefaultExport(
    () => import('./LivePreviewArtifact'),
    (m) => m.LivePreviewArtifact,
  ),
);

interface ArtifactCardProps {
  data: ArtifactCardData;
}

function renderBody(record: ArtifactRecord) {
  switch (record.kind) {
    case 'static-html':
    case 'static-react':
      return <StaticPreview record={record} />;
    case 'mermaid':
      return <MermaidArtifact record={record} />;
    case 'file-tree':
      return <FileTreeViewer record={record} />;
    case 'live-preview':
      return <LivePreviewArtifact record={record} />;
    default: {
      // Exhaustiveness fallback — when a new kind lands but the
      // renderer hasn't shipped yet, show a tombstone instead of
      // crashing the chat.
      const _exhaustive: never = record;
      void _exhaustive;
      return (
        <div className="px-3 py-2 text-push-xs text-push-fg-dim">
          Unknown artifact kind — refresh Push to fetch the latest renderer.
        </div>
      );
    }
  }
}

export function ArtifactCard({ data }: ArtifactCardProps) {
  const { record } = data;
  return (
    <div className={CARD_SHELL_CLASS}>
      <div className="px-3.5 py-3">
        <div className="text-push-sm font-medium text-push-fg">{record.title}</div>
        <div className="mt-0.5 text-push-2xs text-push-fg-dim">{record.id}</div>
      </div>
      <div className={`${CARD_PANEL_CLASS} mx-2 mb-2 p-2`}>
        <Suspense fallback={<div className="h-32 animate-pulse rounded-[14px] bg-white/5" />}>
          {renderBody(record)}
        </Suspense>
      </div>
    </div>
  );
}

export default ArtifactCard;
