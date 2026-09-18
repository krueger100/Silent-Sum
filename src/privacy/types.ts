/**
 * Privacy/lifecycle contracts: screenshot blocking and app-switcher protection.
 */
export interface ScreenProtection {
  /**
   * Android: FLAG_SECURE (no screenshots, no recording, blank recents preview).
   * iOS: best-effort screenshot/recording prevention via expo-screen-capture. Never throws.
   */
  setSecure(enabled: boolean): Promise<void>;
}

export class NoopScreenProtection implements ScreenProtection {
  async setSecure(): Promise<void> {}
}

/** Test double recording every call. */
export class RecordingScreenProtection implements ScreenProtection {
  readonly calls: boolean[] = [];
  async setSecure(enabled: boolean): Promise<void> {
    this.calls.push(enabled);
  }
}

/** Grace window while a system picker/permission dialog is in front (auto-lock relaxed). */
export const AUTO_LOCK_SUSPENSION_GRACE_MS = 5 * 60_000;
