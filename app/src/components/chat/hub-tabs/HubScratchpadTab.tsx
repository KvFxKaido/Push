import { useState } from 'react';
import { Check, Trash2 } from 'lucide-react';
import type { ScratchpadMemory } from '@/hooks/useScratchpad';
import {
  HUB_MATERIAL_INPUT_CLASS,
  HUB_MATERIAL_PILL_BUTTON_CLASS,
  HUB_MATERIAL_ROUND_BUTTON_CLASS,
  HUB_PANEL_SUBTLE_SURFACE_CLASS,
  HubControlGlow,
} from '@/components/chat/hub-styles';

interface HubScratchpadTabProps {
  scratchpadContent: string;
  scratchpadMemories: ScratchpadMemory[];
  activeMemoryId: string | null;
  onContentChange: (content: string) => void;
  onClear: () => void;
  onSaveMemory: (name: string) => void;
  onLoadMemory: (id: string | null) => void;
  onDeleteMemory: (id: string) => void;
}

export function HubScratchpadTab({
  scratchpadContent,
  scratchpadMemories,
  activeMemoryId,
  onContentChange,
  onClear,
  onSaveMemory,
  onLoadMemory,
  onDeleteMemory,
}: HubScratchpadTabProps) {
  const [memoryName, setMemoryName] = useState('');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-push-edge px-3 py-2">
        <input
          value={memoryName}
          onChange={(event) => setMemoryName(event.target.value)}
          placeholder="Memory name"
          className={`${HUB_MATERIAL_INPUT_CLASS} min-w-[140px] flex-1`}
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
        >
          <HubControlGlow />
          <Check className="relative z-10 h-3.5 w-3.5" />
          <span className="relative z-10">Save</span>
        </button>
        <button
          onClick={onClear}
          disabled={!scratchpadContent.trim()}
          className={HUB_MATERIAL_ROUND_BUTTON_CLASS}
          aria-label="Clear scratchpad"
        >
          <HubControlGlow />
          <Trash2 className="relative z-10 h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-2 border-b border-push-edge px-3 py-2">
        <select
          value={activeMemoryId ?? ''}
          onChange={(event) => onLoadMemory(event.target.value || null)}
          className={`${HUB_MATERIAL_INPUT_CLASS} min-w-[160px] flex-1 pr-8`}
        >
          <option value="">Current scratchpad</option>
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
          >
            <HubControlGlow />
            <Trash2 className="relative z-10 h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 p-3">
        <textarea
          value={scratchpadContent}
          onChange={(event) => onContentChange(event.target.value)}
          placeholder="Write notes, requirements, and scratch ideas..."
          className={`h-full w-full resize-none px-3 py-2 text-sm leading-relaxed text-push-fg outline-none transition-colors placeholder:text-push-fg-dim/70 focus:border-push-sky/50 ${HUB_PANEL_SUBTLE_SURFACE_CLASS}`}
        />
      </div>
    </div>
  );
}
