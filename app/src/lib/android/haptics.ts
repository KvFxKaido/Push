/**
 * Subtle tactile feedback for the native (Android) shell. Restrained by design —
 * only key moments fire (long-press reveal, send, destructive confirms, branch
 * switch), not every tap. Fire-and-forget, native-gated, never throws: callers
 * just call `hapticLight()` / `hapticSuccess()` / etc. inline without awaiting.
 *
 * The vocabulary mirrors Apple's three haptic families (see
 * docs/research/Mobile-Feel Spec Map - Material 3 + Apple HIG.md):
 *   - impact       — physical taps (Light / Medium / Heavy)
 *   - selection    — the subtle "value ticked" feedback (pickers, toggles, tabs)
 *   - notification — an outcome landed (Success / Warning / Error)
 * Adding a helper is cheap; wiring it into a call site is a deliberate feel
 * decision, not something to spray across every interaction.
 */

import { isNativePlatform } from '../platform';

async function impact(style: 'Light' | 'Medium' | 'Heavy'): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
    await Haptics.impact({ style: ImpactStyle[style] });
  } catch {
    // Best effort — haptics are non-essential polish.
  }
}

async function notify(type: 'Success' | 'Warning' | 'Error'): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const { Haptics, NotificationType } = await import('@capacitor/haptics');
    await Haptics.notification({ type: NotificationType[type] });
  } catch {
    // Best effort — haptics are non-essential polish.
  }
}

async function selection(): Promise<void> {
  if (!isNativePlatform()) return;
  try {
    const { Haptics } = await import('@capacitor/haptics');
    // Capacitor's selectionChanged() only fires inside an open selection
    // session (Android guards on selectionStarted; iOS on a prepared
    // generator), so bracket it with start/end to emit exactly one tick
    // and leave no session open.
    await Haptics.selectionStart();
    await Haptics.selectionChanged();
    await Haptics.selectionEnd();
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

/** The heaviest tap — reserve for a rare, weighty confirmation. */
export function hapticHeavy(): void {
  void impact('Heavy');
}

/** The subtle "value changed" tick — pickers, toggles, segmented controls, tab switches. */
export function hapticSelection(): void {
  void selection();
}

/** An outcome landed well — a commit/push that succeeded, a check that passed. */
export function hapticSuccess(): void {
  void notify('Success');
}

/** An outcome needs attention — a soft-fail, a gate that flagged something. */
export function hapticWarning(): void {
  void notify('Warning');
}

/** An outcome failed — a rejected push, a required gate that could not run. */
export function hapticError(): void {
  void notify('Error');
}
