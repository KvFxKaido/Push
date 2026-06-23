import type { CSSProperties } from 'react';

/**
 * App navigation model for the chat-history drawer and the workspace hub.
 *
 * - `push` (legacy): the chat shell slides aside (`translateX`) to reveal the
 *   menu — a parallax push. The drawer and hub used different offsets, which
 *   read as an uneven left/right rhythm.
 * - `pager` (default): chat is a center "page" that cross-fades + blurs + slides
 *   a touch toward the incoming menu (history = the page to the left, hub = the
 *   page to the right), so opening either reads as a symmetric page swap — the
 *   same motion vocabulary as the panel reveals.
 *
 * Reversible: flip `NAV_MODE_DEFAULT` below to revert everywhere, or override at
 * runtime with no redeploy via `?nav=push` / `?nav=pager` in the URL, or
 * `localStorage['push:navMode'] = 'push' | 'pager'`.
 */
export type NavMode = 'pager' | 'push';

export const NAV_MODE_DEFAULT: NavMode = 'pager';

export function resolveNavMode(): NavMode {
  if (typeof window === 'undefined') return NAV_MODE_DEFAULT;
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('nav');
    if (fromUrl === 'push' || fromUrl === 'pager') return fromUrl;
    const fromStore = window.localStorage.getItem('push:navMode');
    if (fromStore === 'push' || fromStore === 'pager') return fromStore;
  } catch {
    // SSR / blocked storage / malformed URL — fall back to the default.
  }
  return NAV_MODE_DEFAULT;
}

// ── push (legacy parallax) ──────────────────────────────
const PUSH_DRAWER_OFFSET = 'min(86vw, 24rem)';
const PUSH_HUB_OFFSET = '94vw';

// ── pager (page swap) — tune these to taste ─────────────
const PAGE_SLIDE = '8px';
const PAGE_BLUR = '3px';
const PAGE_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';
const PAGE_DUR = '250ms';
const PAGE_TRANSITION = `opacity ${PAGE_DUR} ${PAGE_EASE}, transform ${PAGE_DUR} ${PAGE_EASE}, filter ${PAGE_DUR} ${PAGE_EASE}`;

export interface ChatShellNav {
  /** Goes on the shell's `transform` (kept separate so callers can read it). */
  transform: string;
  /** Extra inline style — opacity/filter/transition/pointer-events. Empty in push mode. */
  style: CSSProperties;
  /** Directional depth-shadow utility class — only push uses it. */
  shadowClass: string;
}

/**
 * Resolves how the chat shell should render for the current nav mode and which
 * menu (if any) is open. The push branch reproduces the legacy parallax exactly;
 * the pager branch fades/blurs/slides the chat out as a page exit.
 */
export function getChatShellNav(
  mode: NavMode,
  { drawerOpen, hubOpen }: { drawerOpen: boolean; hubOpen: boolean },
): ChatShellNav {
  if (mode === 'push') {
    return {
      transform: drawerOpen
        ? `translateX(${PUSH_DRAWER_OFFSET})`
        : hubOpen
          ? `translateX(-${PUSH_HUB_OFFSET})`
          : 'translateX(0px)',
      style: {},
      shadowClass: drawerOpen
        ? 'shadow-[-24px_0_56px_rgba(0,0,0,0.42)]'
        : hubOpen
          ? 'shadow-[24px_0_56px_rgba(0,0,0,0.42)]'
          : '',
    };
  }

  // pager: chat exits toward the incoming menu (drawer = left page → shift
  // right; hub = right page → shift left), fading + blurring out so the menu
  // reads as a page swap rather than a push.
  const open = drawerOpen || hubOpen;
  return {
    transform: drawerOpen
      ? `translateX(${PAGE_SLIDE})`
      : hubOpen
        ? `translateX(-${PAGE_SLIDE})`
        : 'translateX(0px)',
    style: {
      opacity: open ? 0 : 1,
      filter: open ? `blur(${PAGE_BLUR})` : 'blur(0px)',
      transition: PAGE_TRANSITION,
      // The faded-out chat must not intercept taps meant for the menu/overlay.
      pointerEvents: open ? 'none' : undefined,
    },
    shadowClass: '',
  };
}
