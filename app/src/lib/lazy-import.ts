import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

const CHUNK_RELOAD_KEY = 'push:chunk-reload-attempted';

function isRecoverableChunkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  const lower = message.toLowerCase();
  return (
    lower.includes('failed to fetch dynamically imported module') ||
    lower.includes('importing a module script failed') ||
    lower.includes('chunkloaderror') ||
    lower.includes('loading chunk') ||
    (lower.includes('/assets/') && lower.includes('failed')) ||
    (lower.includes('/assets/') && lower.includes('missing'))
  );
}

async function clearRuntimeCaches(): Promise<void> {
  if (typeof window === 'undefined') return;

  try {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    }
  } catch {
    // Best effort.
  }

  try {
    if ('caches' in window) {
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
    }
  } catch {
    // Best effort.
  }
}

async function recoverFromChunkError(): Promise<never> {
  if (typeof window === 'undefined') {
    throw new Error('Chunk load failed outside a browser context.');
  }

  await clearRuntimeCaches();
  window.location.reload();
  return new Promise<never>(() => {});
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithRecovery<T extends ComponentType<any>>(
  importer: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(async () => {
    try {
      const loaded = await importer();
      if (typeof window !== 'undefined') {
        window.sessionStorage.removeItem(CHUNK_RELOAD_KEY);
      }
      return loaded;
    } catch (error) {
      if (
        typeof window !== 'undefined' &&
        isRecoverableChunkError(error) &&
        window.sessionStorage.getItem(CHUNK_RELOAD_KEY) !== '1'
      ) {
        window.sessionStorage.setItem(CHUNK_RELOAD_KEY, '1');
        return recoverFromChunkError();
      }
      throw error;
    }
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toDefaultExport<TModule, TComponent extends ComponentType<any>>(
  importer: () => Promise<TModule>,
  pick: (module: TModule) => TComponent,
): () => Promise<{ default: TComponent }> {
  return async () => {
    const module = await importer();
    return { default: pick(module) };
  };
}
