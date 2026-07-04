import { describe, expect, it } from 'vitest';
import { createMessageViewStateStore } from './useMessageViewState';

describe('message view-state store', () => {
  it('persists a toggle so a remounted bubble re-reads it (the whole point)', () => {
    const store = createMessageViewStateStore();
    store.set('m1', { reasoningExpanded: true });
    // A remount = a fresh component reading getSnapshot. Because the store lives
    // above the component, the value survives.
    expect(store.getSnapshot('m1').reasoningExpanded).toBe(true);
    expect(store.getSnapshot('m1').actionsRevealed).toBe(false);
  });

  it('returns a stable default reference for untouched ids', () => {
    const store = createMessageViewStateStore();
    // Same reference each read keeps useSyncExternalStore from looping.
    expect(store.getSnapshot('never')).toBe(store.getSnapshot('never'));
    expect(store.getSnapshot('never')).toEqual({
      reasoningExpanded: false,
      reasoningUserSet: false,
      sourcesExpanded: false,
      actionsRevealed: false,
    });
  });

  it('isolates ids — one message toggling does not touch another', () => {
    const store = createMessageViewStateStore();
    store.set('m1', { actionsRevealed: true });
    expect(store.getSnapshot('m2').actionsRevealed).toBe(false);
  });

  it('notifies only the affected id’s listeners', () => {
    const store = createMessageViewStateStore();
    let m1 = 0;
    let m2 = 0;
    store.subscribe('m1', () => m1++);
    store.subscribe('m2', () => m2++);
    store.set('m1', { sourcesExpanded: true });
    expect(m1).toBe(1);
    expect(m2).toBe(0);
  });

  it('no-ops an identical write so it does not notify', () => {
    const store = createMessageViewStateStore();
    let n = 0;
    store.subscribe('m1', () => n++);
    store.set('m1', { actionsRevealed: true });
    store.set('m1', { actionsRevealed: true });
    expect(n).toBe(1);
  });

  it('stops notifying after unsubscribe', () => {
    const store = createMessageViewStateStore();
    let n = 0;
    const unsub = store.subscribe('m1', () => n++);
    store.set('m1', { reasoningExpanded: true });
    unsub();
    store.set('m1', { reasoningExpanded: false });
    expect(n).toBe(1);
  });
});
