/**
 * Argon2id key derivation over the libsodium binding.
 *
 * Cost is a deliberate, load-bearing part of the design: it is what makes a stolen credential
 * record expensive to attack, since the wrapped key is the only PIN verifier.
 */
import { argon2id } from '@/crypto/sodium';
import type { KeyDerivation, KdfParams } from '@/crypto/types';
import type { Bytes } from '@/utils/bytes';

/**
 * libsodium computes Argon2id with a single lane. A record asking for more is not something we
 * can honour, and silently deriving with p = 1 would produce a different key, so it fails loudly.
 */
export class UnsupportedKdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedKdfError';
  }
}

export class Argon2idKeyDerivation implements KeyDerivation {
  async deriveKey(secret: Bytes, salt: Bytes, params: KdfParams): Promise<Bytes> {
    if (params.parallelism !== 1) {
      throw new UnsupportedKdfError(
        `Argon2id parallelism ${params.parallelism} is not supported (libsodium computes one lane)`,
      );
    }
    // Yield once so a caller that just rendered a progress indicator gets its frame out before
    // the synchronous JSI call blocks the thread for a few hundred milliseconds.
    await Promise.resolve();
    return argon2id(secret, salt, params.memoryKiB, params.iterations, params.hashLength);
  }
}
