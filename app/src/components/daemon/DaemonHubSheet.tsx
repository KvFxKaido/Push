/**
 * DaemonHubSheet — Hub-style slide-out for paired daemon sessions.
 *
 * Mirrors the visual pattern of `WorkspaceHubSheet` but with a trimmed
 * surface: Notes only for now. The full Workspace Hub assumes a cloud
 * sandbox (branch picker, sandbox controller, snapshot manager) and
 * needs ~70 props pulled through `ChatRouteProps`; daemon sessions
 * have neither, and the local-pc tool protocol doesn't speak the
 * cloud-sandbox vocabulary anyway. This sheet keeps the Sheet
 * primitive + header chrome + Notes tab so the muscle memory carries
 * over; richer tabs (Files / Diff via daemon-backed tools, Console
 * via the daemon audit/event stream) can land later without rewiring
 * the entry point.
 *
 * Settings access: an optional `onOpenSettings` slot is wired into the
 * header so a daemon screen that mounts a SettingsSheet at its own
 * scope can route the gear button there. When the callback isn't
 * supplied (today's wiring) the gear is hidden — the slot exists in
 * the layout for the next PR that plumbs settings prop bundles.
 */
import { Settings, X } from 'lucide-react';

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { HubNotesTab } from '@/components/chat/hub-tabs';
import { HUB_MATERIAL_PILL_BUTTON_CLASS } from '@/components/chat/hub-styles';
import type { ScratchpadMemory } from '@/hooks/useScratchpad';
import type { PinnedArtifact } from '@/hooks/usePinnedArtifacts';
import type { TodoItem } from '@/lib/todo-tools';

export interface DaemonHubSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Short label rendered under the "Hub" title — e.g. "local daemon"
   * or "remote daemon". Picked up from `DaemonChatBody`'s daemonLabel
   * prop so the chrome reads consistent with the rest of the shell.
   */
  daemonLabel: string;

  /**
   * Optional Settings entry. When supplied, a gear button shows in the
   * header that invokes this callback. Daemon screens can wire it to
   * a SettingsSheet they own once the settings prop bundles are
   * plumbed (`ChatRouteProps`-shaped). Today the callback is omitted
   * and the gear is hidden — the slot is here so the next PR doesn't
   * have to re-design the header.
   */
  onOpenSettings?: () => void;

  // ── Scratchpad (Notes) ────────────────────────────────────────────
  scratchpadContent: string;
  scratchpadMemories: ScratchpadMemory[];
  activeMemoryId: string | null;
  onScratchpadContentChange: (content: string) => void;
  onScratchpadClear: () => void;
  onScratchpadSaveMemory: (name: string) => void;
  onScratchpadLoadMemory: (id: string | null) => void;
  onScratchpadDeleteMemory: (id: string) => void;

  // ── Pinned artifacts (Kept section inside Notes) ──────────────────
  pinnedArtifacts: PinnedArtifact[];
  onUnpinArtifact: (id: string) => void;
  onUpdateArtifactLabel: (id: string, label: string) => void;

  // ── Todo list (read-only display inside Notes) ────────────────────
  todos: readonly TodoItem[];
  onTodoClear: () => void;
}

export function DaemonHubSheet({
  open,
  onOpenChange,
  daemonLabel,
  onOpenSettings,
  scratchpadContent,
  scratchpadMemories,
  activeMemoryId,
  onScratchpadContentChange,
  onScratchpadClear,
  onScratchpadSaveMemory,
  onScratchpadLoadMemory,
  onScratchpadDeleteMemory,
  pinnedArtifacts,
  onUnpinArtifact,
  onUpdateArtifactLabel,
  todos,
  onTodoClear,
}: DaemonHubSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        overlayClassName="bg-transparent"
        className="w-[94vw] rounded-l-2xl border-l border-[#151b26] bg-push-grad-panel p-0 text-push-fg shadow-[0_16px_48px_rgba(0,0,0,0.6),0_4px_16px_rgba(0,0,0,0.3)] sm:max-w-none [&>[data-slot=sheet-close]]:hidden"
      >
        <SheetHeader className="sr-only">
          <SheetTitle>Daemon Hub</SheetTitle>
          <SheetDescription>
            Notes, pinned artifacts, and the model's todo list for the current daemon session.
          </SheetDescription>
        </SheetHeader>
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-16 rounded-tl-2xl bg-gradient-to-b from-white/[0.03] to-transparent" />
        <div className="relative flex h-dvh flex-col overflow-hidden rounded-l-2xl">
          <header className="border-b border-push-edge px-3 py-3">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-push-fg">Hub</p>
                <p className="truncate text-push-xs text-push-fg-dim">{daemonLabel}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {onOpenSettings && (
                  <button
                    type="button"
                    onClick={onOpenSettings}
                    aria-label="Settings"
                    title="Settings"
                    className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} h-8 w-8 p-0`}
                  >
                    <Settings className="h-4 w-4" aria-hidden="true" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  aria-label="Close hub"
                  title="Close"
                  className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} h-8 w-8 p-0`}
                >
                  <X className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </div>
          </header>
          <div className="min-h-0 flex-1">
            <HubNotesTab
              scratchpadContent={scratchpadContent}
              scratchpadMemories={scratchpadMemories}
              activeMemoryId={activeMemoryId}
              onContentChange={onScratchpadContentChange}
              onClear={onScratchpadClear}
              onSaveMemory={onScratchpadSaveMemory}
              onLoadMemory={onScratchpadLoadMemory}
              onDeleteMemory={onScratchpadDeleteMemory}
              // No cloud sandbox in daemon mode — the "export to repo"
              // affordance HubNotesTab gates on a non-null sandboxId
              // stays hidden by passing null.
              sandboxId={null}
              artifacts={pinnedArtifacts}
              onUnpin={onUnpinArtifact}
              onUpdateLabel={onUpdateArtifactLabel}
              todos={todos}
              onTodoClear={onTodoClear}
            />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
