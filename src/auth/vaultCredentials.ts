/**
 * What is persisted about the PIN: the public parameters needed to re-derive the key-encryption
 * key, the master key wrapped under it, and - because the vault now opens on a SUBSTRING of the
 * PIN - the PIN itself.
 *
 * JSON: {"v":1,"salt":b64,"kdf":{...},"wrapped":{...},"pinLength":n,"pin":"…","createdAt":iso8601}
 *
 * Storing the PIN is forced by the unlock rule: a substring cannot derive the key-encryption key,
 * so the only way to recognise one is to hold the PIN and compare against it. The record lives in
 * the platform secure store (Android Keystore / iOS Keychain), the same protection the wrapped
 * key has always had, but an attacker who can read that store now learns the PIN outright instead
 * of having to spend one Argon2id derivation per guess. docs/security.md says so plainly.
 *
 * `pinLength` stays in the clear for the setup and change-PIN screens; it is already public from
 * the policy.
 */
import { PIN_POLICY, type VaultCredentials } from '@/auth/types';
import { validatePin } from '@/auth/pinPolicy';
import { kdfParamsFromJson, kdfParamsToJson } from '@/crypto/kdfParams';
import { wrappedKeyFromJson, wrappedKeyToJson } from '@/crypto/keyWrapping';
import { RecordFormatError } from '@/crypto/types';
import { base64Decode, base64Encode, Base64Error } from '@/utils/base64';
import { parseIso8601, toIso8601Utc } from '@/utils/iso8601';

export const SALT_LENGTH = 16;
const MIN_SALT_LENGTH = 8;
const MAX_SALT_LENGTH = 64;

export function credentialsToJson(credentials: VaultCredentials): Record<string, unknown> {
  return {
    v: credentials.version,
    salt: base64Encode(credentials.salt),
    kdf: kdfParamsToJson(credentials.kdf),
    wrapped: wrappedKeyToJson(credentials.wrappedMasterKey),
    pinLength: credentials.pinLength,
    ...(credentials.pin === null ? {} : { pin: credentials.pin }),
    createdAt: toIso8601Utc(credentials.createdAt),
  };
}

export function credentialsFromJson(value: unknown): VaultCredentials {
  if (typeof value !== 'object' || value === null) {
    throw new RecordFormatError('credentials record is not an object');
  }
  const source = value as Record<string, unknown>;

  const version = source.v === undefined ? 1 : source.v;
  if (version !== 1) throw new RecordFormatError(`unsupported credentials version`);

  if (typeof source.salt !== 'string') throw new RecordFormatError('salt is not a string');
  let salt;
  try {
    salt = base64Decode(source.salt);
  } catch (cause) {
    if (cause instanceof Base64Error) throw new RecordFormatError('salt is not base64');
    throw cause;
  }
  if (salt.length < MIN_SALT_LENGTH || salt.length > MAX_SALT_LENGTH) {
    throw new RecordFormatError('bad salt length');
  }

  const pinLength = source.pinLength;
  if (typeof pinLength !== 'number' || !Number.isInteger(pinLength)) {
    throw new RecordFormatError('pinLength is not an integer');
  }
  if (pinLength < PIN_POLICY.minLength || pinLength > PIN_POLICY.maxLength) {
    throw new RecordFormatError('bad pin length');
  }

  // A record written before the substring rule has no `pin`. That is a vault to upgrade, not a
  // broken record: it still opens by evaluating the whole PIN (see `unlockWithCalculatedDigits`),
  // which is also when the PIN gets written in.
  let pin: string | null = null;
  if (source.pin !== undefined) {
    if (typeof source.pin !== 'string') throw new RecordFormatError('pin is not a string');
    if (validatePin(source.pin) !== null) {
      throw new RecordFormatError('stored pin does not match policy');
    }
    if (source.pin.length !== pinLength) {
      throw new RecordFormatError('pin does not match pinLength');
    }
    pin = source.pin;
  }

  return {
    version: 1,
    salt,
    kdf: kdfParamsFromJson(source.kdf),
    wrappedMasterKey: wrappedKeyFromJson(source.wrapped),
    pinLength,
    pin,
    createdAt: parseIso8601(source.createdAt),
  };
}

export function encodeCredentials(credentials: VaultCredentials): string {
  return JSON.stringify(credentialsToJson(credentials));
}

export function decodeCredentials(raw: string): VaultCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RecordFormatError('credentials record is not valid JSON');
  }
  return credentialsFromJson(parsed);
}
