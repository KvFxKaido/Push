/**
 * local-pc-storage.test.ts — IndexedDB round-trip coverage for the
 * paired-device store. Mirrors the fake-indexeddb harness from
 * `app-db.test.ts` so each case starts on a fresh in-memory IDB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadFreshModule() {
  vi.resetModules();
  return import('./local-pc-storage');
}

beforeEach(async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  vi.stubGlobal('indexedDB', new IDBFactory());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local-pc-storage', () => {
  it('returns null when no device is paired', async () => {
    const { getPairedDevice } = await loadFreshModule();
    expect(await getPairedDevice()).toBeNull();
  });

  it('round-trips a paired device: set → get', async () => {
    const { getPairedDevice, mintPairedDeviceId, setPairedDevice } = await loadFreshModule();
    const record = {
      id: mintPairedDeviceId(),
      port: 49152,
      token: 'bearer.abc',
      tokenId: 'tk_123',
      boundOrigin: 'http://localhost:5173',
      pairedAt: 1_700_000_000_000,
    };
    await setPairedDevice(record);
    expect(await getPairedDevice()).toEqual(record);
  });

  it('setPairedDevice overwrites the existing record', async () => {
    const { getPairedDevice, mintPairedDeviceId, setPairedDevice } = await loadFreshModule();
    const id = mintPairedDeviceId();
    await setPairedDevice({
      id,
      port: 1,
      token: 'old',
      boundOrigin: 'http://a',
      pairedAt: 1,
    });
    await setPairedDevice({
      id,
      port: 2,
      token: 'new',
      boundOrigin: 'http://b',
      pairedAt: 2,
    });
    const got = await getPairedDevice();
    expect(got?.port).toBe(2);
    expect(got?.token).toBe('new');
  });

  it('clearPairedDevice wipes the store', async () => {
    const { clearPairedDevice, getPairedDevice, mintPairedDeviceId, setPairedDevice } =
      await loadFreshModule();
    await setPairedDevice({
      id: mintPairedDeviceId(),
      port: 4242,
      token: 't',
      boundOrigin: 'http://localhost:5173',
      pairedAt: Date.now(),
    });
    await clearPairedDevice();
    expect(await getPairedDevice()).toBeNull();
  });

  it('touchLastUsed updates lastUsedAt without losing the bearer', async () => {
    const { getPairedDevice, mintPairedDeviceId, setPairedDevice, touchLastUsed } =
      await loadFreshModule();
    const id = mintPairedDeviceId();
    await setPairedDevice({
      id,
      port: 1234,
      token: 'bearer.xyz',
      boundOrigin: 'http://localhost:5173',
      pairedAt: 100,
    });
    await touchLastUsed(id, 999);
    const got = await getPairedDevice();
    expect(got?.lastUsedAt).toBe(999);
    expect(got?.token).toBe('bearer.xyz');
  });

  it('touchLastUsed on an unknown id is a no-op', async () => {
    const { getPairedDevice, touchLastUsed } = await loadFreshModule();
    await touchLastUsed('nope', 999);
    expect(await getPairedDevice()).toBeNull();
  });

  it('falls back to first record when the canonical id is missing', async () => {
    // Forwards-compat: a future multi-device UI may write under
    // different ids. The read path should still surface something so
    // a paired user isn't shown the empty state by accident.
    const { getPairedDevice } = await loadFreshModule();
    const { put } = await import('./app-db');
    await put('paired_devices', {
      id: 'some-future-uuid',
      port: 7777,
      token: 'bearer.future',
      boundOrigin: 'http://localhost:5173',
      pairedAt: 5,
    });
    const got = await getPairedDevice();
    expect(got?.port).toBe(7777);
  });
});
