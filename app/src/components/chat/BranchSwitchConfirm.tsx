import { Loader2 } from 'lucide-react';
import {
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_PANEL_SUBTLE_SURFACE_CLASS,
} from '@/components/chat/hub-styles';
import type { BranchSwitchProbe } from '@/lib/branch-switch-probe';

interface BranchSwitchConfirmProps {
  branch: string;
  probe: BranchSwitchProbe | null;
  error?: string | null;
  switchingMode?: 'warm' | 'clean' | null;
  onConfirm: () => void;
  onCancel: () => void;
  onCleanSwitch?: () => void;
}

export function BranchSwitchConfirm({
  branch,
  probe,
  error,
  switchingMode,
  onConfirm,
  onCancel,
  onCleanSwitch,
}: BranchSwitchConfirmProps) {
  return (
    <div className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} px-3 py-3`}>
      <p className="text-xs text-push-fg-secondary">
        Switch to <span className="font-medium text-push-fg">{branch}</span>?
      </p>
      <p className="mt-1.5 text-push-xs text-push-fg-dim">
        {probe?.noSandbox
          ? 'No sandbox is running, so the next start will open this branch.'
          : probe?.loading
            ? 'Checking sandbox changes...'
            : probe?.dirty
              ? probe.unknown
                ? 'Sandbox changes could not be verified. Treating the tree as dirty.'
                : `${probe.changedFiles} changed file${probe.changedFiles === 1 ? '' : 's'} will carry into the switch.`
              : 'Sandbox is clean. The warm switch preserves the running workspace.'}
      </p>
      {probe?.errorMessage && (
        <p className="mt-1 text-push-xs text-red-300">{probe.errorMessage}</p>
      )}
      {error && <p className="mt-1 text-push-xs text-red-300">{error}</p>}
      <div className="mt-3 flex items-center gap-2">
        <button
          onClick={onConfirm}
          disabled={Boolean(switchingMode) || probe?.loading}
          className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-3 disabled:opacity-50`}
        >
          {switchingMode === 'warm' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          <span>{probe?.dirty && !probe.noSandbox ? 'Switch and carry changes' : 'Switch'}</span>
        </button>
        {onCleanSwitch && !probe?.noSandbox && (
          <button
            onClick={onCleanSwitch}
            disabled={Boolean(switchingMode) || probe?.loading}
            className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-3 disabled:opacity-50`}
          >
            {switchingMode === 'clean' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            <span>
              {probe?.dirty && !probe.unknown && probe.changedFiles > 0
                ? `Clean switch (${probe.changedFiles})`
                : 'Clean switch'}
            </span>
          </button>
        )}
        <button
          onClick={onCancel}
          disabled={Boolean(switchingMode)}
          className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-3 disabled:opacity-50`}
        >
          <span>Cancel</span>
        </button>
      </div>
    </div>
  );
}
