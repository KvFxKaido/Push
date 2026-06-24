/**
 * Subtle tactile feedback for the native (Android) shell. Restrained by design —
 * only key moments fire (long-press reveal, send, destructive confirms, branch
 * switch), not every tap. Fire-and-forget, native-gated, never throws: callers
 * just call `hapticLight()` / `hapticMedium()` inline without awaiting.
 */

import { isNativePlatform } from '../platform';

async function impact(style: 'Light' | 'Medium'): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
    await Haptics.impact({ style: ImpactStyle[style] });
  } catch {
    // Best effort — haptics are non-essential polish.
  }
}

/** A light tap — a reveal or a primary send (frequent, gentle). */
export function hapticLight(): void {
  void impact('Light');
}

/** A firmer tap — a committed/destructive action (delete, clear, branch switch). */
export function hapticMedium(): void {
  void impact('Medium');
}
