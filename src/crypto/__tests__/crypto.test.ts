import {
  AAD,
  Argon2idKeyDerivation,
  FileCipherFormatError,
  KDF_PRESETS,
  KeysDisposedError,
  RecordFormatError,
  SodiumKeyWrapping,
  SodiumSecureRandom,
  Ssv1FileCipher,
  UnsupportedKdfError,
  VaultKeyId,
  WrongKeyError,
  deriveVaultKeys,
  kdfParamsFromJson,
  kdfParamsToJson,
  looksEncrypted,
  wrappedKeyFromJson,
  wrappedKeyToJson,
} from '@/crypto';
import { bytesEqual, containsSequence, toHex, utf8Encode } from '@/utils/bytes';

const kdf = new Argon2idKeyDerivation();
const wrapping = new SodiumKeyWrapping();
const cipher = new Ssv1FileCipher();
const random = new SodiumSecureRandom();

const SALT = new Uint8Array(16).fill(7);

describe('Argon2id', () => {
  it('is deterministic for the same secret, salt and parameters', async () => {
    const a = await kdf.deriveKey(utf8Encode('2468'), SALT, KDF_PRESETS.forTests);
    const b = await kdf.deriveKey(utf8Encode('2468'), SALT, KDF_PRESETS.forTests);
    expect(toHex(a)).toBe(toHex(b));
    expect(a).toHaveLength(32);
  });

  it('changes with the PIN, the salt and the parameters', async () => {
    const base = await kdf.deriveKey(utf8Encode('2468'), SALT, KDF_PRESETS.forTests);
    const otherPin = await kdf.deriveKey(utf8Encode('2469'), SALT, KDF_PRESETS.forTests);
    const otherSalt = await kdf.deriveKey(
      utf8Encode('2468'),
      new Uint8Array(16).fill(8),
      KDF_PRESETS.forTests,
    );
    const otherCost = await kdf.deriveKey(utf8Encode('2468'), SALT, {
      ...KDF_PRESETS.forTests,
      iterations: 2,
    });
    expect(toHex(otherPin)).not.toBe(toHex(base));
    expect(toHex(otherSalt)).not.toBe(toHex(base));
    expect(toHex(otherCost)).not.toBe(toHex(base));
  });

  it('refuses parallelism it cannot honour instead of deriving a different key', async () => {
    await expect(
      kdf.deriveKey(utf8Encode('2468'), SALT, { ...KDF_PRESETS.forTests, parallelism: 2 }),
    ).rejects.toThrow(UnsupportedKdfError);
  });
});

describe('KdfParams record', () => {
  it('round-trips', () => {
    expect(kdfParamsFromJson(kdfParamsToJson(KDF_PRESETS.defaults))).toEqual(KDF_PRESETS.defaults);
    expect(kdfParamsToJson(KDF_PRESETS.defaults)).toEqual({
      alg: 'argon2id',
      m: 32768,
      t: 3,
      p: 1,
      len: 32,
    });
  });

  it.each([
    ['wrong algorithm', { alg: 'scrypt', m: 1024, t: 3, p: 1, len: 32 }],
    ['memory above the cap', { alg: 'argon2id', m: 262145, t: 3, p: 1, len: 32 }],
    ['memory below 8p', { alg: 'argon2id', m: 1, t: 3, p: 1, len: 32 }],
    ['iterations above the cap', { alg: 'argon2id', m: 1024, t: 11, p: 1, len: 32 }],
    ['iterations below 1', { alg: 'argon2id', m: 1024, t: 0, p: 1, len: 32 }],
    ['parallelism above the cap', { alg: 'argon2id', m: 1024, t: 3, p: 5, len: 32 }],
    ['a short output', { alg: 'argon2id', m: 1024, t: 3, p: 1, len: 16 }],
    ['a non-integer', { alg: 'argon2id', m: 1024.5, t: 3, p: 1, len: 32 }],
    ['a missing field', { alg: 'argon2id', t: 3, p: 1, len: 32 }],
  ])('rejects %s', (_label, json) => {
    expect(() => kdfParamsFromJson(json)).toThrow(RecordFormatError);
  });
});

