import { createContext, useCallback, useContext, useState, useSyncExternalStore } from 'react';

import { tuiRenderAssertionsEnabled } from './render-contract.js';

/**
 * Immutable view of per-component expansion state, keyed `<component>:<rowId>`
 * (`review:` / `tool:` / `diff:` / `group:`). Assertion renders receive one of
 * these frozen at rect-commit time so the duplicate tree reproduces exactly the
 * state the live row was measured in.
 */
export type TranscriptExpansionSnapshot = ReadonlyMap<string, boolean>;

export interface TranscriptExpansionStore {
  isExpanded(key: string): boolean;
  toggle(key: string): void;
  subscribe(listener: () => void): () => void;
  snapshot(): TranscriptExpansionSnapshot;
}

export function createTranscriptExpansionStore(): TranscriptExpansionStore {
  const state = new Map<string, boolean>();
  const listeners = new Set<() => void>();
  return {
    isExpanded: (key) => state.get(key) ?? false,
    toggle(key) {
      state.set(key, !(state.get(key) ?? false));
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => new Map(state),
  };
}

/**
 * Live expansion state shared by the committed transcript tree and the render
 * observer. Exists only under PUSH_TUI_ASSERT=1 — with assertions disabled,
 * components keep their original per-mount useState, so the production path is
 * byte-for-byte the pre-contract behavior.
 */
export const transcriptExpansion: TranscriptExpansionStore | null = tuiRenderAssertionsEnabled()
  ? createTranscriptExpansionStore()
  : null;

/**
 * `renderStringSync` mounts a fresh reconciler, so the assertion tree cannot
 * inherit context or component state from the live surface. It instead wraps
 * its element in this provider carrying the frozen snapshot; components read
 * the snapshot in place of the live store, which also makes the assertion
 * render immune to toggles that land between rect commit and the microtask
 * that renders the duplicate tree.
 */
export const TranscriptExpansionOverrideContext = createContext<TranscriptExpansionSnapshot | null>(
  null,
);

const noopUnsubscribe = () => {};

export function useTranscriptExpansion(key: string): [boolean, () => void] {
  const override = useContext(TranscriptExpansionOverrideContext);
  const [local, setLocal] = useState(false);
  const subscribe = useCallback(
    (listener: () => void) => {
      if (override || !transcriptExpansion) return noopUnsubscribe;
      return transcriptExpansion.subscribe(listener);
    },
    [override],
  );
  const shared = useSyncExternalStore(subscribe, () =>
    override
      ? (override.get(key) ?? false)
      : transcriptExpansion
        ? transcriptExpansion.isExpanded(key)
        : false,
  );
  const expanded = override || transcriptExpansion ? shared : local;
  const toggle = useCallback(() => {
    if (override) return;
    if (transcriptExpansion) transcriptExpansion.toggle(key);
    else setLocal((value) => !value);
  }, [key, override]);
  return [expanded, toggle];
}
