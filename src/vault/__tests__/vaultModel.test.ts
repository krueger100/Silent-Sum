import { RecordFormatError } from '@/crypto/types';
import { DecryptedImageCache } from '@/vault/decryptedImageCache';
import { aspectRatio, photoEntryFromJson, photoEntryToJson } from '@/vault/photoEntry';
import { InvalidPhotoIdError, VaultPaths, assertPhotoId } from '@/vault/vaultPaths';
import {
  EMPTY_INDEX,
  decodeIndex,
  encodeIndex,
  findById,
  sortedNewestFirst,
  withPhoto,
  withoutPhotos,
} from '@/vault/vaultIndex';
import type { PhotoEntry } from '@/vault/types';
import { toHex } from '@/utils/bytes';

function entry(id: string, createdAt = Date.UTC(2026, 0, 1)): PhotoEntry {
  return {
    id,
    createdAt,
    width: 1200,
    height: 900,
    sizeBytes: 4096,
    source: 'camera',
    mimeType: 'image/jpeg',
    originalName: null,
    durationMs: null,
  };
}

const ID_A = 'a'.repeat(32);
const ID_B = 'b'.repeat(32);

describe('PhotoEntry record', () => {
  it('round-trips through JSON', () => {
    const original = { ...entry(ID_A), originalName: 'holiday.jpg', source: 'import' as const };
    expect(photoEntryFromJson(photoEntryToJson(original))).toEqual(original);
  });

  it('writes timestamps as ISO-8601 UTC', () => {
    expect(photoEntryToJson(entry(ID_A)).createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('falls back rather than trusting a foreign source value', () => {
    const json = { ...photoEntryToJson(entry(ID_A)), source: 'exfiltrate' };
    expect(photoEntryFromJson(json).source).toBe('import');
  });

  it.each([
    ['a missing id', { createdAt: '2026-01-01T00:00:00.000Z', width: 1, height: 1, sizeBytes: 1 }],
    ['a negative size', { ...photoEntryToJson(entry(ID_A)), sizeBytes: -1 }],
    ['a non-numeric width', { ...photoEntryToJson(entry(ID_A)), width: 'wide' }],
    ['a broken timestamp', { ...photoEntryToJson(entry(ID_A)), createdAt: 'yesterday' }],
    ['not an object', 'nope'],
  ])('rejects %s', (_label, json) => {
    expect(() => photoEntryFromJson(json)).toThrow();
  });

  it('computes an aspect ratio without dividing by zero', () => {
    expect(aspectRatio(entry(ID_A))).toBeCloseTo(1200 / 900);
    expect(aspectRatio({ ...entry(ID_A), height: 0 })).toBe(1);
  });
});

describe('VaultIndex', () => {
  it('adds newest first and finds by id', () => {
    const index = withPhoto(withPhoto(EMPTY_INDEX, entry(ID_A)), entry(ID_B));
    expect(index.photos.map((p) => p.id)).toEqual([ID_B, ID_A]);
    expect(findById(index, ID_A)?.id).toBe(ID_A);
    expect(findById(index, 'c'.repeat(32))).toBeNull();
  });

  it('removes a set of ids and leaves the rest untouched', () => {
    const index = withPhoto(withPhoto(EMPTY_INDEX, entry(ID_A)), entry(ID_B));
    expect(withoutPhotos(index, new Set([ID_B])).photos.map((p) => p.id)).toEqual([ID_A]);
    expect(withoutPhotos(index, new Set()).photos).toHaveLength(2);
  });

  it('round-trips through JSON', () => {
    const index = withPhoto(EMPTY_INDEX, entry(ID_A));
    expect(decodeIndex(encodeIndex(index))).toEqual(index);
    expect(decodeIndex(encodeIndex(EMPTY_INDEX))).toEqual(EMPTY_INDEX);
  });

  it.each([
    ['broken JSON', '{not json'],
    ['a future version', '{"version":2,"photos":[]}'],
    ['photos that are not a list', '{"version":1,"photos":"none"}'],
    ['an unusable entry', '{"version":1,"photos":[{"id":1}]}'],
  ])('rejects %s rather than silently starting empty', (_label, raw) => {
    expect(() => decodeIndex(raw)).toThrow(RecordFormatError);
  });

  it('sorts newest first', () => {
    const older = entry(ID_A, Date.UTC(2026, 0, 1));
    const newer = entry(ID_B, Date.UTC(2026, 5, 1));
    expect(sortedNewestFirst([older, newer]).map((p) => p.id)).toEqual([ID_B, ID_A]);
  });
});

describe('VaultPaths', () => {
  const paths = new VaultPaths('file:///documents');

  it('keeps everything inside a single vault directory', () => {
    expect(paths.root).toBe('file:///documents/vault');
    expect(paths.index).toBe('file:///documents/vault/index.enc');
    expect(paths.photoFile(ID_A)).toBe(`file:///documents/vault/photos/${ID_A}.enc`);
    expect(paths.thumbFile(ID_A)).toBe(`file:///documents/vault/thumbs/${ID_A}.enc`);
  });

  it.each([
    ['a traversal attempt', '../../etc/passwd'],
    ['a slash', 'aaaa/bbbb'],
    ['non-hex characters', 'ZZZZZZZZZZZZZZZZ'],
    ['an empty id', ''],
    ['a too-short id', 'abc'],
  ])('refuses %s as a photo id', (_label, id) => {
    expect(() => assertPhotoId(id)).toThrow(InvalidPhotoIdError);
    expect(() => paths.photoFile(id)).toThrow(InvalidPhotoIdError);
  });
});

describe('DecryptedImageCache', () => {
  const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);

  it('returns what was stored and reports its size', () => {
    const cache = new DecryptedImageCache(1000);
    cache.put('a', bytes(100));
    expect(cache.get('a')).toHaveLength(100);
    expect(cache.sizeBytes).toBe(100);
    expect(cache.get('missing')).toBeNull();
  });

  it('evicts least-recently-used entries to stay inside the budget', () => {
    const cache = new DecryptedImageCache(250);
    cache.put('a', bytes(100));
    cache.put('b', bytes(100));
    cache.get('a'); // 'a' becomes most recent, so 'b' should go first
    cache.put('c', bytes(100));

    expect(cache.get('b')).toBeNull();
    expect(cache.get('a')).not.toBeNull();
    expect(cache.get('c')).not.toBeNull();
    expect(cache.sizeBytes).toBeLessThanOrEqual(250);
  });

  it('ignores a single value larger than the whole budget', () => {
    const cache = new DecryptedImageCache(100);
    cache.put('huge', bytes(500));
    expect(cache.get('huge')).toBeNull();
    expect(cache.sizeBytes).toBe(0);
  });

  it('zeroes a buffer that is removed because its photo was deleted', () => {
    const cache = new DecryptedImageCache(1000);
    const value = bytes(32, 7);
    cache.put('a', value);

    cache.remove('a');

    expect(toHex(value)).toBe('00'.repeat(32));
    expect(cache.get('a')).toBeNull();
  });

  it('zeroes everything on clear, which is what lock does', () => {
    const cache = new DecryptedImageCache(1000);
    const a = bytes(16, 9);
    const b = bytes(16, 9);
    cache.put('a', a);
    cache.put('b', b);

    cache.clear();

    expect(toHex(a)).toBe('00'.repeat(16));
    expect(toHex(b)).toBe('00'.repeat(16));
    expect(cache.size).toBe(0);
    expect(cache.sizeBytes).toBe(0);
  });

  it('does NOT zero a buffer merely evicted for space, which a view may still be drawing', () => {
    const cache = new DecryptedImageCache(100);
    const first = bytes(100, 3);
    cache.put('a', first);
    cache.put('b', bytes(100, 4));

    expect(cache.get('a')).toBeNull();
    expect(toHex(first)).toBe('03'.repeat(100));
  });

  it('replaces a value under the same id without double-counting bytes', () => {
    const cache = new DecryptedImageCache(1000);
    cache.put('a', bytes(100));
    cache.put('a', bytes(50));
    expect(cache.sizeBytes).toBe(50);
    expect(cache.size).toBe(1);
  });
});
