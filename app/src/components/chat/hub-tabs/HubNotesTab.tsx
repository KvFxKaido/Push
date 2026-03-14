import { useState } from 'react';
import { Check, Download, Trash2 } from 'lucide-react';
import type { ScratchpadMemory } from '@/hooks/useScratchpad';
import type { PinnedArtifact } from '@/hooks/usePinnedArtifacts';
import {
  HUB_MATERIAL_INPUT_CLASS,
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_MATERIAL_ROUND_BUTTON_CLASS,
  HUB_PANEL_SUBTLE_SURFACE_CLASS,
  HUB_TAG_CLASS,
  HubControlGlow,
} from '@/components/chat/hub-styles';
import { KeptCacheIcon, NotebookPadIcon } from '@/components/icons/push-custom-icons';
import { HubKeptTab } from './HubKeptTab';

interface HubNotesTabProps {
  scratchpadContent: string;
  scratchpadMemories: ScratchpadMemory[];
  activeMemoryId: string | null;
  onContentChange: (content: string) => void;
  onClear: () => void;
  onSaveMemory: (name: string) => void;
  onLoadMemory: (id: string | null) => void;
  onDeleteMemory: (id: string) => void;
  onExportToRepo?: () => void;
  sandboxId: string | null;
  artifacts: PinnedArtifact[];
  onUnpin: (id: string) => void;
  onUpdateLabel: (id: string, label: string) => void;
}

export function HubNotesTab({
  scratchpadContent,
  scratchpadMemories,
  activeMemoryId,
  onContentChange,
  onClear,
  onSaveMemory,
  onLoadMemory,
  onDeleteMemory,
  onExportToRepo,
  sandboxId,
  artifacts,
  onUnpin,
  onUpdateLabel,
}: HubNotesTabProps) {
  const [memoryName, setMemoryName] = useState('');
  const activeMemory = activeMemoryId
    ? scratchpadMemories.find((memory) => memory.id === activeMemoryId) ?? null
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        <div className="flex min-h-full flex-col gap-4">
          <section className={`flex min-h-[320px] flex-[1.55] flex-col gap-3 p-3.5 ${HUB_PANEL_SUBTLE_SURFACE_CLASS}`}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <NotebookPadIcon className="h-4 w-4 text-push-fg-dim" />
                  <p className="text-sm font-medium text-push-fg">Working notes</p>
                  <span className={HUB_TAG_CLASS}>live context</span>
                </div>
                <p className="mt-1 text-push-xs text-push-fg-dim">
                  The model sees these notes on each reply, so keep only what you want in play.
                </p>
                {activeMemory && (
                  <p className="mt-2 text-push-2xs text-push-fg-dim">
                    Loaded memory: <span className="text-push-fg-secondary">{activeMemory.name}</span>
                  </p>
                )}
              </div>
              {scratchpadMemories.length > 0 && (
                <span className="shrink-0 text-push-2xs text-push-fg-dim">
                  {scratchpadMemories.length} saved
                </span>
              )}
            </div>

            <div className="rounded-[16px] border border-push-edge/70 bg-black/10 p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={memoryName}
                  onChange={(event) => setMemoryName(event.target.value)}
                  placeholder="Name this note"
                  className={`${HUB_MATERIAL_INPUT_CLASS} min-w-[150px] flex-1`}
                />
                <button
                  onClick={() => {
                    const trimmed = memoryName.trim();
                    if (!trimmed) return;
                    onSaveMemory(trimmed);
                    setMemoryName('');
                  }}
                  disabled={!scratchpadContent.trim() || !memoryName.trim()}
                  className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-2.5`}
                  title="Save current notes as a memory"
                >
                  <HubControlGlow />
                  <Check className="relative z-10 h-3.5 w-3.5" />
                  <span className="relative z-10">Save note</span>
                </button>
                <button
                  onClick={onClear}
                  disabled={!scratchpadContent.trim()}
                  className={HUB_MATERIAL_ROUND_BUTTON_CLASS}
                  aria-label="Clear notes"
                  title="Clear notes"
                >
                  <HubControlGlow />
                  <Trash2 className="relative z-10 h-3.5 w-3.5" />
                </button>
                <button
                  onClick={onExportToRepo}
                  disabled={!scratchpadContent.trim() || !sandboxId}
                  className={`${HUB_MATERIAL_PILL_BUTTON_CLASS} px-2.5`}
                  aria-label="Save notes to repo"
                >
                  <HubControlGlow />
                  <Download className="relative z-10 h-3.5 w-3.5" />
                  <span className="relative z-10">Save to repo</span>
                </button>
              </div>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <select
                  value={activeMemoryId ?? ''}
                  onChange={(event) => onLoadMemory(event.target.value || null)}
                  className={`${HUB_MATERIAL_INPUT_CLASS} min-w-[180px] flex-1 pr-8 sm:max-w-[280px]`}
                >
                  <option value="">Current notes</option>
                  {scratchpadMemories.map((memory) => (
                    <option key={memory.id} value={memory.id}>
                      {memory.name}
                    </option>
                  ))}
                </select>
                {activeMemoryId && (
                  <button
                    onClick={() => onDeleteMemory(activeMemoryId)}
                    className={HUB_MATERIAL_ROUND_BUTTON_CLASS}
                    aria-label="Delete selected memory"
                    title="Delete selected memory"
                  >
                    <HubControlGlow />
                    <Trash2 className="relative z-10 h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            </div>

            <textarea
              value={scratchpadContent}
              onChange={(event) => onContentChange(event.target.value)}
              placeholder="Capture notes, requirements, and the pieces you want the model to keep in mind..."
              className="min-h-[240px] flex-1 resize-none rounded-[16px] border border-push-edge bg-black/15 px-3 py-2.5 text-sm leading-relaxed text-push-fg outline-none transition-colors placeholder:text-push-fg-dim/70 focus:border-push-sky/50"
            />
          </section>

          <section className="flex min-h-[220px] flex-[0.85] flex-col gap-3 rounded-[18px] border border-push-edge/60 bg-[linear-gradient(180deg,rgba(8,11,16,0.78)_0%,rgba(4,7,11,0.9)_100%)] p-3.5 shadow-[0_10px_24px_rgba(0,0,0,0.22)]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <KeptCacheIcon className="h-4 w-4 text-push-fg-dim" />
                  <p className="text-sm font-medium text-push-fg">Pinned references</p>
                  <span className={HUB_TAG_CLASS}>reference only</span>
                </div>
                <p className="mt-1 text-push-xs text-push-fg-dim">
                  Useful snippets and outputs you want nearby without adding them to the prompt.
                </p>
              </div>
              <span className="shrink-0 text-push-2xs text-push-fg-dim">
                {artifacts.length} {artifacts.length === 1 ? 'reference' : 'references'}
              </span>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden rounded-[16px] border border-push-edge/60 bg-black/10">
              <HubKeptTab
                artifacts={artifacts}
                onUnpin={onUnpin}
                onUpdateLabel={onUpdateLabel}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
