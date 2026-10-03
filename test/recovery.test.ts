/**
 * TEMPORARY recovery tool (2026-09-18 restore investigation) -- delete when done.
 *
 * Reads an envelope document and encrypted blobs that were downloaded from Cloud Storage, unwraps
 * the master key with the recovery passphrase, and reports what that key can read. Nothing here
 * touches the network: it only reads files under RECOVERY_DIR.
 *
 *   RECOVERY_PASSPHRASE=... RECOVERY_DIR=... npx jest test/recovery.test.ts
 *
 * Blobs are named `photos__<id>.enc` / `thumbs__<id>.enc`, matching their Cloud Storage paths. The
 * container header says what each one is -- magic "SSV1" for whole-file blobs, SSV2 for streamed
 * video, and byte 5 carries the key id -- so photo and video are told apart from the ciphertext
 * itself, without needing `index.enc`. With RECOVERY_DECRYPT=1 the plaintext is written alongside.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { envelopeFromJson } from '@/backup/backupEnvelope';
import {
  AAD,
  Argon2idKeyDerivation,
  deriveVaultKeys,
  SodiumKeyWrapping,
  Ssv1FileCipher,
  Ssv2StreamCipher,
  SSV1,
  SSV2,
  VaultKeyId,
  vaultKeyIdFromCode,
  vaultKeyIdName,
} from '@/crypto';
import { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import { BackupService } from '@/backup/backupService';
import { VaultOwnerStore } from '@/backup/vaultOwner';
import { InMemorySecureStore } from '@/secure-storage/secureStore';
import { BACKUP_PATHS } from '@/backup/types';
import { KDF_PRESETS, SodiumSecureRandom } from '@/crypto';
import { InMemoryCloudBackend } from '@/firebase/cloudBackend';
import { SecureDelete } from '@/storage/secureDelete';
import { FakeClock } from '@/utils/clock';
import { EncryptedVaultRepository } from '@/vault/encryptedVaultRepository';
import { FakeThumbnailGenerator } from '@/vault/thumbnailGenerator';
import { FakeVideoThumbnailGenerator } from '@/vault/videoThumbnailGenerator';
import { VaultPaths } from '@/vault/vaultPaths';
import { decodeIndex } from '@/vault/vaultIndex';
import { utf8Decode, utf8Encode } from '@/utils/bytes';
import type { Bytes } from '@/utils/bytes';

const DIR = process.env.RECOVERY_DIR ?? '';
const PASSPHRASE = process.env.RECOVERY_PASSPHRASE ?? '';

const describeOrSkip = DIR !== '' && PASSPHRASE !== '' ? describe : describe.skip;

/** What the plaintext turned out to be, read from its own leading bytes. */
function sniff(plain: Bytes): { kind: string; ext: string } {
  const b = plain;
  const at = (i: number): number => b[i] ?? -1;
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return { kind: 'JPEG image', ext: 'jpg' };
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) {
    return { kind: 'PNG image', ext: 'png' };
  }
  if (at(4) === 0x66 && at(5) === 0x74 && at(6) === 0x79 && at(7) === 0x70) {
    const brand = utf8Decode(b.subarray(8, 12));
    return { kind: `MP4/ISO video (${brand})`, ext: 'mp4' };
  }
  if (at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46) {
    return { kind: 'RIFF (avi/webp)', ext: 'bin' };
  }
  if (at(0) === 0x1a && at(1) === 0x45 && at(2) === 0xdf && at(3) === 0xa3) {
    return { kind: 'Matroska/WebM video', ext: 'webm' };
  }
  return { kind: `unknown (${[...b.subarray(0, 4)].map((n) => n.toString(16)).join(' ')})`, ext: 'bin' };
}

/**
 * Reads the container header without any key. Both containers carry the same four-byte magic; the
 * version byte that follows is what says whole-file (1) or streamed video (2), and byte 5 is the
 * sub-key the blob was written for.
 */
