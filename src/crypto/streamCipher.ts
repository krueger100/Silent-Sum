/**
 * The chunked SSV1 container (format version 2), used for payloads the JS heap cannot hold.
 *
 * A vault video is routinely tens or hundreds of megabytes. `Ssv1FileCipher` would need the whole
 * plaintext AND the whole ciphertext resident at once, which is an out-of-memory crash on a phone
 * long before the recording is unusual. This cipher walks the file a chunk at a time: encrypting a
 * 400 MB video costs one chunk of plaintext and one chunk of ciphertext, whatever the length.
 *
 * It is the same primitive, the same sub-keys and the same library as every other byte the vault
 * writes -- XChaCha20-Poly1305 from libsodium. Nothing here is a new cipher or a weaker one. What
 * the format adds is the bookkeeping that makes a *sequence* of AEAD messages as safe as one:
 *
 *  - **Nonce uniqueness.** One random 24-byte base nonce is drawn per blob and stored in the
 *    header. A chunk's nonce is that base with its trailing 8 bytes XORed against the chunk index,
 *    so within a blob no two chunks share a nonce, and across blobs the random base makes a
 *    collision as unlikely as it is for the single-shot container.
 *  - **Order, completeness and identity.** Every chunk binds `header|index|M` (or `|F` for the
 *    final chunk) as associated data. Swapping two chunks, dropping one, replaying one from
 *    another blob, or cutting the file short all change some chunk's associated data and fail
 *    authentication. The header inside that string carries the key id, so a video blob cannot be
 *    presented as a photo, and the chunk size, so it cannot be re-split.
 *
 * Decryption writes through a temporary file and only renames it into place once the LAST chunk
 * has authenticated, so a truncated or tampered blob can never surface as a short-but-playable
 * video.
 */
import {
  SODIUM_AEAD_TAG_BYTES,
  aeadDecrypt,
  aeadEncrypt,
  aadFromBytes,
  randomBytes,
} from '@/crypto/sodium';
import {
  FileCipherFormatError,
  SSV1,
  SSV2,
  WrongKeyError,
  ssv2ChunkPlainSize,
  vaultKeyIdFromCode,
  vaultKeyIdName,
  type StreamCipher,
  type StreamResult,
  type VaultKeyId,
} from '@/crypto/types';
import { temporaryNameFor } from '@/storage/atomicWrite';
import type { FileSystem, FileWriteHandle } from '@/storage/fileSystem';
import { uriDirname } from '@/storage/fileSystem';
import { zeroBytes, type Bytes } from '@/utils/bytes';

function header(id: VaultKeyId, exponent: number): Bytes {
  const out = new Uint8Array(SSV2.headerLength);
  out.set(SSV1.magic, 0);
  out[4] = SSV2.version;
  out[5] = id;
  out[6] = exponent;
  return out;
}

/** header(7) || nonce(24). Validated without touching any key material. */
export function parseStreamHeader(prefix: Bytes): {
  keyId: VaultKeyId;
  exponent: number;
  nonce: Bytes;
} {
  if (prefix.length < SSV2.prefixLength) throw new FileCipherFormatError('blob too short');
  for (let i = 0; i < SSV1.magic.length; i++) {
    if (prefix[i] !== SSV1.magic[i]) throw new FileCipherFormatError('bad magic');
  }
  if (prefix[4] !== SSV2.version) {
    throw new FileCipherFormatError(`unsupported stream version ${String(prefix[4])}`);
  }
  const keyId = vaultKeyIdFromCode(prefix[5] ?? -1);
  if (keyId === null) throw new FileCipherFormatError(`unknown key id ${String(prefix[5])}`);
  const exponent = prefix[6] ?? -1;
  if (exponent < SSV2.minChunkExponent || exponent > SSV2.maxChunkExponent) {
    throw new FileCipherFormatError(`unsupported chunk size ${String(exponent)}`);
  }
  return {
    keyId,
    exponent,
    nonce: prefix.subarray(SSV2.headerLength, SSV2.prefixLength),
  };
}

/** base nonce with its trailing 8 bytes XORed by the chunk index. Never repeats within a blob. */
function nonceFor(base: Bytes, index: number): Bytes {
  const nonce = Uint8Array.from(base);
  // Split so the counter stays exact past 2^32 chunks, which no file will reach but the format
  // should not quietly depend on.
  const high = Math.floor(index / 0x100000000) >>> 0;
  const low = index >>> 0;
  for (let i = 0; i < 4; i++) {
    nonce[16 + i] = (nonce[16 + i] ?? 0) ^ ((high >>> (8 * (3 - i))) & 0xff);
    nonce[20 + i] = (nonce[20 + i] ?? 0) ^ ((low >>> (8 * (3 - i))) & 0xff);
  }
  return nonce;
}

/** `SSV1<v><id><e>|<index>|M` -- pure ASCII, so the native and pure-JS bindings bind the same bytes. */
function chunkAad(head: Bytes, index: number, final: boolean): string {
  return `${aadFromBytes(head)}|${String(index)}|${final ? 'F' : 'M'}`;
}

/**
 * How many chunks a blob of `cipherBytes` holds. Derived rather than stored: the count follows
 * from the length, and a file cut short therefore shifts which chunk claims to be final, which the
 * associated data then rejects.
 */
