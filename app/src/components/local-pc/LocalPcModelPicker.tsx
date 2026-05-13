/**
 * LocalPcModelPicker — provider/model status chip for the local-pc
 * chat input area. Phase 1.f deferred-polish item from the
 * Remote Sessions decision doc: before this, the local-pc chat
 * silently used whatever provider/model the user last picked on
 * the cloud surface, with no in-chat surface to see or change it.
 *
 * Scope: a popover chip that
 *   - shows the current orchestrator provider + model,
 *   - lets the user switch providers in-place via
 *     `setPreferredProvider`, and
 *   - hands off model-id editing to Settings (per-provider model
 *     wiring is a sizable surface and lives there already; the chip
 *     is for "which backend am I using right now").
 *
 * Why "orchestrator" specifically: the local-pc chat doesn't expose
 * per-role model selection (no Reviewer / Auditor / Coder UI in the
 * input area); the orchestrator's model is what the user actually
 * talks to. The cloud chat's full per-role picker stays in Settings.
 */
import { ChevronDown, Cpu, ExternalLink } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  formatModelDisplayName,
  getModelDisplayLeafName,
  getModelForRole,
  type PreferredProvider,
} from '@/lib/providers';
import { cn } from '@/lib/utils';
import type { AIProviderType } from '@/types';

export interface LocalPcModelPickerProps {
  /** Resolved orchestrator provider (from `getActiveProvider()` upstream). */
  activeProvider: AIProviderType;
  /**
   * `useModelCatalog().availableProviders`. Tuples of
   * `[providerId, displayLabel, isReady]`. Only ready providers are
   * shown; an unready provider isn't a sensible switch target.
   */
  availableProviders: readonly (readonly [PreferredProvider, string, boolean])[];
  /** Calls into `useModelCatalog().setPreferredProvider`. */
  onSelectProvider: (provider: PreferredProvider) => void;
  /**
   * Navigate to the Settings surface so the user can edit per-provider
   * model ids. Optional — when omitted the "Edit models in Settings"
   * row is hidden so the chip stays useful as a read-only display
   * even on test rigs that don't wire navigation.
   */
  onOpenSettings?: () => void;
  disabled?: boolean;
  className?: string;
}

export function LocalPcModelPicker({
  activeProvider,
  availableProviders,
  onSelectProvider,
  onOpenSettings,
  disabled,
  className,
}: LocalPcModelPickerProps) {
  // Orchestrator model id — `getModelForRole` resolves the user-
  // configured model name via MODEL_NAME_GETTERS, so the chip's
  // display follows the same source of truth Settings writes to.
  // A missing model (e.g. provider configured but no model picked
  // yet) falls back to the bare provider label.
  const modelEntry = getModelForRole(activeProvider, 'orchestrator');
  const modelId = modelEntry?.id ?? '';
  const providerLabel =
    availableProviders.find(([id]) => id === activeProvider)?.[1] ?? activeProvider;
  const modelLeaf = modelId ? getModelDisplayLeafName(activeProvider, modelId) : null;
  const titleHint = modelId
    ? `${providerLabel} · ${formatModelDisplayName(activeProvider, modelId)}`
    : providerLabel;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Local PC model and provider"
          title={titleHint}
          disabled={disabled}
          className={cn(
            'inline-flex max-w-full items-center gap-1.5 rounded-full border border-push-edge/60 bg-[#070a10] px-2.5 py-1 text-xs text-push-fg-secondary transition hover:border-push-edge hover:text-push-fg disabled:opacity-50',
            className,
          )}
        >
          <Cpu className="h-3 w-3 shrink-0 text-push-fg-secondary" aria-hidden="true" />
          <span className="truncate">
            <span className="text-push-fg-secondary/80">{providerLabel}</span>
            {modelLeaf ? (
              <>
                <span className="mx-1 text-push-fg-secondary/40">·</span>
                <span className="text-push-fg">{modelLeaf}</span>
              </>
            ) : null}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 border-push-edge/60 bg-[#0d1117] p-1 text-push-fg shadow-md"
      >
        <div className="px-2 py-1.5 text-[10px] uppercase tracking-wide text-push-fg-secondary/60">
          Provider
        </div>
        <div role="radiogroup" aria-label="Provider">
          {availableProviders.map(([id, label]) => {
            const active = id === activeProvider;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => onSelectProvider(id)}
                className={cn(
                  'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition',
                  active
                    ? 'bg-push-edge/50 text-push-fg'
                    : 'text-push-fg-secondary hover:bg-push-edge/30 hover:text-push-fg',
                )}
              >
                <span className="truncate">{label}</span>
                {active ? <span aria-hidden="true">✓</span> : null}
              </button>
            );
          })}
          {availableProviders.length === 0 ? (
            <p className="px-2 py-2 text-xs text-push-fg-secondary/70">
              No providers configured. Add an API key in Settings.
            </p>
          ) : null}
        </div>
        {onOpenSettings ? (
          <>
            <div className="my-1 border-t border-push-edge/30" />
            <button
              type="button"
              onClick={onOpenSettings}
              className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs text-push-fg-secondary transition hover:bg-push-edge/30 hover:text-push-fg"
            >
              <span>Edit models in Settings</span>
              <ExternalLink className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
            </button>
          </>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
