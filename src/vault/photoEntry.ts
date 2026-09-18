/**
 * Metadata for one vault photo. It exists only inside the encrypted index, never in a file name
 * and never in a database the OS can read.
 */
import { RecordFormatError } from '@/crypto/types';
import type { PhotoEntry, PhotoEntryJson, PhotoSource } from '@/vault/types';
import { parseIso8601, toIso8601Utc } from '@/utils/iso8601';

const SOURCES: readonly PhotoSource[] = ['camera', 'import', 'restore'];

export function photoEntryToJson(entry: PhotoEntry): PhotoEntryJson {
  return {
    id: entry.id,
    createdAt: toIso8601Utc(entry.createdAt),
    width: entry.width,
    height: entry.height,
    sizeBytes: entry.sizeBytes,
    source: entry.source,
    mimeType: entry.mimeType,
    originalName: entry.originalName,
    // Omitted for photos, so an index of photos serialises exactly as it did before videos, byte
    // for byte, and a vault written by an older build round-trips unchanged.
    ...(entry.durationMs === null ? {} : { durationMs: entry.durationMs }),
  };
}

function intField(source: Record<string, unknown>, name: string): number {
  const value = source[name];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new RecordFormatError(`photo.${name} is not a non-negative number`);
  }
  return Math.trunc(value);
}

export function photoEntryFromJson(value: unknown): PhotoEntry {
  if (typeof value !== 'object' || value === null) {
    throw new RecordFormatError('photo entry is not an object');
  }
  const source = value as Record<string, unknown>;
  if (typeof source.id !== 'string' || source.id.length === 0) {
    throw new RecordFormatError('photo.id is not a string');
  }
  const rawSource = source.source;
  const photoSource: PhotoSource =
    typeof rawSource === 'string' && (SOURCES as readonly string[]).includes(rawSource)
      ? (rawSource as PhotoSource)
      : 'import';

  const durationMs = source.durationMs;

  return {
    id: source.id,
    createdAt: parseIso8601(source.createdAt),
    width: intField(source, 'width'),
    height: intField(source, 'height'),
    sizeBytes: intField(source, 'sizeBytes'),
    source: photoSource,
    mimeType: typeof source.mimeType === 'string' ? source.mimeType : 'image/jpeg',
    originalName: typeof source.originalName === 'string' ? source.originalName : null,
    durationMs:
      typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0
        ? Math.trunc(durationMs)
        : null,
  };
}

export function aspectRatio(entry: PhotoEntry): number {
  return entry.height === 0 ? 1 : entry.width / entry.height;
}

export function withSource(entry: PhotoEntry, source: PhotoSource): PhotoEntry {
  return { ...entry, source };
}
