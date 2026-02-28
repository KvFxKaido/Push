import { useState, useMemo } from 'react';
import { ShieldAlert, ShieldCheck, Loader2, Wrench } from 'lucide-react';
import type { CIStatus } from '@/types';

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
      className={`mx-4 mt-2 mb-1 rounded-xl border px-3.5 py-3 flex items-center justify-between gap-3 animate-fade-in-down ${
        isFailure 
          ? 'border-red-500/20 bg-red-500/5' 
          : 'border-blue-500/20 bg-blue-500/5'
      }`}
    >
      <div className="flex items-center gap-3 min-w-0 flex-1">
        <div className={`shrink-0 flex h-8 w-8 items-center justify-center rounded-lg ${
          isFailure ? 'bg-red-500/10 text-red-400' : 'bg-blue-500/10 text-blue-400'
        }`}>
          {isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : isFailure ? (
            <ShieldAlert className="h-4 w-4" />
          ) : (
            <ShieldCheck className="h-4 w-4" />
          )}
        </div>
        <div className="min-w-0">
          <p className={`text-xs font-medium ${
            isFailure ? 'text-red-200' : 'text-blue-200'
          }`}>
            {isFailure ? 'Build failed on current branch' : 'CI is running...'}
          </p>
          <p className={`text-[11px] mt-0.5 truncate ${
            isFailure ? 'text-red-200/60' : 'text-blue-200/60'
          }`}>
            {status.ref} &middot; {status.checks.length} checks
          </p>
        </div>
      </div>

      {isFailure && (
        <button
          onClick={onDiagnose}
          className="flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-900/20 px-3 py-1.5 text-xs font-medium text-red-100 transition-colors hover:bg-red-900/30 active:scale-95"
        >
          <Wrench className="h-3 w-3" />
          Diagnose & Fix
        </button>
      )}
    </div>
  );
}
