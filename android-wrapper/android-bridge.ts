/**
 * android-bridge.ts
 *
 * Copy this file to your PWA (e.g., app/src/lib/android-bridge.ts)
 *
 * Provides type-safe access to Android wrapper's native features.
 * Falls back gracefully when running in browser.
 */

// Type definitions for the Android bridge
interface PushAndroidBridge {
  getDeviceInfo(): string;
  shareText(text: string): void;
  shareFile(path: string, mimeType: string): void;
  readFile(path: string): string;
  writeFile(path: string, content: string): string;
  showToast(message: string): void;
  openExternalBrowser(url: string): void;
}

// Augment window type
declare global {
  interface Window {
    PushAndroid?: PushAndroidBridge;
  }
}

// Device info structure
interface DeviceInfo {
  isNativeWrapper: boolean;
  platform: string;
  version: number;
  model: string;
  manufacturer: string;
}

// Check if running in native Android wrapper
export const isAndroidWrapper = (): boolean => {
  return typeof window !== 'undefined' && typeof window.PushAndroid !== 'undefined';
};

// Get device info
export const getDeviceInfo = (): DeviceInfo | null => {
  if (!isAndroidWrapper()) return null;

  try {
    const info = window.PushAndroid!.getDeviceInfo();
    return JSON.parse(info);
  } catch (e) {
    console.error('Failed to get device info:', e);
    return null;
  }
};

// Share text with progressive enhancement
export const shareText = async (text: string): Promise<boolean> => {
  // Try Android native first
  if (isAndroidWrapper()) {
    try {
      window.PushAndroid!.shareText(text);
      return true;
    } catch (e) {
      console.error('Android share failed:', e);
    }
  }

  // Fall back to Web Share API
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return true;
    } catch (e) {
      if ((e as Error).name !== 'AbortError') {
        console.error('Web share failed:', e);
      }
    }
  }

  // Final fallback: clipboard
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    console.error('Clipboard write failed:', e);
    return false;
  }
};

// Show a toast (Android only, no-op in browser)
export const showToast = (message: string): void => {
  if (isAndroidWrapper()) {
    window.PushAndroid!.showToast(message);
  } else {
    // Could show a notification or snackbar in browser
    console.log('Toast:', message);
  }
};

// Read file (Android only)
export const readFile = async (path: string): Promise<string | null> => {
  if (!isAndroidWrapper()) {
    console.warn('File reading only available in Android wrapper');
    return null;
  }

  try {
    const result = window.PushAndroid!.readFile(path);
    const parsed = JSON.parse(result);

    if (parsed.error) {
      console.error('Read file error:', parsed.error);
      return null;
    }

    return result;
  } catch (e) {
    console.error('Failed to read file:', e);
    return null;
  }
};

// Write file (Android only)
export const writeFile = async (path: string, content: string): Promise<boolean> => {
  if (!isAndroidWrapper()) {
    console.warn('File writing only available in Android wrapper');
    return false;
  }

  try {
    const result = window.PushAndroid!.writeFile(path, content);
    const parsed = JSON.parse(result);

    if (parsed.error) {
      console.error('Write file error:', parsed.error);
      return false;
    }

    return parsed.success === true;
  } catch (e) {
    console.error('Failed to write file:', e);
    return false;
  }
};

// Open URL in external browser (Android only)
export const openExternalBrowser = (url: string): void => {
  if (isAndroidWrapper()) {
    window.PushAndroid!.openExternalBrowser(url);
  } else {
    // In browser, just open in new tab
    window.open(url, '_blank');
  }
};

// Example usage:
/*
import { isAndroidWrapper, shareText, showToast } from './lib/android-bridge';

// Check if running in wrapper
if (isAndroidWrapper()) {
  console.log('Running in native Android app!');
}

// Share with progressive enhancement
const handleShare = async () => {
  const success = await shareText('Check out this code!');
  if (success) {
    showToast('Shared successfully!');
  }
};
*/