function describeContainer(blob: Bytes): { stream: boolean; keyId: VaultKeyId | null } {
  for (let i = 0; i < SSV1.magic.length; i++) {
    if (blob[i] !== SSV1.magic[i]) throw new Error('blob does not carry the vault magic');
  }
  const version = blob[4] ?? -1;
  if (version !== SSV1.version && version !== SSV2.version) {
    throw new Error('unsupported container version ' + String(version));
  }
  return { stream: version === SSV2.version, keyId: vaultKeyIdFromCode(blob[5] ?? -1) };
}

describeOrSkip('cloud backup recovery', () => {
  it('reports what the envelope key can read', async () => {
    const envelope = envelopeFromJson(JSON.parse(readFileSync(join(DIR, 'envelope.json'), 'utf8')));
    const kek = await new Argon2idKeyDerivation().deriveKey(
      utf8Encode(PASSPHRASE),
      envelope.salt,
      envelope.kdf,
    );
    const master = await new SodiumKeyWrapping().unwrap(
      envelope.wrappedMasterKey,
      kek,
      AAD.backupEnvelope,
    );
    console.log('envelope unwrapped: master key is', master.length, 'bytes');

    const keys = deriveVaultKeys(master);
    const cipher = new Ssv1FileCipher();

    const blobs = readdirSync(DIR)
      .map((name) => ({ name, match: /^(photos|thumbs)__([0-9a-f]{32})\.enc$/.exec(name) }))
      .filter((b): b is { name: string; match: RegExpExecArray } => b.match !== null)
      .sort((a, b) => a.name.localeCompare(b.name));

    console.log(`\n${blobs.length} blob(s) to examine\n`);
    const results: string[] = [];

    for (const { name, match } of blobs) {
      const folder = match[1] as 'photos' | 'thumbs';
      const id = match[2] as string;
      const blob = new Uint8Array(readFileSync(join(DIR, name)));
      let line = `${folder}/${id}  ${blob.length}B  `;
      try {
        const { stream, keyId } = describeContainer(blob);
        if (keyId === null) throw new Error('unknown key id in header');
        line += `${stream ? 'SSV2 stream' : 'SSV1 file'} / ${vaultKeyIdName(keyId)}  `;

        let plain: Bytes;
        if (stream) {
          const fs = new InMemoryFileSystem();
          await fs.makeDirectory('/mem');
          await fs.writeBytes('/mem/in.enc', blob);
          const streamCipher = new Ssv2StreamCipher({ fs });
          await streamCipher.decryptFile('/mem/in.enc', '/mem/out.bin', keys.keyFor(keyId), keyId);
          plain = await fs.readBytes('/mem/out.bin');
        } else {
          plain = await cipher.decrypt(blob, keys.keyFor(keyId), keyId);
        }

        const { kind, ext } = sniff(plain);
        line += `OK -> ${plain.length}B ${kind}`;
        if (process.env.RECOVERY_DECRYPT === '1') {
          const out = `${folder}-${id}.${ext}`;
          writeFileSync(join(DIR, out), Buffer.from(plain));
          line += `  [wrote ${out}]`;
        }
      } catch (cause) {
        line += `FAILED: ${(cause as Error).name}: ${(cause as Error).message}`;
      }
      console.log('  ' + line);
      results.push(line);
    }

    const ok = results.filter((r) => r.includes(' OK -> ')).length;
    console.log(`\n${ok}/${results.length} blob(s) decrypted with the envelope key`);

    const indexPath = join(DIR, 'index.enc');
    if (!existsSync(indexPath)) {
      console.log('(no index.enc present -- classification above comes from the blob headers)');
      return;
    }
    const raw = new Uint8Array(readFileSync(indexPath));
    let entries;
    try {
      const json = await cipher.decrypt(raw, keys.keyFor(VaultKeyId.manifest), VaultKeyId.manifest);
      entries = decodeIndex(utf8Decode(json)).photos;
    } catch (cause) {
      console.log('INDEX IS NOT READABLE BY THIS KEY:', (cause as Error).name);
      return;
    }
    console.log(`INDEX READABLE -- ${entries.length} entries:`);
    for (const e of entries) {
      const kind = e.durationMs == null ? 'photo' : `video ${Math.round(e.durationMs / 1000)}s`;
      console.log(
        `  ${e.id}  ${kind}  ${e.width}x${e.height}  ${e.sizeBytes}B  ${e.mimeType}  ` +
          `${new Date(e.createdAt).toISOString()}  ${e.originalName ?? '(no name)'}`,
      );
    }
  }, 300000);
});

