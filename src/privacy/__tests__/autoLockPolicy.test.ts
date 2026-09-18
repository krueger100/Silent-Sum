import { shouldLock } from '@/privacy/autoLockPolicy';
import { AUTO_LOCK_SUSPENSION_GRACE_MS } from '@/privacy/autoLockSuspension';
import {
  AUTO_LOCK_DURATION_MS,
  AUTO_LOCK_TIMEOUTS,
  type AutoLockTimeout,
} from '@/settings/appSettings';

/** An arbitrary monotonic origin: only differences are meaningful. */
const BACKGROUNDED_AT = 1_234_567;

const timed: AutoLockTimeout[] = AUTO_LOCK_TIMEOUTS.filter(
  (timeout) => AUTO_LOCK_DURATION_MS[timeout] > 0,
);

describe('shouldLock', () => {
  it.each(AUTO_LOCK_TIMEOUTS)('never locks a session that was never backgrounded (%s)', (t) => {
    expect(
      shouldLock({
        backgroundedAtMs: null,
        nowMs: BACKGROUNDED_AT + 10 * 60_000,
        timeoutMs: AUTO_LOCK_DURATION_MS[t],
      }),
    ).toBe(false);
  });

  describe('"Immediately" (timeout 0)', () => {
    it('locks even with no elapsed time at all', () => {
      expect(
        shouldLock({ backgroundedAtMs: BACKGROUNDED_AT, nowMs: BACKGROUNDED_AT, timeoutMs: 0 }),
      ).toBe(true);
    });

    it('still does nothing without a backgroundedAt', () => {
      expect(shouldLock({ backgroundedAtMs: null, nowMs: BACKGROUNDED_AT, timeoutMs: 0 })).toBe(
        false,
      );
    });

    it('treats a nonsensical negative timeout as immediate', () => {
      expect(
        shouldLock({ backgroundedAtMs: BACKGROUNDED_AT, nowMs: BACKGROUNDED_AT, timeoutMs: -1 }),
      ).toBe(true);
    });
  });

  describe.each(timed)('%s', (timeout) => {
    const timeoutMs = AUTO_LOCK_DURATION_MS[timeout];

    it('does not lock one millisecond early', () => {
      expect(
        shouldLock({
          backgroundedAtMs: BACKGROUNDED_AT,
          nowMs: BACKGROUNDED_AT + timeoutMs - 1,
          timeoutMs,
        }),
      ).toBe(false);
    });

    it('locks at exactly the boundary', () => {
      expect(
        shouldLock({
          backgroundedAtMs: BACKGROUNDED_AT,
          nowMs: BACKGROUNDED_AT + timeoutMs,
          timeoutMs,
        }),
      ).toBe(true);
    });

    it('locks past the boundary', () => {
      expect(
        shouldLock({
          backgroundedAtMs: BACKGROUNDED_AT,
          nowMs: BACKGROUNDED_AT + timeoutMs + 1,
          timeoutMs,
        }),
      ).toBe(true);
    });

    it('does not lock immediately on return', () => {
      expect(
        shouldLock({ backgroundedAtMs: BACKGROUNDED_AT, nowMs: BACKGROUNDED_AT, timeoutMs }),
      ).toBe(false);
    });
  });

  it('has the expected durations', () => {
    expect(AUTO_LOCK_DURATION_MS).toEqual({
      immediately: 0,
      thirtySeconds: 30_000,
      oneMinute: 60_000,
      fiveMinutes: 300_000,
      fifteenMinutes: 900_000,
    });
  });

  it('does not lock when the monotonic reading somehow went backwards', () => {
    expect(
      shouldLock({
        backgroundedAtMs: BACKGROUNDED_AT,
        nowMs: BACKGROUNDED_AT - 60_000,
        timeoutMs: 60_000,
      }),
    ).toBe(false);
  });

  describe('composed with the picker/permission grace', () => {
    const configured = AUTO_LOCK_DURATION_MS.thirtySeconds;
    const relaxed = Math.max(configured, AUTO_LOCK_SUSPENSION_GRACE_MS);

    it('keeps a short picker round trip unlocked', () => {
      expect(
        shouldLock({
          backgroundedAtMs: BACKGROUNDED_AT,
          nowMs: BACKGROUNDED_AT + 45_000,
          timeoutMs: relaxed,
        }),
      ).toBe(false);
    });

    it('still locks once the grace itself has elapsed', () => {
      expect(
        shouldLock({
          backgroundedAtMs: BACKGROUNDED_AT,
          nowMs: BACKGROUNDED_AT + AUTO_LOCK_SUSPENSION_GRACE_MS,
          timeoutMs: relaxed,
        }),
      ).toBe(true);
    });

    it('would have locked that same round trip without the grace', () => {
      expect(
        shouldLock({
          backgroundedAtMs: BACKGROUNDED_AT,
          nowMs: BACKGROUNDED_AT + 45_000,
          timeoutMs: configured,
        }),
      ).toBe(true);
    });
  });
});
