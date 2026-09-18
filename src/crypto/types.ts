/**
 * Cryptography contracts. Implementations live next to this file; UI code never imports them
 * directly (see docs/ARCHITECTURE.md). All byte-level formats are shared with the Flutter
 * reference implementation (docs/reference/flutter-crypto-storage.md, flutter-authentication.md).
 */
import type { Bytes } from '@/utils/bytes';

// ---------------------------------------------------------------------------------------------
// Argon2id key derivation
// ---------------------------------------------------------------------------------------------

export interface KdfParams {
  /** Memory in KiB (Argon2 block count). */
  readonly memoryKiB: number;
  /** Passes (t). */
  readonly iterations: number;
  /** Lanes (p). libsodium computes p = 1 only; records with p != 1 are rejected at load. */
  readonly parallelism: number;
  /** Output length in bytes; always 32. */
  readonly hashLength: number;
}

/** JSON shape: {"alg":"argon2id","m":<memoryKiB>,"t":<iterations>,"p":<parallelism>,"len":<hashLength>} */
export interface KdfParamsJson {
  alg: 'argon2id';
  m: number;
  t: number;
  p: number;
  len: number;
}

export const KDF_LIMITS = {
  maxMemoryKiB: 256 * 1024,
  maxIterations: 10,
  maxParallelism: 4,
  hashLength: 32,
} as const;

export const KDF_PRESETS = {
  /** Vault PIN wrap (production): 32 MiB, 3 passes, 1 lane. */
  defaults: { memoryKiB: 32 * 1024, iterations: 3, parallelism: 1, hashLength: 32 },
  /** Cloud recovery passphrase: 64 MiB, 3 passes, 1 lane. */
  backup: { memoryKiB: 64 * 1024, iterations: 3, parallelism: 1, hashLength: 32 },
  /** Tests only. Never use in production. */
  forTests: { memoryKiB: 256, iterations: 1, parallelism: 1, hashLength: 32 },
} as const satisfies Record<string, KdfParams>;

export interface KeyDerivation {
  /**
   * Argon2id(secret, salt) with the given params. `secret` and `salt` are not modified;
   * the caller owns zeroing them. Returns exactly `params.hashLength` bytes.
   */
  deriveKey(secret: Bytes, salt: Bytes, params: KdfParams): Promise<Bytes>;
}

// ---------------------------------------------------------------------------------------------
// XChaCha20-Poly1305 key wrapping (detached MAC)
// ---------------------------------------------------------------------------------------------

export interface WrappedKey {
  readonly nonce: Bytes; // 24 bytes
  readonly cipherText: Bytes; // same length as the wrapped key (32 for the master key)
  readonly mac: Bytes; // 16 bytes
}

/** JSON shape: {"nonce":<b64>,"ct":<b64>,"mac":<b64>} (standard base64 with padding). */
export interface WrappedKeyJson {
  nonce: string;
  ct: string;
  mac: string;
}

export const WRAPPED_KEY_LIMITS = {
  nonceLength: 24,
  macLength: 16,
  maxCipherTextLength: 1024,
} as const;

/** Associated-data labels bound into every wrap. */
export const AAD = {
  vault: 'silentsum/vmk/v1',
  backupEnvelope: 'silentsum/backup-envelope/v1',
} as const;

export interface KeyWrapping {
  /** Encrypts `key` under `kek` with a fresh random 24-byte nonce and AAD = utf8(aad). */
  wrap(key: Bytes, kek: Bytes, aad?: string): Promise<WrappedKey>;
  /** Decrypts; throws WrongKeyError on authentication failure. */
  unwrap(wrapped: WrappedKey, kek: Bytes, aad?: string): Promise<Bytes>;
}

// ---------------------------------------------------------------------------------------------
// Vault key hierarchy
// ---------------------------------------------------------------------------------------------

export const MASTER_KEY_LENGTH = 32;

/** Key ids appear as the 6th header byte of every SSV1 blob and select the HKDF sub-key. */
export enum VaultKeyId {
  photo = 1,
  thumb = 2,
  /** The encrypted JSON index (`index.enc`). */
  manifest = 3,
  /** Vault videos. A separate sub-key, so a video blob can never be opened as a photo. */
  video = 4,
}

export const VAULT_KEY_INFO: Readonly<Record<VaultKeyId, string>> = {
  [VaultKeyId.photo]: 'silentsum/photo/v1',
  [VaultKeyId.thumb]: 'silentsum/thumb/v1',
  [VaultKeyId.manifest]: 'silentsum/index/v1',
  [VaultKeyId.video]: 'silentsum/video/v1',
};

export function vaultKeyIdFromCode(code: number): VaultKeyId | null {
  return code >= 1 && code <= 4 ? (code as VaultKeyId) : null;
}

export type VaultKeyIdName = 'photo' | 'thumb' | 'manifest' | 'video';

const KEY_ID_NAMES: Readonly<Record<VaultKeyId, VaultKeyIdName>> = {
  [VaultKeyId.photo]: 'photo',
  [VaultKeyId.thumb]: 'thumb',
  [VaultKeyId.manifest]: 'manifest',
  [VaultKeyId.video]: 'video',
};

export function vaultKeyIdName(id: VaultKeyId): VaultKeyIdName {
  return KEY_ID_NAMES[id];
}

