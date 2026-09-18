/**
 * Counts the flows that hand control to another activity on purpose -- the system photo picker,
 * the camera, a runtime permission dialog. Those foreground/background transitions are the user's
 * own doing, so while the count is above zero the caller relaxes the auto-lock timeout to
 * `AUTO_LOCK_SUSPENSION_GRACE_MS` instead of the configured one (see `shouldLock` in
 * `@/privacy/autoLockPolicy`). A genuinely long absence still locks.
 *
 * It is a counter and not a boolean because these flows nest: a picker that triggers a permission
 * prompt suspends twice and must resume twice before auto-lock returns to normal. Mirrors
 * `features/lifecycle/auto_lock_suspension.dart` in the Flutter build.
 */
export { AUTO_LOCK_SUSPENSION_GRACE_MS } from '@/privacy/types';

export class AutoLockSuspension {
  private depth = 0;

  /** Nesting depth; exposed for assertions and diagnostics. */
  get count(): number {
    return this.depth;
  }

  get isSuspended(): boolean {
    return this.depth > 0;
  }

  suspend(): void {
    this.depth += 1;
  }

  /**
   * Clamped at zero. An unbalanced `resume()` (a picker that reports a cancel twice, a screen
   * unmounted after it already resumed) must not push the count negative: a negative count would
   * swallow the next real `suspend()` and leave the vault unlocked across a picker round trip.
   */
  resume(): void {
    this.depth = this.depth > 0 ? this.depth - 1 : 0;
  }

  /** Drops every outstanding suspension. Called when the vault locks, so nothing carries over. */
  reset(): void {
    this.depth = 0;
  }
}
