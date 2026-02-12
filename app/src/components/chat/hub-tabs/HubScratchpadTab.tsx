import { useState } from 'react';
import { Check, Trash2 } from 'lucide-react';
import type { ScratchpadMemory } from '@/hooks/useScratchpad';

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
          className="h-8 min-w-[140px] flex-1 rounded-lg border border-push-edge bg-push-surface px-2.5 text-xs text-push-fg-secondary outline-none transition-colors placeholder:text-push-fg-dim focus:border-push-sky/50"
        />
        <button
          onClick={() => {
            const trimmed = memoryName.trim();
            if (!trimmed) return;
            onSaveMemory(trimmed);
            setMemoryName('');
          }}
          disabled={!scratchpadContent.trim() || !memoryName.trim()}
          className="flex h-8 items-center gap-1 rounded-lg border border-push-edge bg-[#080b10]/95 px-2 text-[11px] text-push-fg-dim hover:border-push-edge-hover hover:text-push-fg-secondary disabled:opacity-40"
        >
          <Check className="h-3.5 w-3.5" />
          Save
        </button>
        <button
          onClick={onClear}
          disabled={!scratchpadContent.trim()}
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-push-edge bg-[#080b10]/95 text-push-fg-dim hover:border-push-edge-hover hover:text-push-fg-secondary disabled:opacity-40"
          aria-label="Clear scratchpad"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="flex items-center gap-2 border-b border-push-edge px-3 py-2">
        <select
          value={activeMemoryId ?? ''}
          onChange={(event) => onLoadMemory(event.target.value || null)}
          className="h-8 min-w-[160px] flex-1 rounded-lg border border-push-edge bg-push-surface px-2 text-xs text-push-fg-secondary outline-none transition-colors focus:border-push-sky/50"
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
            className="flex h-8 w-8 items-center justify-center rounded-lg border border-push-edge bg-[#080b10]/95 text-push-fg-dim hover:border-push-edge-hover hover:text-red-300"
            aria-label="Delete selected memory"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 p-3">
        <textarea
          value={scratchpadContent}
          onChange={(event) => onContentChange(event.target.value)}
          placeholder="Write notes, requirements, and scratch ideas..."
          className="h-full w-full resize-none rounded-xl border border-push-edge bg-push-surface px-3 py-2 text-sm leading-relaxed text-push-fg outline-none transition-colors placeholder:text-push-fg-dim/70 focus:border-push-sky/50"
        />
      </div>
    </div>
  );
}
