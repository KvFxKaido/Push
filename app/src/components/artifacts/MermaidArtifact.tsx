/**
 * Mermaid diagram renderer.
 *
 * Mermaid is heavy (~700 KB minified) — pull it in via dynamic import
 * inside an effect so chats that never render a diagram don't pay the
 * download cost. On render failure we surface the parse error inline
 * and fall back to the raw source so the model's intent is still
 * inspectable.
 */

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Workflow } from 'lucide-react';
import type { ArtifactRecord } from '@push/lib/artifacts/types';

interface MermaidArtifactProps {
  record: Extract<ArtifactRecord, { kind: 'mermaid' }>;
}

let renderCounter = 0;

export function MermaidArtifact({ record }: MermaidArtifactProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const id = `push-mermaid-${++renderCounter}`;
    setSvg(null);
    setError(null);

    (async () => {
      try {
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: 'dark',
          securityLevel: 'strict',
        });
        const result = await mermaid.render(id, record.source);
        if (!cancelled) setSvg(result.svg);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [record.source]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1 text-push-xs text-push-fg-dim">
        <Workflow className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate">Mermaid diagram</span>
      </div>
      <div
        ref={containerRef}
        className="overflow-auto rounded-[16px] border border-push-edge/70 bg-black/30 p-4"
      >
        {error ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-push-sm text-push-status-error">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
              <span>Mermaid render failed: {error}</span>
            </div>
            <pre className="overflow-x-auto rounded bg-black/40 p-2 text-push-xs text-push-fg-dim">
              {record.source}
            </pre>
          </div>
        ) : svg ? (
          // mermaid produces a self-contained SVG string we own; safe to
          // inject as innerHTML because the source ran through mermaid's
          // strict security level above.
          <div dangerouslySetInnerHTML={{ __html: svg }} />
        ) : (
          <div className="h-24 animate-pulse rounded bg-white/5" />
        )}
      </div>
    </div>
  );
}

export default MermaidArtifact;
