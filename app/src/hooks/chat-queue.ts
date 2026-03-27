export type QueuedItemsByChat<T> = Record<string, T[]>;

export function appendQueuedItem<T>(
  existing: QueuedItemsByChat<T>,
  chatId: string,
  item: T,
): QueuedItemsByChat<T> {
  const current = existing[chatId] || [];
  return {
    ...existing,
    [chatId]: [...current, item],
  };
}

export function shiftQueuedItem<T>(
  existing: QueuedItemsByChat<T>,
  chatId: string,
): { next: QueuedItemsByChat<T>; item: T | null } {
  const current = existing[chatId] || [];
  if (current.length === 0) {
    return { next: existing, item: null };
  }

  const [item, ...rest] = current;
  if (rest.length === 0) {
    const next = { ...existing };
    delete next[chatId];
    return { next, item };
  }

  return {
    next: {
      ...existing,
      [chatId]: rest,
    },
    item,
  };
}

export function clearQueuedItems<T>(
  existing: QueuedItemsByChat<T>,
  chatId: string,
): QueuedItemsByChat<T> {
  if (!existing[chatId]?.length) return existing;
  const next = { ...existing };
  delete next[chatId];
  return next;
}
