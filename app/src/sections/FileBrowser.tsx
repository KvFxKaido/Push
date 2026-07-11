/**
 * FileBrowser — full-screen file browser for the active workspace.
 *
 * Shows a directory listing, breadcrumb navigation, upload FAB,
 * and workspace-specific actions.
 * All operations go through the workspace runtime — no LLM involvement.
 */

import { useEffect, useMemo, useState, useCallback } from 'react';
import {
  Folder,
  ChevronRight,
  Download,
  MessageSquare,
  Loader2,
  AlertCircle,
  RefreshCw,
  RotateCcw,
  Save,
} from 'lucide-react';
import { toast } from 'sonner';
import { useFileBrowser } from '@/hooks/useFileBrowser';
import { ChatBackgroundGlow } from '@/components/chat/ChatBackgroundGlow';
import type { RepoAppearanceGlowStyleId } from '@/lib/repo-appearance';
import { FileActionsSheet } from '@/components/filebrowser/FileActionsSheet';
import { FilesTable } from '@/components/filebrowser/FilesTable';
import { UploadButton } from '@/components/filebrowser/UploadButton';
import { CommitPushSheet } from '@/components/filebrowser/CommitPushSheet';
import { FileEditor } from '@/components/filebrowser/FileEditor';
import { CommitPulseIcon } from '@/components/icons/push-custom-icons';
import { getFileEditability } from '@/lib/file-utils';
import { writeToSandbox } from '@/lib/sandbox-client';
import { fileLedger } from '@/lib/file-awareness-ledger';
import { resolveActiveGitBinding } from '@/lib/git-session';
import type {
  AIProviderType,
  BranchSwitchPayload,
  FileEntry,
  WorkspaceCapabilities,
  WorkspaceScratchActions,
} from '@/types';

interface FileBrowserProps {
  sandboxId: string;
  workspaceLabel: string;
  capabilities: Pick<WorkspaceCapabilities, 'canCommitAndPush'>;
  scratchActions?: WorkspaceScratchActions | null;
  onBack: () => void;
  lockedProvider?: AIProviderType | null;
  lockedModel?: string | null;
  /** Active repo, threaded to the commit gate so per-repo overrides apply. */
  repoFullName?: string | null;
  /** Recovery callback for the commit/push pipeline when the sandbox dies. */
  onSandboxExpired?: () => Promise<string | null>;
  /** Push's active branch + repo default, for auto-branch-on-commit in the
   *  file-browser commit flow. Omitted → the seam no-ops (commits as today). */
  currentBranch?: string;
  defaultBranch?: string;
  /** Applies a `branchSwitch` payload (chat migration) after the commit flow
   *  auto-branches off the default branch. Wired to `applyBranchSwitchFromUI`. */
  onBranchSwitchPayload?: (payload: BranchSwitchPayload) => void;
  /**
   * Repo accent color hex. When paired with `glowEnabled`, renders the
   * same `<ChatBackgroundGlow>` ambient wash chat uses, so navigating
   * between chat and file browser inside the same repo feels continuous.
   * Optional — scratch workspaces and tests omit it (no glow).
   */
  accentHex?: string | null;
  /** Mirrors `RepoAppearance.glowEnabled`. Toggle off without losing the accent. */
  glowEnabled?: boolean;
  /** Mirrors `RepoAppearance.glowStyle`; picks the gradient or dotted treatment. */
  glowStyle?: RepoAppearanceGlowStyleId;
}

