/** CSPRNG-backed randomness (libsodium `randombytes_buf`, i.e. the OS entropy source). */
import { randomBytes } from '@/crypto/sodium';
import type { SecureRandom } from '@/crypto/types';
import { toHex, type Bytes } from '@/utils/bytes';

export class SodiumSecureRandom implements SecureRandom {
  bytes(length: number): Bytes {
    if (!Number.isInteger(length) || length < 0) throw new RangeError('length must be >= 0');
    return randomBytes(length);
  }

  hexId(byteLength = 16): string {
    return toHex(this.bytes(byteLength));
  }
}

/**
 * Deterministic source for tests only. Produces a repeatable byte stream; never used in app code.
 */
export class SequentialRandom implements SecureRandom {
  private counter: number;

  constructor(seed = 1) {
    this.counter = seed;
  }

  bytes(length: number): Bytes {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      this.counter = (this.counter * 1103515245 + 12345) & 0x7fffffff;
      out[i] = (this.counter >>> 16) & 0xff;
    }
    return out;
  }

  hexId(byteLength = 16): string {
    return toHex(this.bytes(byteLength));
  }
}
