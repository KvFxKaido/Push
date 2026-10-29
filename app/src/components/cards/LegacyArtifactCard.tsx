import { CARD_PANEL_CLASS } from '@/lib/utils';

/** Read-only compatibility for saved chats; never executes legacy source. */
export function LegacyArtifactCard({ data }: { data: unknown }) {
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>).record : null;
  const artifact = record && typeof record === 'object' ? (record as Record<string, unknown>) : {};
  const files = Array.isArray(artifact.files) ? artifact.files : [];
  return (
    <div className={`${CARD_PANEL_CLASS} space-y-2 p-3 text-xs`}>
      <div>{typeof artifact.title === 'string' ? artifact.title : 'Legacy artifact'}</div>
      {typeof artifact.kind === 'string' && <div>{artifact.kind}</div>}
      {typeof artifact.source === 'string' && (
        <pre className="overflow-auto whitespace-pre-wrap">{artifact.source}</pre>
      )}
      {files.map((file: unknown, index: number) => {
        if (!file || typeof file !== 'object') return null;
        const entry = file as Record<string, unknown>;
        if (typeof entry.content !== 'string') return null;
        return (
          <details key={index}>
            <summary>{typeof entry.path === 'string' ? entry.path : `File ${index + 1}`}</summary>
            <pre className="overflow-auto whitespace-pre-wrap">{entry.content}</pre>
          </details>
        );
      })}
    </div>
  );
}
