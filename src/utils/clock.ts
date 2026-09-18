/**
 * Time sources. Security timeouts (auto-lock, throttling) use `monotonicMs()`, which only moves
 * forward within a process and ignores wall-clock edits. `now()` is for display and persisted
 * timestamps only.
 */
export interface Clock {
  /** Wall clock, epoch milliseconds (user editable). */
  now(): number;
  /** Process-monotonic milliseconds; arbitrary origin, only differences are meaningful. */
  monotonicMs(): number;
}

export class SystemClock implements Clock {
  private readonly origin =
    typeof performance !== 'undefined' && typeof performance.now === 'function'
      ? null
      : Date.now();

  now(): number {
    return Date.now();
  }

  monotonicMs(): number {
    if (this.origin === null) return performance.now();
    return Date.now() - this.origin;
  }
}

/** Test clock: `advance` moves both sources, `setNow` moves only the wall clock. */
export class FakeClock implements Clock {
  private wall: number;
  private mono = 0;

  constructor(startEpochMs: number = Date.UTC(2026, 0, 1, 12, 0, 0)) {
    this.wall = startEpochMs;
  }

  now(): number {
    return this.wall;
  }

  monotonicMs(): number {
    return this.mono;
  }

  advance(ms: number): void {
    this.wall += ms;
    this.mono += ms;
  }

  setNow(epochMs: number): void {
    this.wall = epochMs;
  }
}

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