export function FileBrowser({
  sandboxId,
  workspaceLabel,
  capabilities,
  scratchActions,
  onBack,
  lockedProvider,
  lockedModel,
  repoFullName,
  onSandboxExpired,
  currentBranch,
  defaultBranch,
  onBranchSwitchPayload,
  accentHex,
  glowEnabled = false,
  glowStyle = 'gradient',
}: FileBrowserProps) {
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
  const [editingFile, setEditingFile] = useState<FileEntry | null>(null);
  const canCommitAndPush = capabilities.canCommitAndPush;
  const activeGitBinding = useMemo(
    () =>
      resolveActiveGitBinding({
        sandboxId,
        repoFullName: repoFullName ?? undefined,
        branch: currentBranch,
      }),
    [sandboxId, repoFullName, currentBranch],
  );
  const nativeCommitPushUnavailable = canCommitAndPush && activeGitBinding.kind === 'native';
  const commitPushSheetAvailable = canCommitAndPush && !nativeCommitPushUnavailable;
  const showScratchActions = !canCommitAndPush && Boolean(scratchActions);

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

  const handleFilePress = useCallback(
    (file: FileEntry) => {
      if (file.type === 'directory') {
        navigateTo(file.path);
      } else {
        // Check if file is editable - if so, go straight to editor
        const editability = getFileEditability(file.path, file.size);
        if (editability.editable) {
          setEditingFile(file);
        } else {
          // Non-editable files still show actions sheet
          setSelectedFile(file);
          setSheetOpen(true);
        }
      }
    },
    [navigateTo],
  );

  const handleLongPress = useCallback((file: FileEntry) => {
    setSelectedFile(file);
    setSheetOpen(true);
  }, []);

  const handleDelete = useCallback(
    (path: string) => {
      deleteItem(path);
    },
    [deleteItem],
  );

  const handleEdit = useCallback((file: FileEntry) => {
    setEditingFile(file);
  }, []);

  const handleSaveFile = useCallback(
    async (
      path: string,
      content: string,
      expectedVersion?: string,
      expectedWorkspaceRevision?: number,
    ) => {
      const result = await writeToSandbox(
        sandboxId,
        path,
        content,
        expectedVersion,
        expectedWorkspaceRevision,
      );
      if (result.ok) fileLedger.recordMutation(path, 'user');
      if (!result.ok) {
        if (result.code === 'WORKSPACE_CHANGED') {
          const expected =
            result.expected_workspace_revision ?? expectedWorkspaceRevision ?? 'unknown';
          const current =
            result.current_workspace_revision ?? result.workspace_revision ?? 'unknown';
          throw new Error(
            `Workspace changed since last read (expected revision ${expected}, current ${current}). Re-open and retry.`,
          );
        }
        if (result.code === 'STALE_FILE') {
          const expected = result.expected_version || expectedVersion || 'unknown';
          const current = result.current_version || 'missing';
          throw new Error(
            `File changed since last read (expected ${expected}, current ${current}). Re-open and retry.`,
          );
        }
        throw new Error(result.error || 'Save failed');
      }
      return result;
    },
    [sandboxId],
  );

  const handleUpload = useCallback(
    (fileList: FileList) => {
      uploadFiles(fileList);
    },
    [uploadFiles],
  );

  // If editing, show the editor instead of file browser
  if (editingFile) {
    return (
      <FileEditor
        file={editingFile}
        sandboxId={sandboxId}
        onBack={() => {
          setEditingFile(null);
          // Refresh directory in case of changes
          loadDirectory(currentPath);
        }}
        onSave={handleSaveFile}
      />
    );
  }

  const isRoot = currentPath === '/workspace' || currentPath === '/';

  // Glow-stacking mirrors ChatScreen / ChatSurfaceScreen: outer is the
  // page-bg layer, `relative isolate` opens a stacking context so the
  // glow's `-z-10` sits behind sibling content but ABOVE the outer
  // element's own background paint. The header (`bg-push-grad-panel`)
  // and the floating commit drawer stay opaque on purpose — the glow
  // only bleeds through the transparent file-list area, matching how it
  // bleeds through the chat-message column.
  //
  // `overflow-hidden` is required to clip the glow blobs' keyframe
  // translate during drift animation — same constraint chat shells
  // carry. Existing FAB + commit drawer use `position: fixed` so they
  // anchor to the viewport, not this element's content box, and remain
  // visible through the clip. If a future descendant introduces an
  // ancestor-side `transform`/`will-change`/`filter` it would turn this
  // element into a containing block for fixed children and they'd start
  // clipping; revisit then.
  const showGlow = glowEnabled && !!accentHex;

  return (
    <div className="relative isolate flex h-dvh flex-col overflow-hidden bg-push-surface-inset safe-area-top">
      {showGlow && <ChatBackgroundGlow active={true} color={accentHex} variant={glowStyle} />}
      {/* Header */}
      <header className="relative z-10 flex items-center gap-2 border-b border-push-edge-subtle bg-push-grad-panel px-3 py-3">
        <button
          onClick={onBack}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-push-edge bg-push-surface text-push-fg-secondary transition-colors hover:border-push-edge-hover hover:bg-push-surface-hover hover:text-push-fg active:scale-95"
          aria-label="Back to chat"
        >
          <MessageSquare className="h-4 w-4" />
        </button>

        {/* Breadcrumbs \u2014 scrollable on narrow screens */}
        <nav className="flex-1 min-w-0 overflow-x-auto" aria-label="File path">
          <ol className="flex items-center gap-1 text-sm whitespace-nowrap">
            <li>
              <button
                onClick={() => loadDirectory('/workspace')}
                className={`px-1.5 py-0.5 rounded transition-colors ${
                  isRoot ? 'font-medium text-push-fg' : 'text-push-fg-secondary hover:text-push-fg'
                }`}
              >
                {workspaceLabel}
              </button>
            </li>
            {breadcrumbs.slice(1).map((crumb, i) => {
              const isLast = i === breadcrumbs.length - 2;
              return (
                <li key={crumb.path} className="flex items-center gap-1">
                  <ChevronRight className="h-3 w-3 shrink-0 text-push-fg-dim" />
                  <button
                    onClick={() => loadDirectory(crumb.path)}
                    className={`px-1.5 py-0.5 rounded transition-colors ${
                      isLast
                        ? 'font-medium text-push-fg'
                        : 'text-push-fg-secondary hover:text-push-fg'
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
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-push-edge bg-push-surface text-push-fg-dim transition-colors hover:border-push-edge-hover hover:bg-push-surface-hover hover:text-push-fg-soft active:scale-95 disabled:opacity-40"
          aria-label="Refresh directory"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${status === 'loading' ? 'animate-spin' : ''}`} />
        </button>
      </header>

      {/* File list */}
      <div className="flex-1 overflow-y-auto overscroll-contain pb-28">
        {status === 'loading' && files.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-push-fg-faint">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Loading\u2026</span>
          </div>
        ) : status === 'error' ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 px-6 text-center">
            <AlertCircle className="h-5 w-5 text-push-status-error/70" />
            <p className="text-sm text-push-fg-secondary">{error}</p>
            <button
              onClick={() => loadDirectory(currentPath)}
              className="text-xs text-push-accent hover:underline"
            >
              Retry
            </button>
          </div>
        ) : files.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-push-fg-faint">
            <Folder className="h-5 w-5" />
            <span className="text-sm">Empty directory</span>
          </div>
        ) : (
          <FilesTable
            files={files}
            isRoot={isRoot}
            onNavigateUp={navigateUp}
            onTap={handleFilePress}
            onLongPress={handleLongPress}
          />
        )}
      </div>

      {/* Repo-backed workspaces show commit/push; scratch workspaces show save/restore/download. */}
      {canCommitAndPush && (
        <button
          onClick={() => {
            if (nativeCommitPushUnavailable) {
              toast.error('Commit & Push from Files is not available for native workspaces yet.');
              return;
            }
            setCommitSheetOpen(true);
          }}
          disabled={status === 'loading'}
          className="fixed bottom-6 right-[4.75rem] z-30 flex h-12 w-12 items-center justify-center rounded-full bg-push-status-success text-white shadow-lg shadow-push-status-success/25 transition-all duration-200 hover:brightness-110 active:scale-95 disabled:opacity-40 disabled:pointer-events-none"
          title={
            nativeCommitPushUnavailable
              ? 'Native file-browser commit is not available yet'
              : 'Commit & push'
          }
          aria-label={
            nativeCommitPushUnavailable
              ? 'Native file-browser commit is not available yet'
              : 'Commit and push changes'
          }
        >
          <CommitPulseIcon className="h-5 w-5" />
        </button>
      )}

      {showScratchActions && scratchActions && (
        <div className="fixed bottom-6 left-4 right-[5.5rem] z-30 rounded-[20px] border border-push-edge bg-push-grad-panel/95 px-3 py-2.5 shadow-[0_16px_40px_rgba(0,0,0,0.42)] backdrop-blur-xl">
          <div className="min-w-0">
            <p className="text-[10px] uppercase tracking-[0.18em] text-push-fg-dim">Workspace</p>
            <p
              className={`mt-1 truncate text-push-2xs ${scratchActions.tone === 'stale' ? 'text-amber-300' : 'text-push-fg-dim'}`}
            >
              {scratchActions.statusText}
            </p>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            <button
              onClick={scratchActions.onSaveSnapshot}
              disabled={!scratchActions.canSaveSnapshot || scratchActions.snapshotRestoring}
              className="flex items-center justify-center gap-1 rounded-xl border border-push-edge bg-push-surface px-2 py-2 text-push-xs text-push-fg-secondary transition-colors hover:border-push-edge-hover hover:text-push-fg disabled:opacity-40"
              title="Save snapshot"
              aria-label="Save snapshot"
            >
              {scratchActions.snapshotSaving ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Save className="h-3.5 w-3.5" />
              )}
              <span>Save</span>
            </button>
            <button
              onClick={scratchActions.onRestoreSnapshot}
              disabled={!scratchActions.canRestoreSnapshot || scratchActions.snapshotSaving}
              className="flex items-center justify-center gap-1 rounded-xl border border-push-edge bg-push-surface px-2 py-2 text-push-xs text-push-fg-secondary transition-colors hover:border-push-edge-hover hover:text-push-fg disabled:opacity-40"
              title="Restore snapshot"
              aria-label="Restore snapshot"
            >
              {scratchActions.snapshotRestoring ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <RotateCcw className="h-3.5 w-3.5" />
              )}
              <span>Restore</span>
            </button>
            <button
              onClick={scratchActions.onDownloadWorkspace}
              disabled={!scratchActions.canDownloadWorkspace}
              className="flex items-center justify-center gap-1 rounded-xl border border-push-edge bg-push-surface px-2 py-2 text-push-xs text-push-fg-secondary transition-colors hover:border-push-edge-hover hover:text-push-fg disabled:opacity-40"
              title="Download workspace"
              aria-label="Download workspace"
            >
              {scratchActions.downloadingWorkspace ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              <span>Download</span>
            </button>
          </div>
        </div>
      )}

      {/* Upload FAB */}
      <UploadButton onUpload={handleUpload} disabled={status === 'loading'} />

      {/* File actions sheet */}
      <FileActionsSheet
        file={selectedFile}
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        onDelete={handleDelete}
        onEdit={handleEdit}
      />

      {/* Commit & push is only available when the workspace has Git remote capabilities. */}
      {commitPushSheetAvailable && (
        <CommitPushSheet
          sandboxId={sandboxId}
          open={commitSheetOpen}
          onOpenChange={setCommitSheetOpen}
          lockedProvider={lockedProvider}
          lockedModel={lockedModel}
          repoFullName={repoFullName}
          onSandboxExpired={onSandboxExpired}
          currentBranch={currentBranch}
          defaultBranch={defaultBranch}
          onBranchSwitchPayload={onBranchSwitchPayload}
          onSuccess={() => {
            toast.success('Committed and pushed!');
            loadDirectory(currentPath);
          }}
        />
      )}
    </div>
  );
}
