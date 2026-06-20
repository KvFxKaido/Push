import { useMemo, useState, type ComponentType, type ReactNode, type SVGProps } from 'react';
import { Check, ChevronsUpDown, Loader2, Pencil, RefreshCw } from 'lucide-react';
import {
  ImageGenIcon,
  ReasoningBoltIcon,
  ToolWrenchIcon,
  VisionEyeIcon,
} from '@/components/icons/push-custom-icons';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  getModelCapabilities,
  getModelCapabilityHints,
  type ModelCapabilityHint,
} from '@/lib/model-catalog';
import {
  formatModelDisplayName,
  getModelDisplayGroupKey,
  getModelDisplayGroupLabel,
  getModelDisplayLeafName,
} from '@/lib/providers';
import { cn } from '@/lib/utils';

const CUSTOM_MODEL_VALUE = '__custom_model__';

const CAPABILITY_ICONS: Record<
  ModelCapabilityHint,
  { Icon: ComponentType<SVGProps<SVGSVGElement>>; label: string }
> = {
  reasoning: { Icon: ReasoningBoltIcon, label: 'Reasoning' },
  vision: { Icon: VisionEyeIcon, label: 'Vision input' },
  imageGen: { Icon: ImageGenIcon, label: 'Image generation' },
  toolCall: { Icon: ToolWrenchIcon, label: 'Tool calling' },
};

interface ModelPickerGroup {
  key: string;
  label: string | null;
  models: { id: string; display: string; hints: ModelCapabilityHint[] }[];
}

function buildGroups(provider: string, options: string[]): ModelPickerGroup[] {
  const groups = new Map<string, ModelPickerGroup>();
  for (const model of options) {
    const groupKey = getModelDisplayGroupKey(provider, model);
    const mapKey = groupKey || '__ungrouped__';
    const label = groupKey ? getModelDisplayGroupLabel(groupKey) : null;
    const display = label
      ? getModelDisplayLeafName(provider, model)
      : formatModelDisplayName(provider, model);
    const hints = getModelCapabilityHints(getModelCapabilities(provider, model));
    const existing = groups.get(mapKey);
    if (existing) {
      existing.models.push({ id: model, display, hints });
    } else {
      groups.set(mapKey, { key: mapKey, label, models: [{ id: model, display, hints }] });
    }
  }
  return Array.from(groups.values());
}

export interface ModelPickerProps {
  provider: string;
  value: string;
  options: string[];
  onChange: (model: string) => void;
  disabled?: boolean;
  /** Show a "Custom model…" entry that swaps the trigger to a freeform input. */
  allowCustom?: boolean;
  /**
   * Raw text shown in the custom-mode input. Defaults to `value`. Pass this when
   * `value` is a resolved/defaulted string and the input should track the
   * unresolved user-edited value (so clearing the field doesn't snap back).
   */
  customInputValue?: string;
  /** Override the trigger label (defaults to formatted display name of `value`). */
  triggerLabel?: ReactNode;
  /** Trailing slot rendered next to the trigger label (e.g., reasoning effort). */
  triggerTrailing?: ReactNode;
  /** Placeholder for the custom-model input. */
  customPlaceholder?: string;
  /** Placeholder for the search input. */
  searchPlaceholder?: string;
  /** Empty state copy. */
  emptyLabel?: string;
  /** When provided, renders a sibling refresh icon button next to the trigger. */
  onRefresh?: () => void;
  /** Spinner state for the refresh button; also disables it. */
  isRefreshing?: boolean;
  /** aria-label / title on the refresh button. */
  refreshAriaLabel?: string;
  className?: string;
  triggerClassName?: string;
  popoverClassName?: string;
  ariaLabel?: string;
}

