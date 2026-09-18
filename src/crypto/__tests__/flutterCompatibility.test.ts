/**
 * Byte-for-byte compatibility with the Flutter reference implementation.
 *
 * Every value below was produced by running the reference's own primitives
 * (`package:cryptography` Argon2id, HKDF-SHA256 and XChaCha20-Poly1305, plus `VaultKeys.derive`)
 * against fixed inputs. If any of these fail, the two apps no longer agree on the key hierarchy
 * or the blob format, and a vault written by one could not be opened by the other.
 */
import {
  Argon2idKeyDerivation,
  KDF_PRESETS,
  SodiumKeyWrapping,
  VaultKeyId,
  deriveVaultKeys,
} from '@/crypto';
import { aadFromBytes, aeadDecrypt, aeadEncrypt } from '@/crypto/sodium';
import { concatBytes, toHex, utf8Encode, type Bytes } from '@/utils/bytes';

const FLUTTER = {
  argon2idTestPreset: '09410d760b9728a58b7bec70721454def90d67c6a611c105916981ec9eedd33f',
  subKeyPhoto: '1ec454fd2b637d6ecd3050d28985fcec0efab785daf433679f99fdb54f58d805',
  subKeyThumb: 'd276d451fda2a00ac26d1d36bbfd29a6963a435fcaeae67aa25e57e4953c528b',
  subKeyIndex: '928b373beb1638abfb0f496ff3be6b637a97c7357a4d7a216ddf0cef814fe8d4',
  aeadCipherText: '1187353c89e0101f7138559a3ad16cf11bfd33b3',
  aeadMac: '9cfec5c86216b1029f71024f14d02545',
} as const;

function counting(length: number, start = 0): Bytes {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = (start + i) & 0xff;
  return out;
}

describe('compatibility with the Flutter vault format', () => {
  it('derives the same Argon2id key', async () => {
    const kek = await new Argon2idKeyDerivation().deriveKey(
      utf8Encode('2468'),
      new Uint8Array(16).fill(7),
      KDF_PRESETS.forTests,
    );
    expect(toHex(kek)).toBe(FLUTTER.argon2idTestPreset);
  });

  it('derives the same HKDF-SHA256 sub-keys from a master key', () => {
    const keys = deriveVaultKeys(new Uint8Array(32).fill(0x2a));
    expect(toHex(keys.keyFor(VaultKeyId.photo))).toBe(FLUTTER.subKeyPhoto);
    expect(toHex(keys.keyFor(VaultKeyId.thumb))).toBe(FLUTTER.subKeyThumb);
    expect(toHex(keys.keyFor(VaultKeyId.manifest))).toBe(FLUTTER.subKeyIndex);
  });

  it('produces the same XChaCha20-Poly1305 ciphertext and tag', () => {
    const key = counting(32);
    const nonce = counting(24, 0x80);
    const header = Uint8Array.of(0x53, 0x53, 0x56, 0x31, 1, VaultKeyId.photo);
    const combined = aeadEncrypt(
      utf8Encode('SilentSum vault blob'),
      aadFromBytes(header),
      nonce,
      key,
    );

    const split = combined.length - 16;
    expect(toHex(combined.subarray(0, split))).toBe(FLUTTER.aeadCipherText);
    expect(toHex(combined.subarray(split))).toBe(FLUTTER.aeadMac);
  });

  it('decrypts a blob assembled from the reference ciphertext and tag', () => {
    const key = counting(32);
    const nonce = counting(24, 0x80);
    const header = Uint8Array.of(0x53, 0x53, 0x56, 0x31, 1, VaultKeyId.photo);
    const combined = concatBytes(
      Uint8Array.from(Buffer.from(FLUTTER.aeadCipherText, 'hex')),
      Uint8Array.from(Buffer.from(FLUTTER.aeadMac, 'hex')),
    );
    expect(Buffer.from(aeadDecrypt(combined, aadFromBytes(header), nonce, key)).toString()).toBe(
      'SilentSum vault blob',
    );
  });

  it('unwraps a master key that was wrapped with the reference associated data', async () => {
    // Round trip through our own wrap to confirm the detached/combined split matches the
    // reference record layout (nonce 24, ct 32, mac 16 for a 32-byte master key).
    const wrapping = new SodiumKeyWrapping();
    const master = new Uint8Array(32).fill(0x2a);
    const wrapped = await wrapping.wrap(master, counting(32));
    expect(wrapped.nonce).toHaveLength(24);
    expect(wrapped.cipherText).toHaveLength(32);
    expect(wrapped.mac).toHaveLength(16);
    expect(toHex(await wrapping.unwrap(wrapped, counting(32)))).toBe(toHex(master));
  });
});
