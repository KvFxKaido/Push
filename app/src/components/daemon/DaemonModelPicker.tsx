/**
 * DaemonModelPicker — provider/model status chip for the daemon-backed
 * chat input area. Phase 1.f deferred-polish item from the
 * Remote Sessions decision doc; renamed from `LocalPcModelPicker` in
 * Phase 2.i once the relay surface started using the same chip
 * verbatim. Both `LocalPcChatScreen` and `RelayChatScreen` mount it
 * via `DaemonChatBody`.
 *
 * Scope: a popover chip that
 *   - shows the current orchestrator provider + model,
 *   - lets the user switch providers in-place via
 *     `setPreferredProvider`, and
 *   - hands off model-id editing to Settings (per-provider model
 *     wiring is a sizable surface and lives there already; the chip
 *     is for "which backend am I using right now").
 *
 * Why "orchestrator" specifically: the daemon-backed chat doesn't
 * expose per-role model selection (no Reviewer / Auditor / Coder UI
 * in the input area); the orchestrator's model is what the user
 * actually talks to. The cloud chat's full per-role picker stays in
 * Settings.
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

export interface DaemonModelPickerProps {
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
   * When the current chat has already sent a message, `useChat`
   * locks the conversation to its original provider (see
   * `lockedProvider` / `prepareSendContext`). The chip surfaces the
   * locked provider AND disables the provider switch — without this
   * the user would see the global preference change in the chip but
   * the next `sendMessage` would still route through the
   * conversation's lock, deceiving them about what the model is.
   * Codex P2 on #522.
   */
  lockedProvider?: AIProviderType | null;
  /** When true, switching providers from this chip is disabled. */
  isProviderLocked?: boolean;
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

export function DaemonModelPicker({
  activeProvider,
  availableProviders,
  onSelectProvider,
  onOpenSettings,
  disabled,
  className,
  lockedProvider,
  isProviderLocked,
}: DaemonModelPickerProps) {
  // When the chat has been locked to a specific provider (e.g. after
  // the first sendMessage), DISPLAY the locked one regardless of
  // the catalog's current preference — that's what the next turn
  // will actually use. Switching is also disabled below so the user
  // doesn't get a chip that lies about provider routing.
  const displayedProvider = (lockedProvider as AIProviderType | undefined) ?? activeProvider;
  // Orchestrator model id — `getModelForRole` resolves the user-
  // configured model name via MODEL_NAME_GETTERS, so the chip's
  // display follows the same source of truth Settings writes to.
  // A missing model (e.g. provider configured but no model picked
  // yet) falls back to the bare provider label.
  const modelEntry = getModelForRole(displayedProvider, 'orchestrator');
  const modelId = modelEntry?.id ?? '';
  // Slice 1.d: docstring promised "only ready providers shown"; the
  // ready filter lives here so callers can safely pass the raw
  // catalog tuple list. Github-actions + Copilot review on #522.
  const readyProviders = availableProviders.filter(([, , isReady]) => isReady);
  const providerLabel =
    readyProviders.find(([id]) => id === displayedProvider)?.[1] ?? displayedProvider;
  const modelLeaf = modelId ? getModelDisplayLeafName(displayedProvider, modelId) : null;
  const titleHint = modelId
    ? `${providerLabel} · ${formatModelDisplayName(displayedProvider, modelId)}`
    : providerLabel;
  const switchDisabled = disabled || isProviderLocked;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Daemon model and provider"
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
        {/*
          aria-pressed (toggle-button semantics) rather than
          role="radiogroup" + role="radio": the latter promises full
          radiogroup keyboard navigation (Arrow keys, roving tabIndex)
          which this list doesn't implement. Toggle-button semantics
          accurately describe what we deliver — each row is a
          clickable button whose pressed state reflects the active
          provider. A future PR can swap in Radix RadioGroup for
          proper keyboard nav; Copilot review on #522.
        */}
        <div aria-label="Provider">
          {readyProviders.map(([id, label]) => {
            const active = id === displayedProvider;
            return (
              <button
                key={id}
                type="button"
                aria-pressed={active}
                onClick={() => onSelectProvider(id)}
                disabled={switchDisabled}
                className={cn(
                  'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition disabled:cursor-not-allowed disabled:opacity-50',
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
          {readyProviders.length === 0 ? (
            <p className="px-2 py-2 text-xs text-push-fg-secondary/70">
              No providers configured. Add an API key in Settings.
            </p>
          ) : null}
        </div>
        {isProviderLocked && readyProviders.length > 1 ? (
          <p className="px-2 py-1.5 text-[10px] text-push-fg-secondary/60">
            Locked to this conversation's original provider — start a new chat to switch.
          </p>
        ) : null}
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
