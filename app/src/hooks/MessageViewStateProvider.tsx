import { useMemo, type ReactNode } from 'react';
import { createMessageViewStateStore, MessageViewStateContext } from './useMessageViewState';

/**
 * Provides one ephemeral per-message view-state store per mount, above the
 * transcript's virtualization boundary, so the toggles it holds (action-row
 * reveal, reasoning/sources expansion) survive the streaming→settled handoff and
 * Virtuoso remounts. Store internals + rationale live in `useMessageViewState`.
 *
 * Split from the hook/store module so each file exports a single kind of thing
 * (`react-refresh/only-export-components`).
 */
export function MessageViewStateProvider({ children }: { children: ReactNode }) {
  const store = useMemo(() => createMessageViewStateStore(), []);
  return (
    <MessageViewStateContext.Provider value={store}>{children}</MessageViewStateContext.Provider>
  );
}
