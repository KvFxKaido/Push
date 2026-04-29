import { useMemo, useState, type ReactNode } from 'react';
import { Check, ChevronsUpDown, Pencil } from 'lucide-react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { formatModelCapabilityHints, getModelCapabilities } from '@/lib/model-catalog';
import {
  formatModelDisplayName,
  getModelDisplayGroupKey,
  getModelDisplayGroupLabel,
  getModelDisplayLeafName,
} from '@/lib/providers';
import { cn } from '@/lib/utils';

const CUSTOM_MODEL_VALUE = '__custom_model__';

interface ModelPickerGroup {
  key: string;
  label: string | null;
  models: { id: string; display: string; hints: string }[];
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
    const hints = formatModelCapabilityHints(getModelCapabilities(provider, model));
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
  triggerLabel,
  triggerTrailing,
  customPlaceholder,
  searchPlaceholder = 'Search models...',
  emptyLabel = 'No models found.',
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

  if (allowCustom && customMode) {
    return (
      <div className={cn('flex w-full min-w-0 items-center gap-1.5', className)}>
        <input
          type="text"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder={customPlaceholder ?? 'Enter model ID'}
          aria-label={ariaLabel}
          className={cn(
            'h-8 min-w-0 flex-1 rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 text-xs text-[#d7deeb] outline-none focus:border-[#3d5579] disabled:opacity-60',
            triggerClassName,
          )}
        />
        <button
          type="button"
          onClick={() => setCustomMode(false)}
          disabled={disabled}
          aria-label="Pick from list"
          className="flex h-8 shrink-0 items-center justify-center rounded-lg border border-[#2a3447] bg-[#070a10] px-2 text-[#d7deeb] hover:border-[#3d5579] disabled:opacity-60"
        >
          <ChevronsUpDown className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
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
            'flex h-8 w-full items-center justify-between rounded-lg border border-[#2a3447] bg-[#070a10] px-2.5 text-xs text-[#d7deeb] outline-none focus:border-[#3d5579] disabled:opacity-60',
            triggerClassName,
            className,
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
          'w-[320px] border-[#2a3447] bg-[#0d1117] p-0 text-[#d7deeb] shadow-md',
          popoverClassName,
        )}
        align="start"
      >
        <Command className="bg-transparent">
          <CommandInput placeholder={searchPlaceholder} className="border-0 text-[#d7deeb]" />
          <CommandList>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            {groups.map((group) => (
              <CommandGroup
                key={group.key}
                heading={group.label || undefined}
                className="text-[#7c879b]"
              >
                {group.models.map((model) => (
                  <CommandItem
                    key={model.id}
                    value={model.id}
                    onSelect={() => {
                      if (model.id !== value) onChange(model.id);
                      setOpen(false);
                    }}
                    className="text-[#d7deeb] data-[selected=true]:bg-[#1a2332]"
                  >
                    <span className="flex-1 truncate">{model.display}</span>
                    {model.hints && (
                      <span className="ml-2 shrink-0 text-[#7c879b]">{model.hints}</span>
                    )}
                    {model.id === value && (
                      <Check className="ml-2 h-4 w-4 shrink-0 text-[#d7deeb]" />
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            {allowCustom && (
              <CommandGroup className="text-[#7c879b]">
                <CommandItem
                  value={CUSTOM_MODEL_VALUE}
                  onSelect={() => {
                    setCustomMode(true);
                    setOpen(false);
                  }}
                  className="text-[#d7deeb] data-[selected=true]:bg-[#1a2332]"
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
  );
}