describe('key wrapping', () => {
  it('unwraps with the right key and fails with any other', async () => {
    const master = random.bytes(32);
    const kek = random.bytes(32);
    const wrapped = await wrapping.wrap(master, kek);

    expect(wrapped.nonce).toHaveLength(24);
    expect(wrapped.mac).toHaveLength(16);
    expect(wrapped.cipherText).toHaveLength(32);
    expect(containsSequence(wrapped.cipherText, master)).toBe(false);

    expect(bytesEqual(await wrapping.unwrap(wrapped, kek), master)).toBe(true);
    await expect(wrapping.unwrap(wrapped, random.bytes(32))).rejects.toThrow(WrongKeyError);
  });

  it('binds the associated data, so a vault wrap cannot be read as a backup envelope', async () => {
    const master = random.bytes(32);
    const kek = random.bytes(32);
    const wrapped = await wrapping.wrap(master, kek, AAD.vault);
    await expect(wrapping.unwrap(wrapped, kek, AAD.backupEnvelope)).rejects.toThrow(WrongKeyError);
  });

  it('detects a flipped bit in the ciphertext', async () => {
    const kek = random.bytes(32);
    const wrapped = await wrapping.wrap(random.bytes(32), kek);
    const tampered = { ...wrapped, cipherText: Uint8Array.from(wrapped.cipherText) };
    tampered.cipherText.set([(tampered.cipherText.at(0) ?? 0) ^ 0x01], 0);
    await expect(wrapping.unwrap(tampered, kek)).rejects.toThrow(WrongKeyError);
  });

  it('round-trips through JSON and rejects malformed records', async () => {
    const wrapped = await wrapping.wrap(random.bytes(32), random.bytes(32));
    const json = wrappedKeyToJson(wrapped);
    expect(bytesEqual(wrappedKeyFromJson(json).cipherText, wrapped.cipherText)).toBe(true);

    expect(() => wrappedKeyFromJson({ ...json, nonce: json.mac })).toThrow(RecordFormatError);
    expect(() => wrappedKeyFromJson({ ...json, mac: json.nonce })).toThrow(RecordFormatError);
    expect(() => wrappedKeyFromJson({ ...json, ct: '' })).toThrow(RecordFormatError);
    expect(() => wrappedKeyFromJson({ ...json, ct: '!!!not base64!!!' })).toThrow(RecordFormatError);
    expect(() => wrappedKeyFromJson(null)).toThrow(RecordFormatError);
  });
});

describe('vault keys', () => {
  it('derives three distinct sub-keys that are stable for a master key', () => {
    const master = random.bytes(32);
    const a = deriveVaultKeys(master);
    const b = deriveVaultKeys(master);
    const ids = [VaultKeyId.photo, VaultKeyId.thumb, VaultKeyId.manifest];
    const hex = ids.map((id) => toHex(a.keyFor(id)));

    expect(new Set(hex).size).toBe(3);
    for (const id of ids) expect(toHex(b.keyFor(id))).toBe(toHex(a.keyFor(id)));
    for (const id of ids) expect(toHex(a.keyFor(id))).not.toBe(toHex(master));
  });

  it('copies the master key so the caller can zero its own buffer', () => {
    const master = random.bytes(32);
    const expected = toHex(master);
    const keys = deriveVaultKeys(master);
    master.fill(0);
    expect(toHex(keys.masterKey)).toBe(expected);
  });

  it('zeroes every buffer on dispose and fails closed afterwards', () => {
    const keys = deriveVaultKeys(random.bytes(32));
    const photo = keys.keyFor(VaultKeyId.photo);
    keys.dispose();
    expect(toHex(photo)).toBe('00'.repeat(32));
    expect(() => keys.keyFor(VaultKeyId.photo)).toThrow(KeysDisposedError);
    expect(() => keys.masterKey).toThrow(KeysDisposedError);
    expect(() => keys.dispose()).not.toThrow();
  });
});

