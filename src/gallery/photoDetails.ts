/**
 * Display formatting for the viewer's details sheet.
 *
 * Kept away from the component so the rounding rules can be read (and tested) on their own. These
 * strings are shown to the user; none of them is ever logged.
 */
import { isVideo } from '@/vault/mediaKind';
import type { PhotoEntry } from '@/vault/types';

/** `1023 B`, `12 KB`, `3.4 MB` -- the Flutter reference's thresholds, unchanged. */
export function formatSizeBytes(sizeBytes: number): string {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return '0 B';
  if (sizeBytes < 1024) return `${String(Math.round(sizeBytes))} B`;
  if (sizeBytes < 1024 * 1024) return `${String(Math.round(sizeBytes / 1024))} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `W × H` with a real multiplication sign. */
export function formatDimensions(entry: Pick<PhotoEntry, 'width' | 'height'>): string {
  return `${String(entry.width)} × ${String(entry.height)}`;
}

/** What the item is, in the user's words rather than a MIME type. */
export function formatKind(entry: Pick<PhotoEntry, 'mimeType'>): string {
  return isVideo(entry) ? 'Video' : 'Photo';
}

export function formatSource(entry: Pick<PhotoEntry, 'source' | 'originalName'>): string {
  switch (entry.source) {
    case 'camera':
      return 'Camera';
    case 'import':
      return entry.originalName === null ? 'Imported' : `Imported (${entry.originalName})`;
    case 'restore':
      return 'Restored from backup';
  }
}

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

/**
 * Local time, `Jan 1, 2026 12:00 PM`. Written out rather than delegated to `toLocaleString`,
 * whose output varies by JS engine and would make the value untestable.
 */
export function formatTaken(epochMs: number): string {
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  const month = MONTHS[date.getMonth()] ?? MONTHS[0];
  const hours24 = date.getHours();
  const period = hours24 < 12 ? 'AM' : 'PM';
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${month} ${String(date.getDate())}, ${String(date.getFullYear())} ${String(hours12)}:${minutes} ${period}`;
}