function chunkCount(cipherBytes: number, chunkPlain: number): number {
  const body = cipherBytes - SSV2.prefixLength;
  const chunkCipher = chunkPlain + SODIUM_AEAD_TAG_BYTES;
  if (body <= 0) throw new FileCipherFormatError('blob has no chunks');
  const full = Math.floor(body / chunkCipher);
  const rest = body - full * chunkCipher;
  if (rest === 0) return full;
  if (rest < SODIUM_AEAD_TAG_BYTES) throw new FileCipherFormatError('trailing partial chunk');
  // A tag-only chunk is the empty final chunk of an empty payload, and can only be the first one.
  if (rest === SODIUM_AEAD_TAG_BYTES && full > 0) {
    throw new FileCipherFormatError('trailing partial chunk');
  }
  return full + 1;
}

export interface Ssv2StreamCipherOptions {
  fs: FileSystem;
  /** Plaintext bytes per chunk as a power of two. Tests use a small one; production never sets it. */
  chunkExponent?: number;
}

export class Ssv2StreamCipher implements StreamCipher {
  private readonly fs: FileSystem;
  private readonly exponent: number;

  constructor(options: Ssv2StreamCipherOptions) {
    this.fs = options.fs;
    this.exponent = options.chunkExponent ?? SSV2.defaultChunkExponent;
    if (this.exponent < SSV2.minChunkExponent || this.exponent > SSV2.maxChunkExponent) {
      throw new FileCipherFormatError('chunk exponent out of range');
    }
  }

  async encryptFile(
    sourceUri: string,
    targetUri: string,
    key: Bytes,
    id: VaultKeyId,
  ): Promise<StreamResult> {
    const head = header(id, this.exponent);
    const base = randomBytes(SSV2.nonceLength);
    const chunkPlain = ssv2ChunkPlainSize(this.exponent);

    const reader = await this.fs.openRead(sourceUri);
    let plainBytes = 0;
    let cipherBytes = 0;

    try {
      return await this.throughTemporary(targetUri, async (writer) => {
        await writer.write(head);
        await writer.write(base);
        cipherBytes = SSV2.prefixLength;

        // One chunk is read ahead so the last one can be tagged final without seeking back.
        let current = await reader.read(chunkPlain);
        let index = 0;
        for (;;) {
          const next = current.length < chunkPlain ? new Uint8Array(0) : await reader.read(chunkPlain);
          const final = next.length === 0;
          const combined = aeadEncrypt(current, chunkAad(head, index, final), nonceFor(base, index), key);
          await writer.write(combined);
          plainBytes += current.length;
          cipherBytes += combined.length;
          zeroBytes(current);
          if (final) break;
          current = next;
          index += 1;
        }
        return { plainBytes, cipherBytes };
      });
    } finally {
      await reader.close();
    }
  }

  async decryptFile(
    sourceUri: string,
    targetUri: string,
    key: Bytes,
    id: VaultKeyId,
  ): Promise<StreamResult> {
    return this.throughTemporary(targetUri, async (writer) =>
      this.walk(sourceUri, key, id, async (plain) => {
        await writer.write(plain);
      }),
    );
  }

  async verifyFile(sourceUri: string, key: Bytes, id: VaultKeyId): Promise<StreamResult> {
    return this.walk(sourceUri, key, id, async () => undefined);
  }

  /**
   * Reads and authenticates every chunk in order, handing each plaintext to `consume` and zeroing
   * it immediately afterwards. Any failure -- bad header, wrong key id, a tampered or missing
   * chunk -- throws before `consume` sees the rest of the file.
   */
  private async walk(
    sourceUri: string,
    key: Bytes,
    id: VaultKeyId,
    consume: (plain: Bytes) => Promise<void>,
  ): Promise<StreamResult> {
    const reader = await this.fs.openRead(sourceUri);
    try {
      const prefix = await reader.read(SSV2.prefixLength);
      const { keyId, exponent, nonce } = parseStreamHeader(prefix);
      if (keyId !== id) {
        throw new FileCipherFormatError(
          `blob was encrypted for ${vaultKeyIdName(keyId)}, not ${vaultKeyIdName(id)}`,
        );
      }
      const head = prefix.subarray(0, SSV2.headerLength);
      const chunkPlain = ssv2ChunkPlainSize(exponent);
      const chunkCipher = chunkPlain + SODIUM_AEAD_TAG_BYTES;
      const total = chunkCount(reader.size, chunkPlain);

      let plainBytes = 0;
      for (let index = 0; index < total; index++) {
        const combined = await reader.read(chunkCipher);
        if (combined.length <= SODIUM_AEAD_TAG_BYTES) {
          throw new FileCipherFormatError('blob ended mid-chunk');
        }
        let plain: Bytes;
        try {
          plain = aeadDecrypt(
            combined,
            chunkAad(head, index, index === total - 1),
            nonceFor(nonce, index),
            key,
          );
        } catch {
          throw new WrongKeyError();
        }
        try {
          await consume(plain);
          plainBytes += plain.length;
        } finally {
          zeroBytes(plain);
        }
      }
      return { plainBytes, cipherBytes: reader.size };
    } finally {
      await reader.close();
    }
  }

  /**
   * Writes through a neighbouring temp file and renames only on success, so a failure part-way
   * through leaves no half-written blob and no partially decrypted video anywhere on disk.
   */
  private async throughTemporary(
    targetUri: string,
    body: (writer: FileWriteHandle) => Promise<StreamResult>,
  ): Promise<StreamResult> {
    await this.fs.makeDirectory(uriDirname(targetUri));
    const temporaryUri = temporaryNameFor(targetUri);
    const writer = await this.fs.openWrite(temporaryUri);
    let closed = false;
    try {
      const result = await body(writer);
      await writer.close();
      closed = true;
      await this.fs.move(temporaryUri, targetUri);
      return result;
    } catch (error) {
      if (!closed) await writer.close().catch(() => undefined);
      await this.fs.deleteFile(temporaryUri).catch(() => undefined);
      throw error;
    }
  }
}
