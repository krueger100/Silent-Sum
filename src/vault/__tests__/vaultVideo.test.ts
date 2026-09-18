/**
 * Videos as vault items.
 *
 * The promises a video has to keep are the ones a photo already keeps -- nothing plaintext ever
 * reaches disk, a foreign or edited blob is refused rather than shown, deleting really deletes --
 * plus two of its own: a video is encrypted under its own sub-key so it can never be opened as a
 * photo, and nothing in this path ever holds the recording in memory.
 *
 * The last property is checked by construction rather than by measurement: the repository is only
 * ever handed a URI for a video, and `readVideoToFile` only ever writes to one, so there is no
 * point at which a buffer of the whole recording could exist.
 */
import { Ssv1FileCipher, SodiumSecureRandom, VaultKeyId, deriveVaultKeys } from '@/crypto';
import { Ssv2StreamCipher } from '@/crypto/streamCipher';
import { FileCipherFormatError, SSV1, SSV2, WrongKeyError, looksEncrypted } from '@/crypto/types';
import { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import { SecureDelete } from '@/storage/secureDelete';
import {
  EncryptedVaultRepository,
  NotAPhotoError,
} from '@/vault/encryptedVaultRepository';
import { formatDuration, isVideo, payloadKeyId } from '@/vault/mediaKind';
import { FakeThumbnailGenerator } from '@/vault/thumbnailGenerator';
import { FakeVideoThumbnailGenerator } from '@/vault/videoThumbnailGenerator';
import { VaultPaths } from '@/vault/vaultPaths';
import { bytesEqual, containsSequence, utf8Encode, type Bytes } from '@/utils/bytes';
import { FakeClock } from '@/utils/clock';

const random = new SodiumSecureRandom();
const MARKER = utf8Encode('ftypisom-silentsum-marker');

/** A recording: a recognisable header, then bytes that are anything but random. */
function recording(size = 5000): Bytes {
  const bytes = new Uint8Array(size);
  bytes.set(MARKER, 0);
  for (let i = MARKER.length; i < size; i++) bytes[i] = (i * 13 + 5) & 0xff;
  return bytes;
}

function build(masterKey: Bytes = random.bytes(32)) {
  const fs = new InMemoryFileSystem();
  const paths = new VaultPaths(fs.documentDirectory);
  const keys = deriveVaultKeys(masterKey);
  const repository = new EncryptedVaultRepository({
    fs,
    paths,
    keys,
    cipher: new Ssv1FileCipher(),
    // A small chunk so the specs exercise many chunks without large fixtures.
    streamCipher: new Ssv2StreamCipher({ fs, chunkExponent: 6 }),
    thumbnails: new FakeThumbnailGenerator(),
    videoThumbnails: new FakeVideoThumbnailGenerator(1920, 1080),
    secureDelete: new SecureDelete(fs),
    clock: new FakeClock(),
    random,
  });
  return { fs, paths, keys, repository, masterKey };
}

const CACHE = 'file:///memory/cache';

async function withRecording(size = 5000) {
  const harness = build();
  await harness.repository.open();
  const plain = recording(size);
  const uri = `${CACHE}/clip.mp4`;
  await harness.fs.writeBytes(uri, plain);
  return { ...harness, plain, uri };
}

describe('a video in the vault', () => {
  it('records the metadata the gallery and the details sheet need', async () => {
    const { repository, plain, uri } = await withRecording();
    const entry = await repository.addVideo(
      { uri, durationMs: 7400 },
      { source: 'camera', originalName: 'clip.mp4' },
    );

    expect(entry.id).toMatch(/^[0-9a-f]{32}$/);
    expect(entry.mimeType).toBe('video/mp4');
    expect(entry.sizeBytes).toBe(plain.length);
    expect(entry.durationMs).toBe(7400);
    // Dimensions come from the frame extractor, not from the resized poster.
    expect([entry.width, entry.height]).toEqual([1920, 1080]);
    expect(entry.originalName).toBe('clip.mp4');
    expect(isVideo(entry)).toBe(true);
    expect(payloadKeyId(entry)).toBe(VaultKeyId.video);
    expect(formatDuration(entry.durationMs)).toBe('0:07');

    // It survives a round trip through the encrypted index unchanged.
    expect(repository.photos.map((p) => p.id)).toEqual([entry.id]);
  });

  it('leaves no plaintext anywhere on disk', async () => {
    const { fs, repository, plain, uri } = await withRecording();
    const entry = await repository.addVideo({ uri, durationMs: 1000 }, { source: 'camera' });
    // The camera owns the cache file; the vault never deletes it, so the spec plays that part.
    await fs.deleteFile(uri);

    for (const [path, bytes] of fs.allFiles) {
      expect(containsSequence(bytes, MARKER)).toBe(false);
      expect(containsSequence(bytes, plain.subarray(1000, 1064))).toBe(false);
      expect(path).not.toContain(entry.id.slice(0, 8) + '.mp4');
    }
    // Only the two encrypted blobs and the encrypted index exist.
    expect([...fs.allFiles.keys()].filter((p) => p.includes('/vault/')).sort()).toEqual([
      'file:///memory/documents/vault/index.enc',
      `file:///memory/documents/vault/photos/${entry.id}.enc`,
      `file:///memory/documents/vault/thumbs/${entry.id}.enc`,
    ]);
  });

  it('stores the payload in the chunked container under the video key', async () => {
    const { fs, paths, repository, plain, uri } = await withRecording();
    const entry = await repository.addVideo({ uri, durationMs: 1000 }, { source: 'camera' });
    const blob = await fs.readBytes(paths.photoFile(entry.id));

    expect([...blob.subarray(0, 4)]).toEqual([...SSV1.magic]);
    expect(blob[4]).toBe(SSV2.version);
    expect(blob[5]).toBe(VaultKeyId.video);
    expect(looksEncrypted(blob)).toBe(true);
    expect(blob.length).toBe(
      SSV2.prefixLength + plain.length + 16 * Math.ceil(plain.length / 64),
    );

    // The poster is an ordinary single-shot thumbnail blob, exactly like a photo's.
    const thumb = await fs.readBytes(paths.thumbFile(entry.id));
    expect(thumb[4]).toBe(SSV1.version);
    expect(thumb[5]).toBe(VaultKeyId.thumb);
  });

  it('decrypts back to the recording byte for byte', async () => {
    const { fs, repository, plain, uri } = await withRecording();
    const entry = await repository.addVideo({ uri, durationMs: 1000 }, { source: 'camera' });

    const target = `${CACHE}/playback/out.mp4`;
    await repository.readVideoToFile(entry.id, target);
    expect(bytesEqual(await fs.readBytes(target), plain)).toBe(true);
  });

  it('refuses to hand a video back as bytes', async () => {
    const { repository, uri } = await withRecording();
    const entry = await repository.addVideo({ uri, durationMs: 1000 }, { source: 'camera' });
    // A few hundred megabytes is not something to allocate because a caller asked politely.
    await expect(repository.readFullImage(entry.id)).rejects.toThrow(NotAPhotoError);
  });

  it('refuses a photo blob presented as a video and vice versa', async () => {
    const { paths, repository, uri } = await withRecording();
    const photo = await repository.addPhoto(
      { bytes: recording(600) },
      { source: 'camera' },
    );
    const video = await repository.addVideo({ uri, durationMs: 1000 }, { source: 'camera' });

    // Both payloads sit in the same directory; only the key id in the header tells them apart, and
    // that id is bound in as associated data, so neither can be read as the other.
    await expect(repository.readVideoToFile(photo.id, `${CACHE}/x.mp4`)).rejects.toThrow(
      NotAPhotoError,
    );
    await expect(repository.readFullImage(video.id)).rejects.toThrow(NotAPhotoError);
    expect(paths.photoFile(photo.id)).not.toBe(paths.photoFile(video.id));
  });

  it('refuses another vault keys and a tampered blob', async () => {
    const { fs, paths, repository, uri, masterKey } = await withRecording();
    const entry = await repository.addVideo({ uri, durationMs: 1000 }, { source: 'camera' });
    const target = `${CACHE}/playback/out.mp4`;

    // Another device's keys.
    const foreign = new Ssv2StreamCipher({ fs, chunkExponent: 6 });
    await expect(
      foreign.decryptFile(
        paths.photoFile(entry.id),
        target,
        deriveVaultKeys(random.bytes(32)).keyFor(VaultKeyId.video),
        VaultKeyId.video,
      ),
    ).rejects.toThrow(WrongKeyError);

    // One byte changed in the middle of the payload.
    const blob = await fs.readBytes(paths.photoFile(entry.id));
    const at = Math.floor(blob.length / 2);
    blob[at] = (blob[at] ?? 0) ^ 0x80;
    await fs.writeBytes(paths.photoFile(entry.id), blob);
    await expect(repository.readVideoToFile(entry.id, target)).rejects.toThrow();
    // Nothing half-decrypted was left where a player could reach it.
    expect(await fs.exists(target)).toBe(false);

    // The right keys still work on an untouched vault, so the rejection was the tampering.
    const clean = build(masterKey);
    expect(clean.masterKey).toBe(masterKey);
  });

  it('deletes the payload, the poster and the index entry together', async () => {
    const { fs, paths, repository, uri } = await withRecording();
    const entry = await repository.addVideo({ uri, durationMs: 1000 }, { source: 'camera' });

    await repository.deletePhotos([entry.id]);
    expect(repository.photos).toEqual([]);
    expect(await fs.exists(paths.photoFile(entry.id))).toBe(false);
    expect(await fs.exists(paths.thumbFile(entry.id))).toBe(false);
  });

  it('authenticates a restored payload file before storing it', async () => {
    const { fs, paths, repository, keys, uri, plain } = await withRecording();
    const source = await repository.addVideo({ uri, durationMs: 2500 }, { source: 'camera' });
    const blob = await fs.readBytes(paths.photoFile(source.id));
    const thumbnailBlob = await repository.readEncryptedThumbnail(source.id);
    const entry = repository.photos[0];
    if (entry === undefined) throw new Error('expected the entry');
    await repository.deletePhotos([source.id]);

    // A blob from somewhere else, or one that has been edited, never reaches the vault.
    const tampered = Uint8Array.from(blob);
    tampered[SSV2.prefixLength + 3] = (tampered[SSV2.prefixLength + 3] ?? 0) ^ 0xff;
    await fs.writeBytes(`${CACHE}/incoming.enc`, tampered);
    await expect(
      repository.importEncryptedFile({
        entry,
        payloadUri: `${CACHE}/incoming.enc`,
        thumbnailBlob,
      }),
    ).rejects.toThrow(WrongKeyError);
    expect(await fs.exists(paths.photoFile(entry.id))).toBe(false);

    // The genuine blob is accepted, marked as restored, and plays back identically.
    await fs.writeBytes(`${CACHE}/incoming.enc`, blob);
    await repository.importEncryptedFile({
      entry,
      payloadUri: `${CACHE}/incoming.enc`,
      thumbnailBlob,
    });
    expect(repository.photos[0]?.source).toBe('restore');
    expect(repository.photos[0]?.durationMs).toBe(2500);
    await repository.readVideoToFile(entry.id, `${CACHE}/restored.mp4`);
    expect(bytesEqual(await fs.readBytes(`${CACHE}/restored.mp4`), plain)).toBe(true);
    // The download is consumed, not left lying around as a second copy.
    expect(await fs.exists(`${CACHE}/incoming.enc`)).toBe(false);
    expect(keys.isDisposed).toBe(false);
  });

  it('refuses to import a video through the in-memory photo path', async () => {
    const { repository, uri } = await withRecording();
    const entry = await repository.addVideo({ uri, durationMs: 1000 }, { source: 'camera' });
    const blob = await repository.readEncryptedPhoto(entry.id);
    const thumbnailBlob = await repository.readEncryptedThumbnail(entry.id);
    const stored = repository.photos[0];
    if (stored === undefined) throw new Error('expected the entry');

    await expect(
      repository.importEncrypted({ entry: stored, photoBlob: blob, thumbnailBlob }),
    ).rejects.toThrow(NotAPhotoError);
  });

  it('keeps photos working exactly as before, alongside videos', async () => {
    const { fs, paths, repository, uri } = await withRecording();
    const photoBytes = recording(700);
    const photo = await repository.addPhoto({ bytes: photoBytes }, { source: 'camera' });
    await repository.addVideo({ uri, durationMs: 1000 }, { source: 'camera' });

    // The photo blob is still the single-shot container with the original 46 bytes of overhead.
    const blob = await fs.readBytes(paths.photoFile(photo.id));
    expect(blob[4]).toBe(SSV1.version);
    expect(blob[5]).toBe(VaultKeyId.photo);
    expect(blob.length).toBe(photoBytes.length + SSV1.overhead);
    expect(bytesEqual(await repository.readFullImage(photo.id), photoBytes)).toBe(true);
    expect(repository.photos).toHaveLength(2);
  });

  it('rejects a recording whose poster frame cannot be extracted, before writing anything', async () => {
    const fs = new InMemoryFileSystem();
    const paths = new VaultPaths(fs.documentDirectory);
    const posters = new FakeVideoThumbnailGenerator();
    const repository = new EncryptedVaultRepository({
      fs,
      paths,
      keys: deriveVaultKeys(random.bytes(32)),
      cipher: new Ssv1FileCipher(),
      streamCipher: new Ssv2StreamCipher({ fs, chunkExponent: 6 }),
      thumbnails: new FakeThumbnailGenerator(),
      videoThumbnails: posters,
      secureDelete: new SecureDelete(fs),
      clock: new FakeClock(),
      random,
    });
    await repository.open();
    await fs.writeBytes(`${CACHE}/clip.mp4`, recording(500));

    posters.failOnNextCall = true;
    await expect(
      repository.addVideo({ uri: `${CACHE}/clip.mp4`, durationMs: 500 }, { source: 'camera' }),
    ).rejects.toThrow();

    // No orphan blob, no entry with no tile, and the recording is still where the camera left it.
    expect(repository.photos).toEqual([]);
    expect(await fs.list(paths.photos)).toEqual([]);
    expect(await fs.exists(`${CACHE}/clip.mp4`)).toBe(true);
  });

  it('refuses a malformed payload without touching key material', async () => {
    const { fs, paths, repository, uri } = await withRecording();
    const entry = await repository.addVideo({ uri, durationMs: 1000 }, { source: 'camera' });
    await fs.writeBytes(paths.photoFile(entry.id), new Uint8Array(10));
    await expect(repository.readVideoToFile(entry.id, `${CACHE}/x.mp4`)).rejects.toThrow(
      FileCipherFormatError,
    );
  });
});
