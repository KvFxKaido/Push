import { ShieldAlert, ShieldCheck, Loader2, Wrench } from 'lucide-react';
import type { CIStatus } from '@/types';
import {
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_PANEL_SUBTLE_SURFACE_CLASS,
  HubControlGlow,
} from '@/components/chat/hub-styles';

interface CIStatusBannerProps {
  status: CIStatus;
  onDiagnose: () => void;
}

export function CIStatusBanner({ status, onDiagnose }: CIStatusBannerProps) {
  const isFailure = status.overall === 'failure';
  const isPending = status.overall === 'pending';

  if (status.overall === 'success' || status.overall === 'no-checks' || status.overall === 'neutral') {
    return null;
  }

  return (
    <div 
      className={`mx-4 mt-5 mb-1 flex items-center justify-between gap-3 px-3.5 py-3 animate-fade-in ${
        isFailure 
          ? 'rounded-[18px] border border-red-500/20 bg-red-500/5' 
          : `${HUB_PANEL_SUBTLE_SURFACE_CLASS}`
      }`}
    >
      <div className="flex items-center gap-3 min-w-0 flex-1">
        {isPending ? (
          <Loader2 className="h-4 w-4 shrink-0 animate-spin text-blue-400" />
        ) : isFailure ? (
          <ShieldAlert className="h-4 w-4 shrink-0 text-red-400" />
        ) : (
          <ShieldCheck className="h-4 w-4 shrink-0 text-blue-400" />
        )}
        <div className="min-w-0">
          <p className={`text-xs font-medium ${
            isFailure ? 'text-red-200' : 'text-blue-200'
          }`}>
            {isFailure ? 'Build failed on current branch' : 'CI is running...'}
          </p>
          <p className={`text-push-xs mt-0.5 truncate ${
            isFailure ? 'text-red-200/60' : 'text-blue-200/60'
          }`}>
            {status.ref} &middot; {status.checks.length} checks
          </p>
        </div>
      </div>

      {isFailure && (
        <button
          onClick={onDiagnose}
          className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} gap-1.5 px-3 text-red-100`}
        >
          <HubControlGlow />
          <Wrench className="relative z-10 h-3 w-3" />
          <span className="relative z-10">Diagnose & Fix</span>
        </button>
      )}
    </div>
  );
}
