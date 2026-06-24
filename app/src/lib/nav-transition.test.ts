import { afterEach, describe, expect, it, vi } from 'vitest';

import { getChatShellNav, resolveNavMode } from './nav-transition';

// The app's vitest runs in the `node` environment (no DOM), so `window` is
// undefined by default — which also exercises resolveNavMode's SSR fallback.
// For the override cases we stub a minimal `window` (search + localStorage).
function stubWindow(search: string, store: Record<string, string> = {}) {
  vi.stubGlobal('window', {
    location: { search },
    localStorage: {
      getItem: (key: string) => (key in store ? store[key] : null),
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resolveNavMode', () => {
  it('falls back to the default (pager) with no window (SSR)', () => {
    expect(resolveNavMode()).toBe('pager');
  });

  it('defaults to pager when no override is present', () => {
    stubWindow('', {});
    expect(resolveNavMode()).toBe('pager');
  });

  it('honors a ?nav= URL override', () => {
    stubWindow('?nav=push');
    expect(resolveNavMode()).toBe('push');
  });

  it('honors a localStorage override', () => {
    stubWindow('', { 'push:navMode': 'push' });
    expect(resolveNavMode()).toBe('push');
  });

  it('ignores an invalid override and falls back to the default', () => {
    stubWindow('', { 'push:navMode': 'sideways' });
    expect(resolveNavMode()).toBe('pager');
  });

  it('prefers the URL over localStorage', () => {
    stubWindow('?nav=push', { 'push:navMode': 'pager' });
    expect(resolveNavMode()).toBe('push');
  });
});

describe('getChatShellNav', () => {
  it('push mode reproduces the legacy parallax offsets + shadow, no extra style', () => {
    const drawer = getChatShellNav('push', { drawerOpen: true, hubOpen: false });
    expect(drawer.transform).toBe('translateX(min(86vw, 24rem))');
    expect(drawer.shadowClass).toContain('shadow-[-24px');
    expect(drawer.style).toEqual({});

    const hub = getChatShellNav('push', { drawerOpen: false, hubOpen: true });
    expect(hub.transform).toBe('translateX(-94vw)');
    expect(hub.shadowClass).toContain('shadow-[24px');

    const closed = getChatShellNav('push', { drawerOpen: false, hubOpen: false });
    expect(closed.transform).toBe('translateX(0px)');
    expect(closed.shadowClass).toBe('');
  });

  it('pager mode fades + blurs + slides the chat toward the open menu', () => {
    // history is the page to the left → chat slides right as it exits.
    const drawer = getChatShellNav('pager', { drawerOpen: true, hubOpen: false });
    expect(drawer.transform).toBe('translateX(8px)');
    expect(drawer.style.opacity).toBe(0);
    expect(drawer.style.filter).toBe('blur(3px)');
    expect(drawer.style.pointerEvents).toBe('none');
    expect(drawer.shadowClass).toBe('');

    // hub is the page to the right → chat slides left.
    const hub = getChatShellNav('pager', { drawerOpen: false, hubOpen: true });
    expect(hub.transform).toBe('translateX(-8px)');
    expect(hub.style.opacity).toBe(0);

    const closed = getChatShellNav('pager', { drawerOpen: false, hubOpen: false });
    expect(closed.transform).toBe('translateX(0px)');
    expect(closed.style.opacity).toBe(1);
    expect(closed.style.filter).toBe('blur(0px)');
    expect(closed.style.pointerEvents).toBeUndefined();
  });
});
