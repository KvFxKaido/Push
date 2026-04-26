import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearMigrationMarker,
  getMigrationMarker,
  MIGRATION_MARKER_STALE_MS,
  setMigrationMarker,
  subscribeToMigrationMarker,
  type BranchMigrationMarker,
} from './branch-migration-marker';

const MARKER_STORAGE_KEY = 'push:branch-migration-marker';

type StorageListener = (event: StorageEvent) => void;

function createStorageMock() {
  const data = new Map<string, string>();

  return {
    getItem: vi.fn((key: string) => (data.has(key) ? data.get(key)! : null)),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
    }),
  };
}

function createWindowMock(localStorage = createStorageMock()) {
  const listeners = new Set<StorageListener>();

  return {
    localStorage,
    addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'storage') listeners.add(listener as StorageListener);
    }),
    removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === 'storage') listeners.delete(listener as StorageListener);
    }),
    dispatchStorageEvent(event: Pick<StorageEvent, 'key' | 'newValue'>) {
      for (const listener of listeners) {
        listener(event as StorageEvent);
      }
    },
  };
}

function freshMarker(overrides: Partial<BranchMigrationMarker> = {}): BranchMigrationMarker {
  return {
    chatId: 'chat-1',
    fromBranch: 'main',
    toBranch: 'feature/preserve-chat',
    startedAt: 1_000,
    ...overrides,
  };
}

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(1_000);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('branch migration marker', () => {
  it('writes the expected JSON to localStorage with startedAt populated by Date.now()', () => {
    const localStorage = createStorageMock();
    vi.stubGlobal('window', createWindowMock(localStorage));

    setMigrationMarker({
      chatId: 'chat-1',
      fromBranch: 'main',
      toBranch: 'feature/preserve-chat',
    });

    expect(localStorage.setItem).toHaveBeenCalledWith(
      MARKER_STORAGE_KEY,
      JSON.stringify(freshMarker()),
    );
  });

  it('swallows errors when localStorage throws', () => {
    const localStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(() => {
        throw new Error('blocked');
      }),
      removeItem: vi.fn(),
    };
    vi.stubGlobal('window', createWindowMock(localStorage));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => {
      setMigrationMarker({
        chatId: 'chat-1',
        fromBranch: 'main',
        toBranch: 'feature/preserve-chat',
      });
    }).not.toThrow();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('returns the parsed marker when fresh', () => {
    const localStorage = createStorageMock();
    vi.stubGlobal('window', createWindowMock(localStorage));
    localStorage.setItem(MARKER_STORAGE_KEY, JSON.stringify(freshMarker()));

    expect(getMigrationMarker()).toEqual(freshMarker());
  });

  it('returns null when the key is missing', () => {
    vi.stubGlobal('window', createWindowMock());

    expect(getMigrationMarker()).toBeNull();
  });

  it('returns null when the JSON is malformed', () => {
    const localStorage = createStorageMock();
    vi.stubGlobal('window', createWindowMock(localStorage));
    localStorage.setItem(MARKER_STORAGE_KEY, '{broken');

    expect(getMigrationMarker()).toBeNull();
  });

  it('returns null when the marker is stale', () => {
    const localStorage = createStorageMock();
    vi.stubGlobal('window', createWindowMock(localStorage));
    localStorage.setItem(MARKER_STORAGE_KEY, JSON.stringify(freshMarker()));
    vi.mocked(Date.now).mockReturnValue(1_000 + MIGRATION_MARKER_STALE_MS + 1);

    expect(getMigrationMarker()).toBeNull();
  });

  it('returns null when fields are missing or wrong type', () => {
    const localStorage = createStorageMock();
    vi.stubGlobal('window', createWindowMock(localStorage));

    const invalidMarkers: unknown[] = [
      {},
      { fromBranch: 'main', toBranch: 'feature', startedAt: 1_000 },
      { chatId: 123, fromBranch: 'main', toBranch: 'feature', startedAt: 1_000 },
      { chatId: 'chat-1', fromBranch: null, toBranch: 'feature', startedAt: 1_000 },
      { chatId: 'chat-1', fromBranch: 'main', toBranch: false, startedAt: 1_000 },
      { chatId: 'chat-1', fromBranch: 'main', toBranch: 'feature', startedAt: 'now' },
      { chatId: 'chat-1', fromBranch: 'main', toBranch: 'feature', startedAt: Infinity },
    ];

    for (const invalidMarker of invalidMarkers) {
      localStorage.setItem(MARKER_STORAGE_KEY, JSON.stringify(invalidMarker));
      expect(getMigrationMarker()).toBeNull();
    }
  });

  it('removes the key from localStorage', () => {
    const localStorage = createStorageMock();
    vi.stubGlobal('window', createWindowMock(localStorage));
    localStorage.setItem(MARKER_STORAGE_KEY, JSON.stringify(freshMarker()));

    clearMigrationMarker();

    expect(localStorage.removeItem).toHaveBeenCalledWith(MARKER_STORAGE_KEY);
    expect(localStorage.getItem(MARKER_STORAGE_KEY)).toBeNull();
  });

  it('fires the callback with the parsed marker on a storage event for the marker key', () => {
    const windowMock = createWindowMock();
    vi.stubGlobal('window', windowMock);
    const callback = vi.fn();

    subscribeToMigrationMarker(callback);
    windowMock.dispatchStorageEvent({
      key: MARKER_STORAGE_KEY,
      newValue: JSON.stringify(freshMarker()),
    });

    expect(callback).toHaveBeenCalledWith(freshMarker());
  });

  it('fires the callback with null when the marker is cleared', () => {
    const windowMock = createWindowMock();
    vi.stubGlobal('window', windowMock);
    const callback = vi.fn();

    subscribeToMigrationMarker(callback);
    windowMock.dispatchStorageEvent({
      key: MARKER_STORAGE_KEY,
      newValue: null,
    });

    expect(callback).toHaveBeenCalledWith(null);
  });

  it('does not fire the callback for storage events on different keys', () => {
    const windowMock = createWindowMock();
    vi.stubGlobal('window', windowMock);
    const callback = vi.fn();

    subscribeToMigrationMarker(callback);
    windowMock.dispatchStorageEvent({
      key: 'push:other-key',
      newValue: JSON.stringify(freshMarker()),
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it('removes the listener when unsubscribed', () => {
    const windowMock = createWindowMock();
    vi.stubGlobal('window', windowMock);
    const callback = vi.fn();

    const unsubscribe = subscribeToMigrationMarker(callback);
    unsubscribe();
    windowMock.dispatchStorageEvent({
      key: MARKER_STORAGE_KEY,
      newValue: JSON.stringify(freshMarker()),
    });

    expect(windowMock.removeEventListener).toHaveBeenCalledWith('storage', expect.any(Function));
    expect(callback).not.toHaveBeenCalled();
  });
});