/**
 * The in-memory key set of an unlocked session. Sub-keys are HKDF-SHA256(master, salt = empty,
 * info = VAULT_KEY_INFO[id], L = 32). Accessors return the live buffers (no copies) and throw
 * KeysDisposedError after dispose(). dispose() zeroes every buffer and is idempotent.
 */
export interface VaultKeys {
  readonly isDisposed: boolean;
  readonly masterKey: Bytes;
  keyFor(id: VaultKeyId): Bytes;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// SSV1 blob container
// ---------------------------------------------------------------------------------------------

export const SSV1 = {
  magic: Uint8Array.of(0x53, 0x53, 0x56, 0x31), // "SSV1"
  version: 1,
  headerLength: 6,
  nonceLength: 24,
  macLength: 16,
  overhead: 46,
} as const;

/**
 * The chunked variant of the same container, for payloads too large to hold in JS memory.
 *
 *   offset 0   4  magic "SSV1"           (identical, so every "is this ciphertext" check still works)
 *   offset 4   1  format version (2)
 *   offset 5   1  key id
 *   offset 6   1  chunk size exponent e; one plaintext chunk is 1 << e bytes
 *   offset 7   24 base nonce, fresh random per blob
 *   offset 31  n  chunks, each 16 bytes longer than its plaintext
 *
 * Every chunk is an independent XChaCha20-Poly1305 message -- the SAME primitive and the same
 * sub-keys as the single-shot container above, not a new cipher. Two things make the sequence as
 * safe as one big message:
 *
 *  - Nonces cannot repeat. The 24-byte base nonce is random per blob and the trailing 8 bytes are
 *    XORed with the chunk index, so no two chunks anywhere share a nonce.
 *  - Chunks cannot be reordered, dropped, duplicated or truncated. Each chunk's associated data
 *    carries the whole header, the chunk's index and whether it is the last one, so moving or
 *    removing a chunk (including cutting the file short) fails authentication instead of
 *    decrypting to a shorter video.
 */
export const SSV2 = {
  version: 2,
  headerLength: 7,
  nonceLength: 24,
  macLength: 16,
  /** header + nonce, before any chunk. */
  prefixLength: 31,
  /** 1 MiB of plaintext per chunk: 64 chunks for a 64 MB video, 16 bytes of overhead each. */
  defaultChunkExponent: 20,
  minChunkExponent: 6,
  maxChunkExponent: 26,
} as const;

export function ssv2ChunkPlainSize(exponent: number): number {
  return 1 << exponent;
}

export interface FileCipher {
  /** header(6) || nonce(24) || ciphertext || tag(16); AAD = header. */
  encrypt(plain: Bytes, key: Bytes, id: VaultKeyId): Promise<Bytes>;
  /**
   * Throws FileCipherFormatError for malformed headers or a key id other than `id`
   * (checked before any key material is touched) and WrongKeyError on authentication failure.
   */
  decrypt(blob: Bytes, key: Bytes, id: VaultKeyId): Promise<Bytes>;
}

/** Magic matches and the version is one this build writes. Does NOT validate the key id byte. */
export function looksEncrypted(bytes: Bytes): boolean {
  if (bytes.length < SSV2.prefixLength) return false;
  for (let i = 0; i < 4; i++) if (bytes[i] !== SSV1.magic[i]) return false;
  if (bytes[4] === SSV2.version) return true;
  return bytes[4] === SSV1.version && bytes.length >= SSV1.overhead;
}

/**
 * The chunked container, encrypting and decrypting file to file.
 *
 * Neither direction ever holds more than one chunk of plaintext, which is what lets a video of any
 * length go into the vault on a phone. `verify` authenticates a blob without keeping any plaintext
 * at all, so a restored blob can be checked before it is written into the vault.
 */
export interface StreamCipher {
  encryptFile(sourceUri: string, targetUri: string, key: Bytes, id: VaultKeyId): Promise<StreamResult>;
  decryptFile(sourceUri: string, targetUri: string, key: Bytes, id: VaultKeyId): Promise<StreamResult>;
  /** Throws exactly like `decryptFile`, but writes nothing. Returns the plaintext length. */
  verifyFile(sourceUri: string, key: Bytes, id: VaultKeyId): Promise<StreamResult>;
}

export interface StreamResult {
  readonly plainBytes: number;
  readonly cipherBytes: number;
}

// ---------------------------------------------------------------------------------------------
// Randomness
// ---------------------------------------------------------------------------------------------

export interface SecureRandom {
  bytes(length: number): Bytes;
  /** Lower-case hex of `byteLength` random bytes (default 16 -> 32 hex chars). */
  hexId(byteLength?: number): string;
}

// ---------------------------------------------------------------------------------------------
// Errors (all detail-free so they can be logged safely)
// ---------------------------------------------------------------------------------------------

export class WrongKeyError extends Error {
  constructor() {
    super('WrongKeyError');
    this.name = 'WrongKeyError';
  }
}

export class FileCipherFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileCipherFormatError';
  }
}

export class KeysDisposedError extends Error {
  constructor() {
    super('VaultKeys used after dispose');
    this.name = 'KeysDisposedError';
  }
}

/** Thrown when a persisted record (credentials, envelope, wrapped key, kdf params) is malformed. */
export class RecordFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordFormatError';
  }
}
