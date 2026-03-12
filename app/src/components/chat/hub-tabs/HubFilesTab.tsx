import { useCallback, useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  Download,
  File,
  Folder,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { downloadFileFromSandbox, readFromSandbox } from '@/lib/sandbox-client';
import { formatSize } from '@/lib/diff-utils';
import { getFileEditability } from '@/lib/file-utils';
import { useFileBrowser } from '@/hooks/useFileBrowser';
import { useCodeMirror } from '@/hooks/useCodeMirror';
import {
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_MATERIAL_ROUND_BUTTON_CLASS,
  HUB_PANEL_SURFACE_CLASS,
  HUB_PANEL_SUBTLE_SURFACE_CLASS,
  HUB_TAG_CLASS,
  HubControlGlow,
} from '@/components/chat/hub-styles';

interface HubFilesTabProps {
  sandboxId: string | null;
  sandboxStatus: 'idle' | 'reconnecting' | 'creating' | 'ready' | 'error';
  ensureSandbox: () => Promise<string | null>;
}

export function HubFilesTab({ sandboxId, sandboxStatus, ensureSandbox }: HubFilesTabProps) {
  const [startingSandbox, setStartingSandbox] = useState(false);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState('');
  const [previewTruncated, setPreviewTruncated] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewDownloading, setPreviewDownloading] = useState(false);
  const previewLanguage = useMemo(
    () => (previewPath ? getFileEditability(previewPath, 0).language : 'text'),
    [previewPath],
  );
  const previewName = useMemo(
    () => (previewPath ? previewPath.split('/').pop() || previewPath : ''),
    [previewPath],
  );
  const previewLineCount = useMemo(
    () => (previewContent ? previewContent.split('\n').length : 0),
    [previewContent],
  );

  const sandboxReady = sandboxStatus === 'ready' && Boolean(sandboxId);

  const {
    currentPath,
    files,
    status: fileStatus,
    error: fileError,
    breadcrumbs,
    loadDirectory,
    navigateTo,
    navigateUp,
  } = useFileBrowser(sandboxId);

  const ensureHubSandbox = useCallback(async (): Promise<string | null> => {
    if (sandboxId) return sandboxId;
    setStartingSandbox(true);
    try {
      const id = await ensureSandbox();
      if (!id) toast.error('Sandbox is not ready yet.');
      return id;
    } finally {
      setStartingSandbox(false);
    }
  }, [sandboxId, ensureSandbox]);

  const loadFilePreview = useCallback(async (path: string) => {
    const id = await ensureHubSandbox();
    if (!id) return;
    setPreviewLoading(true);
    try {
      const result = await readFromSandbox(id, path);
      setPreviewPath(path);
      setPreviewContent(result.content);
      setPreviewTruncated(result.truncated);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to read file');
    } finally {
      setPreviewLoading(false);
    }
  }, [ensureHubSandbox]);

  const handleDownloadPreview = useCallback(async () => {
    if (!previewPath || previewLoading || previewDownloading) return;
    const id = await ensureHubSandbox();
    if (!id) return;

    setPreviewDownloading(true);
    try {
      const result = await downloadFileFromSandbox(id, previewPath);
      if (!result.ok || !result.fileBase64 || !result.filename) {
        throw new Error(result.error || 'Failed to download file');
      }

      const raw = atob(result.fileBase64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);

      const blob = new Blob([bytes], { type: result.contentType || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to download file');
    } finally {
      setPreviewDownloading(false);
    }
  }, [ensureHubSandbox, previewDownloading, previewLoading, previewPath]);

  if (!sandboxReady) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-push-fg-secondary">Start a sandbox to browse files.</p>
        <button
          onClick={() => {
            void ensureHubSandbox().then((id) => {
              if (id) void loadDirectory('/workspace');
            });
          }}
          disabled={startingSandbox || sandboxStatus === 'creating'}
          className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} h-9 px-3 text-push-fg-secondary`}
        >
          <HubControlGlow />
          {(startingSandbox || sandboxStatus === 'creating') && <Loader2 className="relative z-10 h-3.5 w-3.5 animate-spin" />}
          <span className="relative z-10">
            {startingSandbox || sandboxStatus === 'creating' ? 'Starting sandbox...' : 'Start sandbox'}
          </span>
        </button>
      </div>
    );
  }

  if (previewPath) {
    return (
      <div className="flex h-full min-h-0 flex-col p-3">
        <div className={`relative flex min-h-0 flex-1 flex-col overflow-hidden ${HUB_PANEL_SURFACE_CLASS}`}>
          <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-white/[0.04] to-transparent" />
          <div className="relative z-10 flex items-start gap-2 border-b border-push-edge/80 bg-[linear-gradient(180deg,rgba(10,13,20,0.78)_0%,rgba(6,9,14,0.88)_100%)] px-3 py-2.5 backdrop-blur-xl">
            <button
              onClick={() => {
                setPreviewPath(null);
                setPreviewContent('');
                setPreviewTruncated(false);
              }}
              className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} shrink-0 px-2.5`}
            >
              <HubControlGlow />
              <ChevronLeft className="relative z-10 h-3.5 w-3.5" />
              <span className="relative z-10">Back</span>
            </button>
            <div className="min-w-0 flex-1 pt-0.5">
              <p className="truncate text-sm font-medium text-push-fg">{previewName}</p>
              <p className="truncate font-mono text-push-2xs text-push-fg-dim">{previewPath}</p>
            </div>
            <button
              onClick={() => { void handleDownloadPreview(); }}
              disabled={previewDownloading || previewLoading}
              className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} shrink-0 px-2.5`}
              aria-label="Download file"
              title="Download file"
            >
              <HubControlGlow />
              {previewDownloading ? (
                <Loader2 className="relative z-10 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Download className="relative z-10 h-3.5 w-3.5" />
              )}
              <span className="relative z-10">Download</span>
            </button>
          </div>

          <div className="relative min-h-0 flex-1 overflow-hidden p-3">
            <div className="pointer-events-none absolute inset-x-3 top-0 h-10 bg-gradient-to-b from-white/[0.02] to-transparent" />
            {previewLoading ? (
              <div className="relative z-10 flex items-center gap-2 text-xs text-push-fg-dim">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Loading file...
              </div>
            ) : (
              <div className="relative z-10 flex h-full min-h-0 flex-col gap-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={HUB_TAG_CLASS}>{previewLanguage}</span>
                  <span className={HUB_TAG_CLASS}>
                    {previewLineCount} line{previewLineCount === 1 ? '' : 's'}
                  </span>
                  {previewTruncated && <span className={HUB_TAG_CLASS}>Truncated preview</span>}
                </div>
                <ReadOnlyCodePreview
                  content={previewContent}
                  language={previewLanguage}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center gap-2 border-b border-push-edge px-3 py-2">
        <nav className="min-w-0 flex-1 overflow-x-auto" aria-label="Path">
          <ol className="flex items-center gap-1 whitespace-nowrap text-push-xs text-push-fg-dim">
            {breadcrumbs.map((crumb, index) => {
              const isLast = index === breadcrumbs.length - 1;
              return (
                <li key={crumb.path} className="flex items-center gap-1">
                  {index > 0 && <ChevronRight className="h-3 w-3 text-push-fg-dim" />}
                  <button
                    onClick={() => void loadDirectory(crumb.path)}
                    className={isLast ? 'text-push-fg-secondary' : 'hover:text-push-fg-secondary'}
                  >
                    {crumb.label}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
        <button
          onClick={() => void loadDirectory(currentPath)}
          disabled={fileStatus === 'loading'}
          className={HUB_MATERIAL_ROUND_BUTTON_CLASS}
          aria-label="Refresh directory"
        >
          <HubControlGlow />
          <RefreshCw className={`relative z-10 h-3.5 w-3.5 ${fileStatus === 'loading' ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {fileStatus === 'loading' && files.length === 0 ? (
          <div className="flex h-full items-center justify-center gap-2 text-xs text-push-fg-dim">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading files...
          </div>
        ) : fileStatus === 'error' ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center">
            <p className="text-xs text-red-300">{fileError || 'Failed to load files'}</p>
            <button
              onClick={() => void loadDirectory(currentPath)}
              className="text-xs text-push-link hover:underline"
            >
              Retry
            </button>
          </div>
        ) : (
          <ul className="divide-y divide-push-edge">
            {currentPath !== '/workspace' && currentPath !== '/' && (
              <li>
                <button
                  onClick={navigateUp}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs text-push-fg-dim hover:bg-push-surface-hover"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                  ..
                </button>
              </li>
            )}
            {files.map((file) => (
              <li key={file.path}>
                <button
                  onClick={() => {
                    if (file.type === 'directory') {
                      navigateTo(file.path);
                    } else {
                      void loadFilePreview(file.path);
                    }
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-push-surface-hover"
                >
                  {file.type === 'directory' ? (
                    <Folder className="h-4 w-4 shrink-0 text-[#4fb6ff]" />
                  ) : (
                    <File className="h-4 w-4 shrink-0 text-push-fg-dim" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-xs text-push-fg-secondary">
                    {file.name}
                  </span>
                  {file.type === 'directory' ? (
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-push-fg-dim" />
                  ) : (
                    <span className="shrink-0 text-push-2xs text-push-fg-dim">
                      {formatSize(file.size)}
                    </span>
                  )}
                </button>
              </li>
            ))}
            {files.length === 0 && (
              <li className="px-3 py-3 text-xs text-push-fg-dim">Empty directory</li>
            )}
          </ul>
        )}
      </div>
    </>
  );
}

function ReadOnlyCodePreview({ content, language }: { content: string; language: string }) {
  const { containerRef } = useCodeMirror({
    doc: content,
    language,
    readOnly: true,
    lineWrapping: false,
  });

  return (
    <div
      ref={containerRef}
      className={`min-h-0 flex-1 overflow-hidden rounded-[16px] ${HUB_PANEL_SUBTLE_SURFACE_CLASS} [&_.cm-editor]:h-full [&_.cm-editor]:bg-transparent [&_.cm-editor]:text-push-fg-secondary [&_.cm-activeLine]:bg-white/[0.03] [&_.cm-activeLineGutter]:bg-white/[0.03] [&_.cm-activeLineGutter]:text-push-fg-dim [&_.cm-content]:pb-5 [&_.cm-content]:pt-3 [&_.cm-gutters]:border-r [&_.cm-gutters]:border-push-edge/70 [&_.cm-gutters]:bg-white/[0.02] [&_.cm-gutters]:text-push-fg-muted [&_.cm-lineNumbers_.cm-gutterElement]:pr-3 [&_.cm-lineNumbers_.cm-gutterElement]:text-push-2xs [&_.cm-scroller]:!overflow-auto [&_.cm-scroller]:overscroll-contain`}
    />
  );
}
