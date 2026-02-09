import { Download } from 'lucide-react';
import type { SandboxDownloadCardData } from '@/types';

interface SandboxDownloadCardProps {
  data: SandboxDownloadCardData;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function triggerDownload(base64: string, filename: string): void {
  const raw = atob(base64);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  const blob = new Blob([bytes], { type: 'application/gzip' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function SandboxDownloadCard({ data }: SandboxDownloadCardProps) {
  return (
    <div className="rounded-xl border border-[#1a1a1a] bg-[#0d0d0d] overflow-hidden">
      <div className="px-3 py-2.5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Download className="h-4 w-4 text-emerald-400 flex-shrink-0" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-[#e4e4e7] truncate">
              Workspace archive
            </p>
            <p className="text-[10px] text-[#52525b]">
              {formatBytes(data.sizeBytes)} &middot; {data.format}
            </p>
          </div>
        </div>
        <button
          onClick={() => triggerDownload(data.archiveBase64, `workspace-${Date.now()}.tar.gz`)}
          className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-400 transition-colors hover:bg-emerald-500/20 active:scale-95"
        >
          <Download className="h-3 w-3" />
          Download
        </button>
      </div>
    </div>
  );
}