describe('SSV1 file cipher', () => {
  const plain = utf8Encode('a photograph, pretend this is JPEG');

  it('round-trips and produces a recognisable container', async () => {
    const key = random.bytes(32);
    const blob = await cipher.encrypt(plain, key, VaultKeyId.photo);

    expect(blob.subarray(0, 4)).toEqual(utf8Encode('SSV1'));
    expect(blob[4]).toBe(1);
    expect(blob[5]).toBe(VaultKeyId.photo);
    expect(blob).toHaveLength(plain.length + 46);
    expect(looksEncrypted(blob)).toBe(true);
    expect(containsSequence(blob, plain)).toBe(false);

    expect(bytesEqual(await cipher.decrypt(blob, key, VaultKeyId.photo), plain)).toBe(true);
  });

  it('uses a fresh nonce for every blob', async () => {
    const key = random.bytes(32);
    const a = await cipher.encrypt(plain, key, VaultKeyId.photo);
    const b = await cipher.encrypt(plain, key, VaultKeyId.photo);
    expect(toHex(a)).not.toBe(toHex(b));
  });

  it('refuses to decrypt a thumbnail blob as a photo', async () => {
    const key = random.bytes(32);
    const blob = await cipher.encrypt(plain, key, VaultKeyId.thumb);
    await expect(cipher.decrypt(blob, key, VaultKeyId.photo)).rejects.toThrow(
      FileCipherFormatError,
    );
  });

  it('rejects a header edited to claim another key id', async () => {
    const key = random.bytes(32);
    const blob = await cipher.encrypt(plain, key, VaultKeyId.photo);
    blob[5] = VaultKeyId.thumb;
    await expect(cipher.decrypt(blob, key, VaultKeyId.thumb)).rejects.toThrow(WrongKeyError);
  });

  it('rejects the wrong key and tampered ciphertext', async () => {
    const blob = await cipher.encrypt(plain, random.bytes(32), VaultKeyId.photo);
    await expect(cipher.decrypt(blob, random.bytes(32), VaultKeyId.photo)).rejects.toThrow(
      WrongKeyError,
    );
    blob.set([(blob.at(40) ?? 0) ^ 0x01], 40);
    await expect(cipher.decrypt(blob, random.bytes(32), VaultKeyId.photo)).rejects.toThrow(
      WrongKeyError,
    );
  });

  it.each([
    ['a truncated blob', new Uint8Array(10)],
    ['bad magic', new Uint8Array(60)],
  ])('rejects %s', async (_label, blob) => {
    await expect(cipher.decrypt(blob, random.bytes(32), VaultKeyId.photo)).rejects.toThrow(
      FileCipherFormatError,
    );
    expect(looksEncrypted(blob)).toBe(false);
  });

  it('handles a payload larger than a megabyte', async () => {
    const key = random.bytes(32);
    const big = random.bytes(1024 * 1024 + 7);
    const blob = await cipher.encrypt(big, key, VaultKeyId.photo);
    expect(bytesEqual(await cipher.decrypt(blob, key, VaultKeyId.photo), big)).toBe(true);
  });
});

describe('secure random', () => {
  it('produces the requested length and does not repeat', () => {
    expect(random.bytes(0)).toHaveLength(0);
    expect(random.bytes(32)).toHaveLength(32);
    expect(toHex(random.bytes(32))).not.toBe(toHex(random.bytes(32)));
    expect(random.hexId()).toMatch(/^[0-9a-f]{32}$/);
    expect(random.hexId(8)).toMatch(/^[0-9a-f]{16}$/);
  });
});
