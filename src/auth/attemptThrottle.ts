/**
 * Failed-attempt policy: escalating delays, capped, with nothing ever wiped automatically.
 *
 * Schedule, by consecutive failure count:
 *   1-2  no delay        (fat fingers on a calculator keypad)
 *   3    5 s
 *   4    15 s
 *   5    30 s
 *   6    1 min
 *   7+   5 min, doubling (10, 20, 40) up to a 1 hour cap
 *
 * Pure logic. Time and persistence are supplied by the caller, which is what makes the clock
 * attacks below testable.
 */
import { HOUR_MS, MINUTE_MS, SECOND_MS } from '@/utils/clock';
import { THROTTLE_INITIAL, type ThrottleState } from '@/auth/types';

const CAP_MS = HOUR_MS;

export function delayAfterMs(failedCount: number): number {
  if (failedCount <= 2) return 0;
  switch (failedCount) {
    case 3:
      return 5 * SECOND_MS;
    case 4:
      return 15 * SECOND_MS;
    case 5:
      return 30 * SECOND_MS;
    case 6:
      return MINUTE_MS;
    default:
      break;
  }
  const doublings = Math.min(Math.max(failedCount - 7, 0), 10);
  const minutes = 5 * 2 ** doublings;
  return Math.min(Math.max(minutes, 5) * MINUTE_MS, CAP_MS);
}

/**
 * Remaining lockout according to the wall clock.
 *
 * A clock moved backwards past the last failure would otherwise shorten or erase a lockout, so
 * that case is treated as the full current delay still being in force.
 */
export function remainingMs(state: ThrottleState, nowMs: number): number {
  if (state.lastFailureAt !== null && nowMs < state.lastFailureAt) {
    return delayAfterMs(state.failedCount);
  }
  if (state.lockedUntil === null) return 0;
  return Math.max(0, state.lockedUntil - nowMs);
}

export function isLocked(state: ThrottleState, nowMs: number): boolean {
  return remainingMs(state, nowMs) > 0;
}

export function recordFailure(state: ThrottleState, nowMs: number): ThrottleState {
  const failedCount = state.failedCount + 1;
  const delay = delayAfterMs(failedCount);
  return {
    failedCount,
    lockedUntil: delay === 0 ? null : nowMs + delay,
    lastFailureAt: nowMs,
  };
}

export function recordSuccess(): ThrottleState {
  return THROTTLE_INITIAL;
}

export function throttleStateToJson(state: ThrottleState): Record<string, number | null> {
  return {
    failedCount: state.failedCount,
    lockedUntil: state.lockedUntil,
    lastFailureAt: state.lastFailureAt,
  };
}

/** Tolerant: anything unrecognisable becomes the initial state rather than throwing. */
export function throttleStateFromJson(value: unknown): ThrottleState {
  if (typeof value !== 'object' || value === null) return THROTTLE_INITIAL;
  const source = value as Record<string, unknown>;
  const epoch = (raw: unknown): number | null =>
    typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  const failedCount = source.failedCount;
  return {
    failedCount:
      typeof failedCount === 'number' && Number.isFinite(failedCount) && failedCount >= 0
        ? Math.trunc(failedCount)
        : 0,
    lockedUntil: epoch(source.lockedUntil),
    lastFailureAt: epoch(source.lastFailureAt),
  };
}
