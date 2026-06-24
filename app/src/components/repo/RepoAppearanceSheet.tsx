import { useState } from 'react';
import { Palette, RotateCcw } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_PANEL_SUBTLE_SURFACE_CLASS,
} from '@/components/chat/hub-styles';
import {
  DEFAULT_REPO_APPEARANCE,
  getRepoAppearanceColorHex,
  hexToRgba,
  REPO_APPEARANCE_COLOR_OPTIONS,
  REPO_APPEARANCE_GLOW_STYLE_OPTIONS,
  REPO_APPEARANCE_ICON_OPTIONS,
  type RepoAppearance,
  type RepoAppearanceGlowStyleId,
} from '@/lib/repo-appearance';
import { RepoAppearanceBadge, RepoAppearanceGlyph } from './repo-appearance';

// Flatten the glow choice into a single row: each enabled style, then Off
// (carried by glowEnabled: false). Keeping Off here means the picker reads
// as one mutually-exclusive control instead of a toggle plus a style switch.
type GlowOption =
  | { key: string; label: string; enabled: true; style: RepoAppearanceGlowStyleId }
  | { key: 'off'; label: string; enabled: false };

const GLOW_OPTIONS: GlowOption[] = [
  ...REPO_APPEARANCE_GLOW_STYLE_OPTIONS.map(
    (option): GlowOption => ({
      key: option.id,
      label: option.label,
      enabled: true,
      style: option.id,
    }),
  ),
  { key: 'off', label: 'Off', enabled: false },
];

interface RepoAppearanceSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoName: string;
  appearance: RepoAppearance;
  onSave: (appearance: RepoAppearance) => void;
  onReset: () => void;
  description?: string;
}

export function RepoAppearanceSheet({
  open,
  onOpenChange,
  repoName,
  appearance,
  onSave,
  onReset,
  description = 'Pick a quiet icon and accent color for this repo on this device.',
}: RepoAppearanceSheetProps) {
  const [draft, setDraft] = useState<RepoAppearance>(appearance);

  const colorHex = getRepoAppearanceColorHex(draft.color);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="max-h-[88dvh] overflow-y-auto rounded-t-2xl border-t border-push-edge bg-push-grad-panel px-5 pb-8 pt-0 text-push-fg"
      >
        <SheetHeader className="pb-1 pt-5">
          <SheetTitle className="flex items-center gap-2 text-push-lg font-display font-semibold text-push-fg">
            <Palette className="h-4 w-4 text-push-fg-dim" />
            Customize {repoName}
          </SheetTitle>
          <SheetDescription className="text-xs text-push-fg-dim">{description}</SheetDescription>
        </SheetHeader>

        <div className="space-y-5 pt-3">
          <div className={`${HUB_PANEL_SUBTLE_SURFACE_CLASS} px-4 py-4`}>
            <div className="flex items-center gap-3">
              <RepoAppearanceBadge
                appearance={draft}
                className="h-10 w-10 rounded-xl"
                iconClassName="h-5 w-5"
              />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-push-fg">{repoName}</p>
                <p className="text-xs text-push-fg-dim">
                  {REPO_APPEARANCE_ICON_OPTIONS.find((option) => option.id === draft.icon)?.label}{' '}
                  in{' '}
                  {REPO_APPEARANCE_COLOR_OPTIONS.find((option) => option.id === draft.color)?.label}
                </p>
              </div>
            </div>
          </div>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-push-fg-dim">
                Icon
              </h2>
              <span className="text-push-2xs text-push-fg-dim">Curated set</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {REPO_APPEARANCE_ICON_OPTIONS.map((option) => {
                const selected = draft.icon === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setDraft((prev) => ({ ...prev, icon: option.id }))}
                    className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} h-auto min-h-[72px] flex-col gap-2 px-3 py-3 ${
                      selected ? 'border-push-edge-hover text-push-fg' : 'text-push-fg-secondary'
                    }`}
                    style={
                      selected
                        ? {
                            borderColor: hexToRgba(colorHex, 0.45),
                            backgroundColor: hexToRgba(colorHex, 0.12),
                          }
                        : undefined
                    }
                  >
                    <RepoAppearanceGlyph icon={option.id} className="h-5 w-5" />
                    <span className="text-push-2xs">{option.label}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-push-fg-dim">
                Color
              </h2>
              <span className="text-push-2xs text-push-fg-dim">Muted accents</span>
            </div>
            <div className="grid grid-cols-4 gap-2">
              {REPO_APPEARANCE_COLOR_OPTIONS.map((option) => {
                const selected = draft.color === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setDraft((prev) => ({ ...prev, color: option.id }))}
                    className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} h-auto gap-2 px-3 py-3 ${
                      selected ? 'border-push-edge-hover text-push-fg' : 'text-push-fg-secondary'
                    }`}
                    style={
                      selected
                        ? {
                            borderColor: hexToRgba(option.hex, 0.42),
                            backgroundColor: hexToRgba(option.hex, 0.12),
                          }
                        : undefined
                    }
                  >
                    <span
                      className="h-3 w-3 rounded-full border"
                      style={{
                        backgroundColor: option.hex,
                        borderColor: hexToRgba(option.hex, 0.45),
                        boxShadow: `0 0 0 4px ${hexToRgba(option.hex, 0.12)}`,
                      }}
                    />
                    <span className="text-push-2xs">{option.label}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between">
              <h2 className="text-xs font-medium uppercase tracking-[0.12em] text-push-fg-dim">
                Background glow
              </h2>
              <span className="text-push-2xs text-push-fg-dim">Ambient accent</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {GLOW_OPTIONS.map((option) => {
                const selected = option.enabled
                  ? draft.glowEnabled && draft.glowStyle === option.style
                  : !draft.glowEnabled;
                return (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() =>
                      setDraft((prev) =>
                        option.enabled
                          ? { ...prev, glowEnabled: true, glowStyle: option.style }
                          : { ...prev, glowEnabled: false },
                      )
                    }
                    className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} h-auto gap-2 px-3 py-3 ${
                      selected ? 'border-push-edge-hover text-push-fg' : 'text-push-fg-secondary'
                    }`}
                    style={
                      selected
                        ? {
                            borderColor: hexToRgba(colorHex, 0.42),
                            backgroundColor: hexToRgba(colorHex, 0.12),
                          }
                        : undefined
                    }
                  >
                    <span className="text-push-2xs">{option.label}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                onReset();
                setDraft(DEFAULT_REPO_APPEARANCE);
                onOpenChange(false);
              }}
              className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} h-10 flex-1 gap-2 px-3 text-push-fg-secondary`}
            >
              <RotateCcw className="h-4 w-4" />
              <span className="text-sm">Reset</span>
            </button>
            <button
              type="button"
              onClick={() => {
                onSave(draft);
                onOpenChange(false);
              }}
              className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} h-10 flex-[1.3] gap-2 px-3 text-push-fg`}
              style={{
                borderColor: hexToRgba(colorHex, 0.42),
                backgroundColor: hexToRgba(colorHex, 0.14),
              }}
            >
              <RepoAppearanceBadge
                appearance={draft}
                className="h-5 w-5 rounded-md"
                iconClassName="h-3 w-3"
              />
              <span className="text-sm">Save appearance</span>
            </button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
