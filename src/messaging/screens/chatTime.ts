/**
 * Clock and calendar labels for the chat screens.
 *
 * Two different jobs, so two different rules. The clock is locale-formatted, because whether a
 * person reads 14:05 or 2:05 PM is a habit their phone already knows. Everything coarser is
 * spelled out here instead, deterministically: a day separator is read as a landmark while
 * scrolling, and "Yesterday" or "Mon" carries that better than any date a locale would produce.
 *
 * `now` is always passed in rather than read from the system clock, so the labels are a pure
 * function of their inputs and the screens keep using the app's own clock.
 */

const DAY_MS = 86_400_000;

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** Local midnight, which is what "the same day" means to the person reading the screen. */
function startOfDay(millis: number): number {
  const date = new Date(millis);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export function sameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b);
}

/** Whole days between two instants, counted by calendar date rather than by elapsed hours. */
function daysBetween(millis: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(millis)) / DAY_MS);
}

function dateLabel(millis: number, now: number): string {
  const date = new Date(millis);
  const day = String(date.getDate());
  const month = MONTHS[date.getMonth()] ?? '';
  return date.getFullYear() === new Date(now).getFullYear()
    ? `${day} ${month}`
    : `${day} ${month} ${String(date.getFullYear())}`;
}

/** A clock, as the device spells clocks. */
export function clockLabel(millis: number): string {
  return new Date(millis).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/** The chip that separates one day of a conversation from the next. */
export function daySeparatorLabel(millis: number, now: number): string {
  const days = daysBetween(millis, now);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return WEEKDAYS[new Date(millis).getDay()] ?? '';
  return dateLabel(millis, now);
}

/**
 * The trailing label on a conversation row: precise today, then progressively coarser, because a
 * list is scanned for "which of these is recent" rather than read for exact times.
 */
export function listTimeLabel(millis: number, now: number): string {
  if (millis <= 0) return '';
  const days = daysBetween(millis, now);
  if (days <= 0) return clockLabel(millis);
  if (days === 1) return 'Yesterday';
  if (days < 7) return WEEKDAYS_SHORT[new Date(millis).getDay()] ?? '';
  return dateLabel(millis, now);
}
