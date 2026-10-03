/**
 * The vault master key wrapped under a key derived from the user's recovery passphrase.
 *
 * This envelope is the only key material that ever leaves the device, and it is useless without
 * the passphrase, which is never uploaded, never stored, and never shown to the server. The PIN is
 * not involved at all: the two secrets are independent on purpose, so a compromised cloud account
 * cannot open the vault and a forgotten PIN does not destroy the backup.
 *
 * Firestore document: {"v":1,"salt":b64,"kdf":{...},"wrapped":{...},"createdAt":iso8601}
 */
import { kdfParamsFromJson, kdfParamsToJson } from '@/crypto/kdfParams';
import { wrappedKeyFromJson, wrappedKeyToJson } from '@/crypto/keyWrapping';
import { RecordFormatError } from '@/crypto/types';
import type { BackupEnvelope } from '@/backup/types';
import { base64Decode, base64Encode, Base64Error } from '@/utils/base64';
import { parseIso8601, toIso8601Utc } from '@/utils/iso8601';

const MIN_SALT_LENGTH = 8;
const MAX_SALT_LENGTH = 64;

export function envelopeToJson(envelope: BackupEnvelope): Record<string, unknown> {
  const document: Record<string, unknown> = {
    v: envelope.version,
    salt: base64Encode(envelope.salt),
    kdf: kdfParamsToJson(envelope.kdf),
    wrapped: wrappedKeyToJson(envelope.wrappedMasterKey),
    createdAt: toIso8601Utc(envelope.createdAt),
  };
  // Omitted rather than written as null, for two reasons: the rules validate the key SET, so an
  // absent field is the only shape an undeployed ruleset will accept, and a null would have to be
  // special-cased by every reader. A document written without it is byte-identical to one written
  // before the field existed.
  if (envelope.vaultId !== null) document.vaultId = envelope.vaultId;
  return document;
}

/**
 * Parses a document that arrived from the network, so every field is treated as hostile until
 * validated. The KDF bounds in particular stop a tampered envelope from asking the device to
 * allocate gigabytes while the user waits on a restore screen.
 */
export function envelopeFromJson(value: unknown): BackupEnvelope {
  if (typeof value !== 'object' || value === null) {
    throw new RecordFormatError('envelope is not an object');
  }
  const source = value as Record<string, unknown>;
  const version = source.v === undefined ? 1 : source.v;
  if (version !== 1) throw new RecordFormatError('unsupported envelope version');

  if (typeof source.salt !== 'string') throw new RecordFormatError('envelope salt is not a string');
  let salt;
  try {
    salt = base64Decode(source.salt);
  } catch (cause) {
    if (cause instanceof Base64Error) throw new RecordFormatError('envelope salt is not base64');
    throw cause;
  }
  if (salt.length < MIN_SALT_LENGTH || salt.length > MAX_SALT_LENGTH) {
    throw new RecordFormatError('bad envelope salt length');
  }

  // Absent, empty or the wrong type all read as "this envelope does not say", which is what every
  // envelope written before this field existed says. It is never treated as a mismatch.
  const vaultId =
    typeof source.vaultId === 'string' && source.vaultId !== '' ? source.vaultId : null;

  return {
    version: 1,
    salt,
    kdf: kdfParamsFromJson(source.kdf),
    wrappedMasterKey: wrappedKeyFromJson(source.wrapped),
    createdAt: parseIso8601(source.createdAt),
    vaultId,
  };
}
