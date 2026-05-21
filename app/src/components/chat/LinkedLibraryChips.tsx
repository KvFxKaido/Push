/**
 * Library v2b — chip strip rendered above the chat composer showing
 * which libraries are linked to the current chat. Tap the × on a chip
 * to unlink. Returns null when nothing is linked, so the composer
 * footprint is unchanged for chats that haven't opted in.
 *
 * Names are resolved via `useChatLibrary` — the same hook the library
 * picker uses. Mounting this component triggers a refresh of the
 * collection list (lazy, coalesced via the hook's inflight ref) so the
 * chip names are correct even when the user lands on a chat with
 * existing links without opening the picker first.
 */

import { useEffect, useMemo } from 'react';
import { X } from 'lucide-react';
import { useChatLibrary } from '@/hooks/useChatLibrary';

interface LinkedLibraryChipsProps {
  libraryIds: readonly string[];
  onUnlink: (libraryId: string) => void;
}

export function LinkedLibraryChips({ libraryIds, onUnlink }: LinkedLibraryChipsProps) {
  const { collections, hasFetched, refresh } = useChatLibrary();

  // Trigger one fetch on first mount with non-empty linkage so names
  // are available. Re-fetches when libraryIds gains entries we don't
  // have a name for yet.
  useEffect(() => {
    if (libraryIds.length === 0) return;
    if (!hasFetched) void refresh();
  }, [hasFetched, libraryIds, refresh]);

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of collections) map.set(c.id, c.name);
    return map;
  }, [collections]);

  if (libraryIds.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto px-3 pt-2 pb-1 scrollbar-none">
      <span className="shrink-0 text-push-2xs uppercase tracking-wide text-[#7c879b]">Linked</span>
      {libraryIds.map((id) => {
        const name = nameById.get(id) ?? `${id.slice(0, 8)}…`;
        return (
          <div
            key={id}
            className="flex shrink-0 items-center gap-1 rounded-full border border-push-accent/30 bg-push-accent/10 px-2 py-0.5 text-push-2xs text-push-accent"
            title={`Linked library — ${name}. Auto-attached on every turn.`}
          >
            <BookGlyph className="h-2.5 w-2.5" />
            <span className="max-w-[120px] truncate">{name}</span>
            <button
              type="button"
              onClick={() => onUnlink(id)}
              className="ml-0.5 rounded-full p-0.5 text-push-accent/70 hover:text-push-accent"
              aria-label={`Unlink ${name}`}
              title={`Unlink ${name}`}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function BookGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 5.5A1.5 1.5 0 0 1 4.5 4H10a2 2 0 0 1 2 2v13a1 1 0 0 0-1-1H4.5A1.5 1.5 0 0 1 3 16.5v-11Z" />
      <path d="M21 5.5A1.5 1.5 0 0 0 19.5 4H14a2 2 0 0 0-2 2v13a1 1 0 0 1 1-1h6.5a1.5 1.5 0 0 0 1.5-1.5v-11Z" />
    </svg>
  );
}
