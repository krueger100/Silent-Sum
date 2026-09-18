/**
 * `ScreenProtection` on top of expo-screen-capture.
 *
 * Android: `preventScreenCaptureAsync` sets `FLAG_SECURE`, which blocks screenshots and screen
 * recording and blanks the recents preview. iOS: it blocks recordings (iOS 11+) and screenshots
 * (iOS 13+) and does nothing on older versions, which is why the privacy curtain rendered on
 * `inactive` is what actually keeps vault content out of the app-switcher snapshot there.
 *
 * Both calls are made with a fixed key so this adapter owns exactly one reservation: the key
 * passed to `preventScreenCaptureAsync` must be passed back to `allowScreenCaptureAsync` for
 * capture to be re-enabled, and using one constant keeps other callers from releasing ours.
 *
 * Nothing here ever throws or rejects. `preventScreenCaptureAsync` raises `UnavailabilityError`
 * when the native module is absent (Expo Go without the module, web, a stale dev client), and
 * losing screenshot blocking must never be able to break the unlock flow or wedge the vault open.
 * The module is pulled in with a lazy `require` inside the method for the same reason: importing
 * this file must not reach into native code.
 */
import type { ScreenProtection } from '@/privacy/types';

/** Reservation key owned by this adapter; see the note on paired prevent/allow calls above. */
export const SCREEN_CAPTURE_KEY = 'silentsum.vault';

interface ScreenCaptureModule {
  preventScreenCaptureAsync?: (key?: string) => Promise<void>;
  allowScreenCaptureAsync?: (key?: string) => Promise<void>;
}

export class ExpoScreenProtection implements ScreenProtection {
  async setSecure(enabled: boolean): Promise<void> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require('expo-screen-capture') as ScreenCaptureModule;
      const call = enabled ? mod.preventScreenCaptureAsync : mod.allowScreenCaptureAsync;
      if (typeof call !== 'function') return;
      await call(SCREEN_CAPTURE_KEY);
    } catch {
      // Swallowed on purpose: no native module, no permission, no platform support. Screen
      // protection is best effort and must never surface as a failure to the vault flow.
    }
  }
}
