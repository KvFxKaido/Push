/**
 * One-time native-shell setup for the Capacitor (Android) build: status-bar
 * theming and keyboard resize behavior. Each step is best-effort and gated to the
 * native platform — web is untouched, and a missing/older plugin can never break
 * startup. Called once from the app shell on mount; the back-gesture binding is
 * separate (`back-handler.ts`).
 */

import { isNativePlatform } from '../platform';

let initialized = false;

export async function initAndroidShell(): Promise<void> {
  if (initialized || !isNativePlatform()) return;
  initialized = true;
  await Promise.allSettled([initStatusBar(), initKeyboard()]);
}

async function initStatusBar(): Promise<void> {
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    // Light icons for Push's dark surface (Style.Dark = light content for dark
    // backgrounds), instead of the mismatched OS default. We deliberately do NOT
    // set a background color: Android 15 enforces edge-to-edge and makes
    // setStatusBarColor a no-op, so the bar is transparent over the app's black
    // surface — the style (icon contrast) is the part that actually applies.
    await StatusBar.setStyle({ style: Style.Dark });
  } catch {
    // Best effort — startup must not depend on the status-bar plugin.
  }
}

async function initKeyboard(): Promise<void> {
  try {
    const { Keyboard, KeyboardResize } = await import('@capacitor/keyboard');
    // Resize the WebView when the keyboard appears so the bottom-anchored
    // composer stays above it; the app owns its own scrolling, so disable the
    // plugin's native scroll-into-view.
    await Keyboard.setResizeMode({ mode: KeyboardResize.Native });
    await Keyboard.setScroll({ isDisabled: true });
  } catch {
    // Best effort.
  }
}
