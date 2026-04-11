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
  HubControlGlow,
} from '@/components/chat/hub-styles';
import {
  DEFAULT_REPO_APPEARANCE,
  getRepoAppearanceColorHex,
  hexToRgba,
  REPO_APPEARANCE_COLOR_OPTIONS,
  REPO_APPEARANCE_ICON_OPTIONS,
  type RepoAppearance,
} from '@/lib/repo-appearance';
import { RepoAppearanceBadge, RepoAppearanceGlyph } from './repo-appearance';

interface RepoAppearanceSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repoName: string;
  appearance: RepoAppearance;
  onSave: (appearance: RepoAppearance) => void;
  onReset: () => void;
}

export function RepoAppearanceSheet({
  open,
  onOpenChange,
  repoName,
  appearance,
  onSave,
  onReset,
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
          <SheetTitle className="flex items-center gap-2 text-sm font-semibold text-push-fg">
            <Palette className="h-4 w-4 text-push-fg-dim" />
            Customize {repoName}
          </SheetTitle>
          <SheetDescription className="text-xs text-push-fg-dim">
            Pick a quiet icon and accent color for this repo on this device.
          </SheetDescription>
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
                    <HubControlGlow />
                    <RepoAppearanceGlyph icon={option.id} className="relative z-10 h-5 w-5" />
                    <span className="relative z-10 text-push-2xs">{option.label}</span>
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
                    <HubControlGlow />
                    <span
                      className="relative z-10 h-3 w-3 rounded-full border"
                      style={{
                        backgroundColor: option.hex,
                        borderColor: hexToRgba(option.hex, 0.45),
                        boxShadow: `0 0 0 4px ${hexToRgba(option.hex, 0.12)}`,
                      }}
                    />
                    <span className="relative z-10 text-push-2xs">{option.label}</span>
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
              <HubControlGlow />
              <RotateCcw className="relative z-10 h-4 w-4" />
              <span className="relative z-10 text-sm">Reset</span>
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
              <HubControlGlow />
              <RepoAppearanceBadge
                appearance={draft}
                className="relative z-10 h-5 w-5 rounded-md"
                iconClassName="h-3 w-3"
              />
              <span className="relative z-10 text-sm">Save appearance</span>
            </button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
