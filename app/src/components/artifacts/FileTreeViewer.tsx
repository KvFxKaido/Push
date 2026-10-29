/**
 * Static viewer for a `file-tree` artifact.
 *
 * Lists files in a collapsible left rail; clicking selects one and shows
 * the content in a read-only pane. No JS execution, no Sandpack — this
 * is a snapshot view, not a runtime. Models use `file-tree` for
 * "here are the files I'd write" demos that don't need to run.
 */

import { useMemo, useState } from 'react';
import { FileText, FolderTree } from 'lucide-react';
import type { ArtifactRecord } from '@push/lib/artifacts/types';

interface FileTreeViewerProps {
  record: Extract<ArtifactRecord, { kind: 'file-tree' }>;
}

const VIEWER_HEIGHT_PX = 360;

export function FileTreeViewer({ record }: FileTreeViewerProps) {
  const sortedFiles = useMemo(
    () => [...record.files].sort((a, b) => a.path.localeCompare(b.path)),
    [record.files],
  );
  const [activePath, setActivePath] = useState<string | null>(sortedFiles[0]?.path ?? null);
  const activeFile = sortedFiles.find((f) => f.path === activePath) ?? sortedFiles[0];

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1 text-push-xs text-push-fg-dim">
        <FolderTree className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="truncate">
          File tree • {sortedFiles.length} file{sortedFiles.length === 1 ? '' : 's'}
        </span>
      </div>
      <div
        className="grid grid-cols-[minmax(0,160px)_1fr] gap-0 overflow-hidden rounded-[16px] border border-push-edge/70 bg-black/20"
        style={{ height: VIEWER_HEIGHT_PX }}
      >
        <ul className="overflow-y-auto border-r border-push-edge/70 bg-black/20 p-1">
          {sortedFiles.map((file) => {
            const isActive = file.path === activeFile?.path;
            return (
              <li key={file.path}>
                <button
                  type="button"
                  onClick={() => setActivePath(file.path)}
                  className={`flex w-full items-center gap-1.5 truncate rounded-md px-2 py-1.5 text-left text-push-xs transition-colors ${
                    isActive
                      ? 'bg-push-surface-active text-push-fg'
                      : 'text-push-fg-dim hover:bg-push-surface-hover hover:text-push-fg'
                  }`}
                  aria-pressed={isActive}
                  title={file.path}
                >
                  <FileText className="h-3 w-3 shrink-0" aria-hidden />
                  <span className="truncate">{file.path}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <div className="overflow-auto">
          {activeFile ? (
            <pre className="m-0 whitespace-pre p-3 text-push-xs leading-relaxed text-push-fg-secondary">
              {activeFile.content}
            </pre>
          ) : (
            <div className="flex h-full items-center justify-center text-push-xs text-push-fg-dim">
              No files in this artifact.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default FileTreeViewer;
