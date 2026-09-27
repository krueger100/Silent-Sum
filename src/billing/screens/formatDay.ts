/**
 * A calendar date for a status line, in the device's local time.
 *
 * Deterministic rather than locale-formatted: the tests pin sentences, and the sentences are
 * about dates that were set by the server, so "21 Sep 2026" must read the same on every phone.
 */
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

export function formatDay(epochMs: number): string {
  const date = new Date(epochMs);
  const month = MONTHS[date.getMonth()] ?? '';
  return `${String(date.getDate())} ${month} ${String(date.getFullYear())}`;
}
