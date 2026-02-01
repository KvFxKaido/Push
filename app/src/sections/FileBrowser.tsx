/**
 * FileBrowser — full-screen file browser for the active sandbox.
 *
 * Shows a directory listing, breadcrumb navigation, upload FAB,
 * and a bottom sheet for file actions (rename/delete).
 * All operations go through the sandbox client — no LLM involvement.
 */

import { useEffect, useState, useCallback } from 'react';
import {
  Folder,
  File,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
  Loader2,
  AlertCircle,
  RefreshCw,
  GitCommitHorizontal,
} from 'lucide-react';
import { toast } from 'sonner';
import { useFileBrowser } from '@/hooks/useFileBrowser';
import { FileActionsSheet } from '@/components/filebrowser/FileActionsSheet';
import { UploadButton } from '@/components/filebrowser/UploadButton';
import { CommitPushSheet } from '@/components/filebrowser/CommitPushSheet';
import type { FileEntry } from '@/types';

interface FileBrowserProps {
  sandboxId: string;
  repoName: string;
  onBack: () => void;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileBrowser({ sandboxId, repoName, onBack }: FileBrowserProps) {
  const {
    currentPath,
    files,
    status,
    error,
    operations,
    breadcrumbs,
    loadDirectory,
    navigateTo,
    navigateUp,
    uploadFiles,
    deleteItem,
  } = useFileBrowser(sandboxId);

  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [commitSheetOpen, setCommitSheetOpen] = useState(false);

  // Load root directory on mount
  useEffect(() => {
    loadDirectory('/workspace');
  }, [loadDirectory]);

  // Show toast notifications for operations
  useEffect(() => {
    if (operations.length === 0) return;
    const latest = operations[0];
    // Only show toasts for operations that happened in the last 2 seconds
    if (Date.now() - latest.timestamp > 2000) return;

    if (latest.status === 'success') {
      toast.success(latest.message);
    } else {
      toast.error(latest.message);
    }
  }, [operations]);

  const handleFilePress = useCallback((file: FileEntry) => {
    if (file.type === 'directory') {
      navigateTo(file.path);
    } else {
      setSelectedFile(file);
      setSheetOpen(true);
    }
  }, [navigateTo]);

  const handleLongPress = useCallback((file: FileEntry) => {
    setSelectedFile(file);
    setSheetOpen(true);
  }, []);

  const handleDelete = useCallback((path: string) => {
    deleteItem(path);
  }, [deleteItem]);

  const handleUpload = useCallback((fileList: FileList) => {
    uploadFiles(fileList);
  }, [uploadFiles]);

  const isRoot = currentPath === '/workspace' || currentPath === '/';

  return (
    <div className="flex h-dvh flex-col bg-[#09090b] safe-area-top">
      {/* Header */}
      <header className="flex items-center gap-2 px-3 py-3 border-b border-[#1a1a1e]">
        <button
          onClick={onBack}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[#a1a1aa] transition-colors hover:text-[#fafafa] hover:bg-[#111113] active:scale-95 shrink-0"
          aria-label="Back to chat"
        >
          <MessageSquare className="h-4 w-4" />
        </button>

        {/* Breadcrumbs — scrollable on narrow screens */}
        <nav className="flex-1 min-w-0 overflow-x-auto" aria-label="File path">
          <ol className="flex items-center gap-1 text-sm whitespace-nowrap">
            <li>
              <button
                onClick={() => loadDirectory('/workspace')}
                className={`px-1.5 py-0.5 rounded transition-colors ${
                  isRoot
                    ? 'text-[#fafafa] font-medium'
                    : 'text-[#a1a1aa] hover:text-[#fafafa]'
                }`}
              >
                {repoName}
              </button>
            </li>
            {breadcrumbs.slice(1).map((crumb, i) => {
              const isLast = i === breadcrumbs.length - 2;
              return (
                <li key={crumb.path} className="flex items-center gap-1">
                  <ChevronRight className="h-3 w-3 text-[#3f3f46] shrink-0" />
                  <button
                    onClick={() => loadDirectory(crumb.path)}
                    className={`px-1.5 py-0.5 rounded transition-colors ${
                      isLast
                        ? 'text-[#fafafa] font-medium'
                        : 'text-[#a1a1aa] hover:text-[#fafafa]'
                    }`}
                  >
                    {crumb.label}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>

        {/* Refresh button */}
        <button
          onClick={() => loadDirectory(currentPath)}
          disabled={status === 'loading'}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-[#52525b] transition-colors hover:text-[#a1a1aa] hover:bg-[#111113] active:scale-95 shrink-0 disabled:opacity-40"
          aria-label="Refresh directory"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${status === 'loading' ? 'animate-spin' : ''}`} />
        </button>
      </header>

      {/* File list */}
      <div className="flex-1 overflow-y-auto overscroll-contain">
        {status === 'loading' && files.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-[#52525b]">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        ) : status === 'error' ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
            <AlertCircle className="h-5 w-5 text-[#ef4444]/70" />
            <p className="text-sm text-[#a1a1aa]">{error}</p>
            <button
              onClick={() => loadDirectory(currentPath)}
              className="text-xs text-[#0070f3] hover:underline"
            >
              Retry
            </button>
          </div>
        ) : files.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-[#52525b]">
            <Folder className="h-5 w-5" />
            <span className="text-sm">Empty directory</span>
          </div>
        ) : (
          <ul className="divide-y divide-[#1a1a1e]/50">
            {/* Navigate up row */}
            {!isRoot && (
              <li>
                <button
                  onClick={navigateUp}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[#111113] active:bg-[#161618]"
                >
                  <ChevronLeft className="h-4 w-4 text-[#52525b] shrink-0" />
                  <span className="text-sm text-[#a1a1aa]">..</span>
                </button>
              </li>
            )}

            {files.map((file) => (
              <FileRow
                key={file.path}
                file={file}
                onTap={handleFilePress}
                onLongPress={handleLongPress}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Commit FAB — positioned left of upload FAB */}
      <button
        onClick={() => setCommitSheetOpen(true)}
        disabled={status === 'loading'}
        className="fixed bottom-6 right-[4.75rem] z-30 flex h-12 w-12 items-center justify-center rounded-full bg-[#22c55e] text-white shadow-lg shadow-[#22c55e]/25 transition-all duration-200 hover:bg-[#16a34a] active:scale-95 disabled:opacity-40 disabled:pointer-events-none"
        title="Commit & push"
        aria-label="Commit and push changes"
      >
        <GitCommitHorizontal className="h-5 w-5" />
      </button>

      {/* Upload FAB */}
      <UploadButton
        onUpload={handleUpload}
        disabled={status === 'loading'}
      />

      {/* File actions sheet */}
      <FileActionsSheet
        file={selectedFile}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onDelete={handleDelete}
      />

      {/* Commit & push sheet */}
      <CommitPushSheet
        sandboxId={sandboxId}
        open={commitSheetOpen}
        onOpenChange={setCommitSheetOpen}
        onSuccess={() => {
          toast.success('Committed and pushed!');
          loadDirectory(currentPath);
        }}
      />
    </div>
  );
}

// --- File row with long-press support ---

interface FileRowProps {
  file: FileEntry;
  onTap: (file: FileEntry) => void;
  onLongPress: (file: FileEntry) => void;
}

function FileRow({ file, onTap, onLongPress }: FileRowProps) {
  const [pressTimer, setPressTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const [didLongPress, setDidLongPress] = useState(false);

  const handlePointerDown = () => {
    setDidLongPress(false);
    const timer = setTimeout(() => {
      setDidLongPress(true);
      onLongPress(file);
    }, 500);
    setPressTimer(timer);
  };

  const handlePointerUp = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      setPressTimer(null);
    }
    if (!didLongPress) {
      onTap(file);
    }
  };

  const handlePointerLeave = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      setPressTimer(null);
    }
  };

  const isDir = file.type === 'directory';

  return (
    <li>
      <button
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-[#111113] active:bg-[#161618] select-none"
      >
        {/* Icon */}
        {isDir ? (
          <Folder className="h-4 w-4 text-[#0070f3] shrink-0" />
        ) : (
          <File className="h-4 w-4 text-[#52525b] shrink-0" />
        )}

        {/* Name + meta */}
        <div className="flex-1 min-w-0">
          <span className={`block text-sm truncate ${isDir ? 'text-[#fafafa]' : 'text-[#a1a1aa]'}`}>
            {file.name}
          </span>
        </div>

        {/* Size (files only) + chevron (dirs only) */}
        {isDir ? (
          <ChevronRight className="h-3.5 w-3.5 text-[#3f3f46] shrink-0" />
        ) : (
          <span className="text-[11px] text-[#52525b] font-mono shrink-0">
            {formatSize(file.size)}
          </span>
        )}
      </button>
    </li>
  );
}
