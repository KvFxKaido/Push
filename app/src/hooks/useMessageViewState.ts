import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';

/**
 * Ephemeral per-message *view* state — the toggles that live in the UI, not in
 * the message model: whether the reasoning pane and sources list are expanded,
 * and whether the touch action row is revealed.
 *
 * Why this exists, above the transcript instead of inside the bubble: the
 * transcript renders the streaming message in Virtuoso's `Footer` (a persistent
 * mount) and settled messages inside the virtualized list. When a response
 * finishes it crosses that boundary — a full unmount → remount — and Virtuoso
 * also remounts any settled message scrolled past its viewport buffer. While
 * these toggles lived in component-local `useState`, every such remount reset
 * them: an expanded reasoning pane snapped shut "after a response", a revealed
 * action row collapsed. Holding them here, above the virtualization boundary
 * and keyed by the stable `message.id`, makes remounts harmless.
 *
 * The store is ref-backed with per-id subscriptions rather than a `useState`
 * map on purpose: a toggle must re-render *only* the affected bubble, never the
 * provider — a provider re-render would cascade into Virtuoso on every toggle.
 * Entries are created lazily on first `set`, so the map only holds messages the
 * user actually interacted with (a tiny subset); message ids are globally
 * unique, so no reset/pruning is needed across chats.
 *
 * The Provider component lives in `MessageViewStateProvider.tsx` — kept separate
 * so this module exports no component and satisfies `react-refresh`.
 */
export interface MessageViewState {
  reasoningExpanded: boolean;
  /**
   * Whether the user has manually toggled the reasoning pane. Until then the
   * pane auto-follows streaming (open while thinking, tucked once settled);
   * once the user opens or closes it themselves this pins to their choice and
   * the auto behavior stops. Held here (not local state) so it survives the
   * streaming→settled and scroll remounts like the rest of this slice.
   */
  reasoningUserSet: boolean;
  sourcesExpanded: boolean;
  actionsRevealed: boolean;
}

// Shared frozen default for every id that has never been toggled. Returning one
// stable reference keeps `useSyncExternalStore` from looping (its snapshot must
// be referentially stable while unchanged).
const EMPTY: MessageViewState = Object.freeze({
  reasoningExpanded: false,
  reasoningUserSet: false,
  sourcesExpanded: false,
  actionsRevealed: false,
});

export interface MessageViewStateStore {
  subscribe: (id: string, listener: () => void) => () => void;
  getSnapshot: (id: string) => MessageViewState;
  set: (id: string, patch: Partial<MessageViewState>) => void;
}

export function createMessageViewStateStore(): MessageViewStateStore {
  const state = new Map<string, MessageViewState>();
  const listeners = new Map<string, Set<() => void>>();

  return {
    subscribe(id, listener) {
      let set = listeners.get(id);
      if (!set) {
        set = new Set();
        listeners.set(id, set);
      }
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(id);
      };
    },
    getSnapshot(id) {
      return state.get(id) ?? EMPTY;
    },
    set(id, patch) {
      const current = state.get(id) ?? EMPTY;
      const next = { ...current, ...patch };
      // No-op identical writes so we never notify (and re-render) for nothing.
      if (
        next.reasoningExpanded === current.reasoningExpanded &&
        next.reasoningUserSet === current.reasoningUserSet &&
        next.sourcesExpanded === current.sourcesExpanded &&
        next.actionsRevealed === current.actionsRevealed
      ) {
        return;
      }
      state.set(id, next);
      const set = listeners.get(id);
      if (set) for (const listener of set) listener();
    },
  };
}

// Default value is a module-level store so a bubble rendered without a provider
// (e.g. in static-markup unit tests) reads benign defaults instead of throwing.
// In the app, `MessageViewStateProvider` always wraps the transcript, so this
// singleton never drives a rendered chat.
export const MessageViewStateContext = createContext<MessageViewStateStore>(
  createMessageViewStateStore(),
);

/**
 * Read/write one message's view state. Subscribes to only this id's slice, so a
 * toggle on another message never re-renders this bubble.
 */
export function useMessageViewState(
  id: string,
): [MessageViewState, (patch: Partial<MessageViewState>) => void] {
  const store = useContext(MessageViewStateContext);
  const subscribe = useCallback((cb: () => void) => store.subscribe(id, cb), [store, id]);
  const getSnapshot = useCallback(() => store.getSnapshot(id), [store, id]);
  // Third arg (server snapshot) mirrors the client read — defaults are SSR-safe.
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const set = useCallback((patch: Partial<MessageViewState>) => store.set(id, patch), [store, id]);
  return [state, set];
}
