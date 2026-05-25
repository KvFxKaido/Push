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
import { Library, X } from 'lucide-react';
import { useChatLibrary } from '@/hooks/useChatLibrary';

interface LinkedLibraryChipsProps {
  libraryIds: readonly string[];
  onUnlink: (libraryId: string) => void;
}

export function LinkedLibraryChips({ libraryIds, onUnlink }: LinkedLibraryChipsProps) {
  const { collections, hasFetched, isLoading, refresh } = useChatLibrary();

  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of collections) map.set(c.id, c.name);
    return map;
  }, [collections]);

  // Trigger a fetch when we have linkage but unresolved names — covers
  // both first-mount (nothing fetched yet) and runtime "user just
  // linked a library we hadn't loaded the list for" (which the prior
  // `!hasFetched` gate missed entirely). `refresh` itself coalesces
  // concurrent calls via an inflight ref, and the `isLoading` guard
  // prevents the effect from re-firing while the fetch is in flight.
  useEffect(() => {
    if (libraryIds.length === 0) return;
    if (isLoading) return;
    const hasUnresolved = libraryIds.some((id) => !nameById.has(id));
    if (!hasFetched || hasUnresolved) void refresh();
  }, [hasFetched, isLoading, libraryIds, nameById, refresh]);

  if (libraryIds.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto px-3 pt-2 pb-1 scrollbar-none">
      <span className="shrink-0 text-push-2xs uppercase tracking-wide text-push-fg-faint">
        Linked
      </span>
      {libraryIds.map((id) => {
        const name = nameById.get(id) ?? `${id.slice(0, 8)}…`;
        return (
          <div
            key={id}
            className="flex shrink-0 items-center gap-1 rounded-full border border-push-accent/30 bg-push-accent/10 px-2 py-0.5 text-push-2xs text-push-accent"
            title={`Linked library — ${name}. Auto-attached on every turn.`}
          >
            <Library className="h-2.5 w-2.5" />
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