export function ModelPicker({
  provider,
  value,
  options,
  onChange,
  disabled,
  allowCustom = false,
  customInputValue,
  triggerLabel,
  triggerTrailing,
  customPlaceholder,
  searchPlaceholder = 'Search models...',
  emptyLabel = 'No models found.',
  onRefresh,
  isRefreshing = false,
  refreshAriaLabel = 'Refresh models',
  className,
  triggerClassName,
  popoverClassName,
  ariaLabel = 'Select model',
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [customMode, setCustomMode] = useState(false);
  const groups = useMemo(() => buildGroups(provider, options), [provider, options]);

  const fallbackLabel = value ? formatModelDisplayName(provider, value) : 'Select model';
  const renderedLabel = triggerLabel ?? fallbackLabel;

  const refreshButton = onRefresh ? (
    <button
      type="button"
      onClick={onRefresh}
      disabled={disabled || isRefreshing}
      aria-label={refreshAriaLabel}
      title={refreshAriaLabel}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-push-edge-hover bg-push-surface text-push-fg-muted transition-colors hover:text-push-fg-soft disabled:opacity-60"
    >
      {isRefreshing ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <RefreshCw className="h-3.5 w-3.5" />
      )}
    </button>
  ) : null;

  if (allowCustom && customMode) {
    const inputValue = customInputValue ?? value;
    return (
      <div className={cn('flex w-full min-w-0 items-center gap-1.5', className)}>
        <input
          type="text"
          value={inputValue}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder={customPlaceholder ?? 'Enter model ID'}
          aria-label="Custom model ID"
          className={cn(
            'h-8 min-w-0 flex-1 rounded-lg border border-push-edge-hover bg-push-surface px-2.5 text-xs text-push-fg-soft outline-none focus:border-push-edge-focus disabled:opacity-60',
            triggerClassName,
          )}
        />
        <button
          type="button"
          onClick={() => setCustomMode(false)}
          disabled={disabled}
          aria-label="Pick from list"
          className="flex h-8 shrink-0 items-center justify-center rounded-lg border border-push-edge-hover bg-push-surface px-2 text-push-fg-soft hover:border-push-edge-focus disabled:opacity-60"
        >
          <ChevronsUpDown className="h-4 w-4" />
        </button>
        {refreshButton}
      </div>
    );
  }

  return (
    <div className={cn('flex w-full min-w-0 items-center gap-1.5', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            role="combobox"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label={ariaLabel}
            disabled={disabled || (options.length === 0 && !allowCustom)}
            className={cn(
              'flex h-8 min-w-0 flex-1 items-center justify-between rounded-lg border border-push-edge-hover bg-push-surface px-2.5 text-xs text-push-fg-soft outline-none focus:border-push-edge-focus disabled:opacity-60',
              triggerClassName,
            )}
          >
            <span className="flex items-center gap-2 truncate">
              {renderedLabel}
              {triggerTrailing}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className={cn(
            'w-[320px] border-push-edge-hover bg-push-surface-raised p-0 text-push-fg-soft shadow-md',
            popoverClassName,
          )}
          align="start"
        >
          <Command className="bg-transparent">
            <CommandInput placeholder={searchPlaceholder} className="border-0 text-push-fg-soft" />
            <CommandList>
              <CommandEmpty>{emptyLabel}</CommandEmpty>
              {groups.map((group) => (
                <CommandGroup
                  key={group.key}
                  heading={group.label || undefined}
                  className="text-push-fg-faint"
                >
                  {group.models.map((model) => (
                    <CommandItem
                      key={model.id}
                      value={model.id}
                      onSelect={() => {
                        if (model.id !== value) onChange(model.id);
                        setOpen(false);
                      }}
                      className="text-push-fg-soft data-[selected=true]:bg-push-surface-active"
                    >
                      <span className="flex-1 truncate">{model.display}</span>
                      {model.hints.length > 0 && (
                        <span className="ml-2 flex shrink-0 items-center gap-1 text-push-fg-faint">
                          {model.hints.map((hint) => {
                            const { Icon, label } = CAPABILITY_ICONS[hint];
                            return (
                              <Icon key={hint} width={12} height={12} role="img" aria-label={label} />
                            );
                          })}
                        </span>
                      )}
                      {model.id === value && (
                        <Check className="ml-2 h-4 w-4 shrink-0 text-push-fg-soft" />
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
              {allowCustom && (
                <CommandGroup className="text-push-fg-faint">
                  <CommandItem
                    value={CUSTOM_MODEL_VALUE}
                    keywords={['custom', 'custom model', 'manual']}
                    onSelect={() => {
                      setCustomMode(true);
                      setOpen(false);
                    }}
                    className="text-push-fg-soft data-[selected=true]:bg-push-surface-active"
                  >
                    <Pencil className="mr-2 h-3.5 w-3.5 shrink-0" />
                    <span className="flex-1 truncate">Custom model…</span>
                  </CommandItem>
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {refreshButton}
    </div>
  );
}