/**
 * Control experiment for the tool above. It writes a backup with the real uploader, then reads it
 * back through the exact code path the recovery run uses -- envelope JSON, Argon2id, unwrap,
 * deriveVaultKeys, container sniff, decrypt. If this passes, a `WrongKeyError` on a real blob means
 * the blob genuinely is not under the envelope's key, rather than the tool being wired up wrong.
 */
describe('recovery tool self-check', () => {
  it('reads a backup written by the real uploader', async () => {

    const random = new SodiumSecureRandom();
    const passphrase = 'correct horse battery staple';
    const master = random.bytes(32);

    const fs = new InMemoryFileSystem();
    const keys = deriveVaultKeys(master);
    const repository = new EncryptedVaultRepository({
      fs,
      paths: new VaultPaths(fs.documentDirectory),
      keys,
      cipher: new Ssv1FileCipher(),
      streamCipher: new Ssv2StreamCipher({ fs, chunkExponent: 10 }),
      thumbnails: new FakeThumbnailGenerator(),
      videoThumbnails: new FakeVideoThumbnailGenerator(),
      secureDelete: new SecureDelete(fs),
      clock: new FakeClock(),
      random,
    });
    await repository.open();

    const image = random.bytes(1024);
    image.set(utf8Encode('CONTROL-PIXELS'), 0);
    const entry = await repository.addPhoto({ bytes: image }, { source: 'camera' });

    const backend = new InMemoryCloudBackend();
    await backend.signUp('owner@example.com', 'cloud-account-password');
    const serviceFs = new InMemoryFileSystem();
    const service = new BackupService({
      backend,
      kdf: new Argon2idKeyDerivation(),
      wrapping: new SodiumKeyWrapping(),
      cipher: new Ssv1FileCipher(),
      streamCipher: new Ssv2StreamCipher({ fs: serviceFs, chunkExponent: 10 }),
      clock: new FakeClock(),
      random,
      fs: serviceFs,
      secureDelete: new SecureDelete(serviceFs),
      owner: new VaultOwnerStore(new InMemorySecureStore()),
      kdfParams: KDF_PRESETS.forTests,
    });
    await service.enable(keys, passphrase);
    await service.backupNow(repository, keys);

    const uid = backend.currentUser?.uid ?? '';
    const document = await backend.getDocument(BACKUP_PATHS.envelope(uid));
    const blob = await backend.getBlob(BACKUP_PATHS.photo(uid, entry.id));

    // From here on: byte-for-byte the recovery path, including the JSON round trip through storage.
    const envelope = envelopeFromJson(JSON.parse(JSON.stringify(document)));
    const kek = await new Argon2idKeyDerivation().deriveKey(
      utf8Encode(passphrase),
      envelope.salt,
      envelope.kdf,
    );
    const recovered = await new SodiumKeyWrapping().unwrap(
      envelope.wrappedMasterKey,
      kek,
      AAD.backupEnvelope,
    );
    const recoveredKeys = deriveVaultKeys(recovered);
    const { stream, keyId } = describeContainer(blob);
    expect(stream).toBe(false);
    expect(keyId).toBe(VaultKeyId.photo);
    const plain = await new Ssv1FileCipher().decrypt(
      blob,
      recoveredKeys.keyFor(keyId as VaultKeyId),
      keyId as VaultKeyId,
    );
    expect(Buffer.from(plain).equals(Buffer.from(image))).toBe(true);
    console.log('self-check: recovery path read a real uploader-written blob correctly');
  }, 120000);
});
