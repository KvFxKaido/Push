import { useState, useEffect, useCallback, useRef } from 'react';
import { Clock, Download, RefreshCw } from 'lucide-react';
import { downloadFromSandbox } from '@/lib/sandbox-client';
import {
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_TOP_BANNER_STRIP_CLASS,
  HubControlGlow,
} from '@/components/chat/hub-styles';

const SANDBOX_LIFETIME_MS = 30 * 60 * 1000; // 30 min (Modal container policy)
const WARNING_THRESHOLD_MS = 5 * 60 * 1000;  // Warn at 5 min remaining

interface SandboxExpiryBannerProps {
  createdAt: number | null;
  sandboxId: string | null;
  sandboxStatus: 'idle' | 'reconnecting' | 'creating' | 'ready' | 'error';
  onRestart: () => void;
  /** Fired once when 5 min warning threshold is first crossed — used to save an expiry checkpoint. */
  onWarningThresholdReached?: () => void;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return '0:00';
  const totalSeconds = Math.ceil(ms / 1000);
  const min = Math.floor(totalSeconds / 60);
  const sec = totalSeconds % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

export function SandboxExpiryBanner({ createdAt, sandboxId, sandboxStatus, onRestart, onWarningThresholdReached }: SandboxExpiryBannerProps) {
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [downloading, setDownloading] = useState(false);
  const warningFiredRef = useRef(false);

  // Reset the one-shot flag when the sandbox changes (new session).
  useEffect(() => { warningFiredRef.current = false; }, [sandboxId]);

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
      if (remaining <= WARNING_THRESHOLD_MS && !warningFiredRef.current) {
        warningFiredRef.current = true;
        onWarningThresholdReached?.();
      }
    }

    tick(); // Initial
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [createdAt, sandboxStatus, onWarningThresholdReached]);

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
      <div className={`mx-3 mt-5 flex items-center justify-between gap-3 px-1 py-2.5 ${HUB_TOP_BANNER_STRIP_CLASS} border-red-500/25`}>
        <div className="flex min-w-0 items-center gap-2">
          <Clock className="h-4 w-4 flex-shrink-0 text-red-400" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-red-300">Workspace runtime expired</p>
            <p className="text-push-2xs text-red-400/70">This temporary workspace runtime is no longer available.</p>
          </div>
        </div>
        <button
          onClick={onRestart}
          className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} flex-shrink-0 gap-1.5 px-3 text-red-300`}
        >
          <HubControlGlow />
          <RefreshCw className="relative z-10 h-3 w-3" />
          <span className="relative z-10">Restart runtime</span>
        </button>
      </div>
    );
  }

  // Warning zone (5 min remaining)
  if (remainingMs <= WARNING_THRESHOLD_MS) {
    return (
      <div className={`mx-3 mt-5 flex items-center justify-between gap-3 px-1 py-2.5 ${HUB_TOP_BANNER_STRIP_CLASS} border-amber-500/25`}>
        <div className="flex min-w-0 items-center gap-2">
          <Clock className="h-4 w-4 flex-shrink-0 text-amber-400" />
          <div className="min-w-0">
            <p className="text-xs font-medium text-amber-300">
              {formatRemaining(remainingMs)} remaining
            </p>
            <p className="text-push-2xs text-amber-400/70">
              Download your work before this workspace runtime expires.
            </p>
          </div>
        </div>
        <button
          onClick={handleDownload}
          disabled={downloading}
          className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} flex-shrink-0 gap-1.5 px-3 text-emerald-400`}
        >
          <HubControlGlow />
          <Download className="relative z-10 h-3 w-3" />
          <span className="relative z-10">{downloading ? 'Downloading...' : 'Download'}</span>
        </button>
      </div>
    );
  }

  // Not in warning zone yet — don't render
  return null;
}
