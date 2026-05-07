/**
 * Stub for `live-preview` artifacts.
 *
 * Live previews proxy a sandbox-side dev server through a token-scoped
 * iframe URL — the persistence path exists in `lib/artifacts/types.ts`
 * but the worker side (token mint, route registration, sandbox-side
 * `create_live_preview` tool) is not yet wired. Until then the renderer
 * shows the captured metadata so an artifact created out-of-band still
 * reads cleanly in chat.
 */

import { Globe } from 'lucide-react';
import type { ArtifactRecord } from '@push/lib/artifacts/types';

interface LivePreviewArtifactProps {
  record: Extract<ArtifactRecord, { kind: 'live-preview' }>;
}

export function LivePreviewArtifact({ record }: LivePreviewArtifactProps) {
  const expiresIso = new Date(record.expiresAt).toISOString();

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1 text-push-xs text-push-fg-dim">
        <Globe className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate">Live preview</span>
      </div>
      <div className="rounded-[16px] border border-push-edge/70 bg-black/20 p-4">
        <p className="text-push-sm text-push-fg-secondary">Live preview coming soon.</p>
        <p className="mt-1 text-push-xs text-push-fg-dim">
          The model captured a preview target, but the iframe proxy is not yet enabled in this
          build. Metadata is shown for transparency.
        </p>
        <dl className="mt-3 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-push-xs text-push-fg-dim">
          <dt>Sandbox</dt>
          <dd className="truncate text-push-fg-secondary">{record.sandboxId}</dd>
          <dt>Port</dt>
          <dd className="text-push-fg-secondary">{record.port}</dd>
          {record.startCommand ? (
            <>
              <dt>Start</dt>
              <dd className="truncate text-push-fg-secondary">{record.startCommand}</dd>
            </>
          ) : null}
          <dt>Expires</dt>
          <dd className="text-push-fg-secondary">{expiresIso}</dd>
        </dl>
      </div>
    </div>
  );
}

export default LivePreviewArtifact;
