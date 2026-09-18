/**
 * The list of photos in the vault, newest first.
 *
 * Serialised to JSON and encrypted with the index sub-key before it ever touches disk, so file
 * names, capture times, sizes and original file names are all confidential.
 */
import { RecordFormatError } from '@/crypto/types';
import { photoEntryFromJson, photoEntryToJson } from '@/vault/photoEntry';
import type { PhotoEntry, VaultIndex, VaultIndexJson } from '@/vault/types';

export const EMPTY_INDEX: VaultIndex = { version: 1, photos: [] };

export function indexToJson(index: VaultIndex): VaultIndexJson {
  return { version: index.version, photos: index.photos.map(photoEntryToJson) };
}

export function indexFromJson(value: unknown): VaultIndex {
  if (typeof value !== 'object' || value === null) {
    throw new RecordFormatError('index is not an object');
  }
  const source = value as Record<string, unknown>;
  const version = source.version === undefined ? 1 : source.version;
  if (version !== 1) throw new RecordFormatError('unsupported index version');

  const rawPhotos = source.photos;
  if (rawPhotos !== undefined && !Array.isArray(rawPhotos)) {
    throw new RecordFormatError('index.photos is not an array');
  }
  return {
    version: 1,
    photos: (rawPhotos ?? []).map(photoEntryFromJson),
  };
}

export function encodeIndex(index: VaultIndex): string {
  return JSON.stringify(indexToJson(index));
}

export function decodeIndex(raw: string): VaultIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RecordFormatError('index is not valid JSON');
  }
  return indexFromJson(parsed);
}

export function withPhoto(index: VaultIndex, entry: PhotoEntry): VaultIndex {
  return { version: index.version, photos: [entry, ...index.photos] };
}

export function withoutPhotos(index: VaultIndex, ids: ReadonlySet<string>): VaultIndex {
  return { version: index.version, photos: index.photos.filter((p) => !ids.has(p.id)) };
}

export function findById(index: VaultIndex, id: string): PhotoEntry | null {
  return index.photos.find((p) => p.id === id) ?? null;
}

/** Newest first, which is the order the gallery renders. */
export function sortedNewestFirst(photos: readonly PhotoEntry[]): PhotoEntry[] {
  return [...photos].sort((a, b) => b.createdAt - a.createdAt);
}
