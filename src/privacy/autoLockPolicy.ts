/**
 * Decides whether a vault session that went to the background must be locked when the app comes
 * back to the foreground.
 *
 * Every value here is MONOTONIC milliseconds (`Clock.monotonicMs`), never wall clock: moving the
 * device clock backwards while the app sits in the background must not be able to defeat the
 * timeout. Mirrors `features/lifecycle/auto_lock_policy.dart` in the Flutter build.
 *
 * Composition with the picker/permission grace lives at the call site: while
 * `AutoLockSuspension.isSuspended` the caller passes
 * `Math.max(timeoutMs, AUTO_LOCK_SUSPENSION_GRACE_MS)` so a round trip through the system photo
 * picker does not lock the vault under the user's feet, while a genuinely long absence still does.
 */
export interface AutoLockInput {
  /** Monotonic ms at which the app was backgrounded, or null if it never left the foreground. */
  readonly backgroundedAtMs: number | null;
  /** Monotonic ms now (at the moment the app became active again). */
  readonly nowMs: number;
  /** Configured timeout in ms; `0` is the "Immediately" setting. */
  readonly timeoutMs: number;
}

/**
 * Pure predicate.
 *
 * - Never backgrounded (`null`) => false, whatever the timeout.
 * - Timeout `0` ("Immediately", and defensively anything negative) => true.
 * - Otherwise true once `nowMs - backgroundedAtMs >= timeoutMs`; the boundary is inclusive, so a
 *   one-minute timeout locks at exactly 60000 ms, not a millisecond later.
 */
export function shouldLock({ backgroundedAtMs, nowMs, timeoutMs }: AutoLockInput): boolean {
  if (backgroundedAtMs === null) return false;
  if (timeoutMs <= 0) return true;
  return nowMs - backgroundedAtMs >= timeoutMs;
}
