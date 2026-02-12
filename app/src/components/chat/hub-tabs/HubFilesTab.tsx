import { useCallback, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  File,
  Folder,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { readFromSandbox } from '@/lib/sandbox-client';
import { formatSize } from '@/lib/diff-utils';
import { useFileBrowser } from '@/hooks/useFileBrowser';

interface HubFilesTabProps {
  sandboxId: string | null;
  sandboxStatus: 'idle' | 'creating' | 'ready' | 'error';
  ensureSandbox: () => Promise<string | null>;
}

export function HubFilesTab({ sandboxId, sandboxStatus, ensureSandbox }: HubFilesTabProps) {
  const [startingSandbox, setStartingSandbox] = useState(false);
  const [previewPath, setPreviewPath] = useState<string | null>(null);
  const [previewContent, setPreviewContent] = useState('');
  const [previewTruncated, setPreviewTruncated] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);

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
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-push-edge bg-[#080b10]/95 px-3 text-xs text-push-fg-secondary transition-colors hover:border-push-edge-hover hover:text-push-fg disabled:opacity-50"
        >
          {(startingSandbox || sandboxStatus === 'creating') && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {startingSandbox || sandboxStatus === 'creating' ? 'Starting sandbox...' : 'Start sandbox'}
        </button>
      </div>
    );
  }

  if (previewPath) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center justify-between gap-2 border-b border-push-edge px-3 py-2">
          <button
            onClick={() => {
              setPreviewPath(null);
              setPreviewContent('');
              setPreviewTruncated(false);
            }}
            className="inline-flex h-8 items-center gap-1 rounded-lg border border-push-edge bg-[#080b10]/95 px-2 text-[11px] text-push-fg-dim hover:border-push-edge-hover hover:text-push-fg-secondary"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Back
          </button>
          <p className="truncate text-xs text-push-fg-secondary">{previewPath}</p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {previewLoading ? (
            <div className="flex items-center gap-2 text-xs text-push-fg-dim">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading file...
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-words rounded-lg border border-push-edge bg-push-surface p-3 font-mono text-xs text-push-fg-secondary">
              {previewContent}
            </pre>
          )}
          {previewTruncated && (
            <p className="mt-2 text-[10px] text-push-fg-dim">File output truncated.</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center gap-2 border-b border-push-edge px-3 py-2">
        <nav className="min-w-0 flex-1 overflow-x-auto" aria-label="Path">
          <ol className="flex items-center gap-1 whitespace-nowrap text-[11px] text-push-fg-dim">
            {breadcrumbs.map((crumb, index) => {
              const isLast = index === breadcrumbs.length - 1;
              return (
                <li key={crumb.path} className="flex items-center gap-1">
                  {index > 0 && <ChevronRight className="h-3 w-3 text-[#5f6b80]" />}
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
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-push-edge bg-[#080b10]/95 text-push-fg-dim hover:border-push-edge-hover hover:text-push-fg-secondary disabled:opacity-50"
          aria-label="Refresh directory"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${fileStatus === 'loading' ? 'animate-spin' : ''}`} />
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
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs text-push-fg-dim hover:bg-[#0d1119]"
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
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-[#0d1119]"
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
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#5f6b80]" />
                  ) : (
                    <span className="shrink-0 text-[10px] text-push-fg-dim">
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
