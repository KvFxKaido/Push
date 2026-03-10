import { useState, useEffect, useCallback } from 'react';
import { Clock, Download, RefreshCw } from 'lucide-react';
import { downloadFromSandbox } from '@/lib/sandbox-client';

const SANDBOX_LIFETIME_MS = 30 * 60 * 1000; // 30 min (Modal container policy)
const WARNING_THRESHOLD_MS = 5 * 60 * 1000;  // Warn at 5 min remaining

interface SandboxExpiryBannerProps {
  createdAt: number | null;
  sandboxId: string | null;
  sandboxStatus: 'idle' | 'reconnecting' | 'creating' | 'ready' | 'error';
  onRestart: () => void;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return '0:00';
  const totalSeconds = Math.ceil(ms / 1000);
  const min = Math.floor(totalSeconds / 60);
  const sec = totalSeconds % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

export function SandboxExpiryBanner({ createdAt, sandboxId, sandboxStatus, onRestart }: SandboxExpiryBannerProps) {
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);

  // Tick every second to update countdown
  useEffect(() => {
    if (!createdAt || sandboxStatus !== 'ready') {
      setRemainingMs(null);
      return;
    }

    function tick() {
      const elapsed = Date.now() - createdAt!;
      const remaining = SANDBOX_LIFETIME_MS - elapsed;
      setRemainingMs(remaining);
    }

    tick(); // Initial
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [createdAt, sandboxStatus]);

  const handleDownload = useCallback(async () => {
    if (!sandboxId || downloading) return;
    setDownloading(true);
    try {
      const result = await downloadFromSandbox(sandboxId);
      if (result.ok && result.archiveBase64) {
        const raw = atob(result.archiveBase64);
        const bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'application/gzip' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `workspace-${Date.now()}.tar.gz`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch {
      // Best effort — user can retry
    } finally {
      setDownloading(false);
    }
  }, [sandboxId, downloading]);

  // Nothing to show when no createdAt, not ready, or plenty of time left
  if (remainingMs === null) return null;

  // Expired
  if (remainingMs <= 0) {
    return (
      <div className="mx-3 mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Clock className="h-4 w-4 text-red-400 flex-shrink-0" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-red-300">Sandbox expired</p>
            <p className="text-push-2xs text-red-400/70">Workspace contents are no longer available.</p>
          </div>
        </div>
        <button
          onClick={onRestart}
          className="flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/20 active:scale-95 flex-shrink-0"
        >
          <RefreshCw className="h-3 w-3" />
          New sandbox
        </button>
      </div>
    );
  }

  // Warning zone (5 min remaining)
  if (remainingMs <= WARNING_THRESHOLD_MS) {
    return (
      <div className="mx-3 mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Clock className="h-4 w-4 text-amber-400 flex-shrink-0" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-amber-300">
              {formatRemaining(remainingMs)} remaining
            </p>
            <p className="text-push-2xs text-amber-400/70">
              Download your work before the sandbox expires.
            </p>
          </div>
        </div>
        <button
          onClick={handleDownload}
          disabled={downloading}
          className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-400 transition-colors hover:bg-emerald-500/20 active:scale-95 disabled:opacity-50 flex-shrink-0"
        >
          <Download className="h-3 w-3" />
          {downloading ? 'Downloading...' : 'Download'}
        </button>
      </div>
    );
  }

  // Not in warning zone yet — don't render
  return null;
}
