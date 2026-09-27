/**
 * Support-issued recovery codes.
 *
 * The problem this solves is narrow. With super secure on, a user who has forgotten their PIN sees
 * a calculator whose menu offers nothing but About, and the only thing on that page is a way to
 * write to us. This is what we can send back: a code that re-opens the door to the RESTORE flow on
 * that one phone, and nothing else.
 *
 * What a code can do is smaller than it looks, and the shape of it is the point:
 *
 *  - It carries a signature, never a secret. The app holds a PUBLIC key; the private half never
 *    leaves the signing machine. Pulling the key out of the APK therefore buys an attacker
 *    nothing -- verifying a code and MINTING one are different powers, and only the first one
 *    ships. A shared secret would have put both in every install.
 *  - It is bound to one installation. The random per-install reference is inside the signed
 *    message, so a code minted for one phone fails signature verification on any other. There is
 *    no separate "wrong device" check to forget: it falls out of the signature.
 *  - It expires, so an old support email is not a permanent key to the phone it was sent to.
 *  - It decrypts nothing. It reveals a sign-in screen. The backup is still sealed under the
 *    recovery passphrase, which we have never had and cannot issue.
 *
 * Verification is arithmetic on bytes the user typed: no network, no Firebase, nothing that can
 * fail because a server is down or a SIM is missing. That matters because the people who need a
 * code are, by definition, already locked out of something.
 *
 * The code is as short as a public-key signature can be, which is not very short. An Ed25519
 * signature is 64 bytes and cannot be truncated -- a signature missing bits is not a weaker
 * signature, it is an unverifiable one. So the length is fixed by the scheme, and what is left to
 * design is only how painless the typing is: Crockford base32, case-insensitive, confusables
 * folded, separators ignored. See {@link base32Decode}.
 */
import { base32Decode, base32Encode, Base32Error, groupBase32 } from '@/utils/base32';
import type { Bytes } from '@/utils/bytes';
import { scrub } from '@/utils/scrub';

/**
 * Domain separator. Signed as part of every message so a signature this key made for some other
 * purpose can never be replayed as a recovery code.
 */
export const RECOVERY_CODE_CONTEXT = 'SSRC1';

export const INSTALL_REF_BYTES = 10;
export const SIGNATURE_BYTES = 64;
export const PUBLIC_KEY_BYTES = 32;
/** Two bytes of expiry day, then the detached signature. */
export const RECOVERY_CODE_BYTES = 2 + SIGNATURE_BYTES;
export const RECOVERY_CODE_TTL_DAYS = 7;
export const MS_PER_DAY = 86_400_000;

/** How the printed code is chunked. Cosmetic; the decoder ignores the separators. */
const CODE_GROUP = 6;
const REF_GROUP = 4;

export type RecoveryCodeFailure =
  /** Not a code at all: bad characters, or the wrong number of bytes. */
  | 'malformed'
  /** The signature does not verify: forged, tampered with, or minted for another installation. */
  | 'rejected'
  /** Genuine, but past its expiry day. */
  | 'expired';

export interface RecoveryCodeAccepted {
  readonly ok: true;
  readonly expiresAtMs: number;
  /** Identifies this code for single-use bookkeeping. Derived from public bytes only. */
  readonly fingerprint: string;
}

export interface RecoveryCodeRefused {
  readonly ok: false;
  readonly reason: RecoveryCodeFailure;
}

export type RecoveryCodeResult = RecoveryCodeAccepted | RecoveryCodeRefused;

/** Verifies a detached Ed25519 signature. Injected so this module stays free of native bindings. */
export type SignatureVerifier = (message: Bytes, signature: Bytes, publicKey: Bytes) => boolean;

/** Days since the Unix epoch, which is the unit the expiry is carried in. */
export function dayNumber(ms: number): number {
  return Math.floor(ms / MS_PER_DAY);
}

/**
 * The bytes the signing script signs: context, then the installation reference, then the expiry.
 *
 * The reference is in here rather than in the code itself because the app already knows its own,
 * and a value the verifier supplies cannot be edited by whoever is holding the phone.
 */
export function recoveryCodeMessage(installRef: Bytes, expiresAtDays: number): Bytes {
  if (installRef.length !== INSTALL_REF_BYTES) {
    throw new RangeError(`install ref must be ${String(INSTALL_REF_BYTES)} bytes`);
  }
  if (!Number.isInteger(expiresAtDays) || expiresAtDays < 0 || expiresAtDays > 0xffff) {
    throw new RangeError('expiry day must be a 16-bit unsigned integer');
  }
  const out = new Uint8Array(RECOVERY_CODE_CONTEXT.length + INSTALL_REF_BYTES + 2);
  for (let i = 0; i < RECOVERY_CODE_CONTEXT.length; i++) {
    out[i] = RECOVERY_CODE_CONTEXT.charCodeAt(i);
  }
  out.set(installRef, RECOVERY_CODE_CONTEXT.length);
  const at = RECOVERY_CODE_CONTEXT.length + INSTALL_REF_BYTES;
  out[at] = (expiresAtDays >> 8) & 0xff;
  out[at + 1] = expiresAtDays & 0xff;
  return out;
}

/** What the signing script prints and the user pastes back. */
export function encodeRecoveryCode(expiresAtDays: number, signature: Bytes): string {
  if (signature.length !== SIGNATURE_BYTES) {
    throw new RangeError(`signature must be ${String(SIGNATURE_BYTES)} bytes`);
  }
  const payload = new Uint8Array(RECOVERY_CODE_BYTES);
  payload[0] = (expiresAtDays >> 8) & 0xff;
  payload[1] = expiresAtDays & 0xff;
  payload.set(signature, 2);
  return groupBase32(base32Encode(payload), CODE_GROUP);
}

/** The reference shown beside the version string, for the user to quote to support. */
export function formatInstallRef(installRef: Bytes): string {
  return groupBase32(base32Encode(installRef), REF_GROUP);
}

/**
 * Whether this reference can survive being written in a support message.
 *
 * The reference is meant to be quoted back to us, and everything a user sends passes through
 * `scrub`, which redacts runs of four to eight digits because that is the shape of a PIN. A
 * reference whose group happens to be four digits therefore arrives as "[redacted]" -- about
 * one in twenty-six of them -- and a code signed against what arrived would be rejected by the
 * very phone that asked for it, with nothing on screen to explain why.
 *
 * So references are generated until they pass this, and the test is `scrub` itself rather than
 * a copy of its rule: the scrubber is free to change without quietly reopening the hole. The
 * cost is under a tenth of a bit of an identifier that was never a secret.
 */
export function installRefIsQuotable(installRef: Bytes): boolean {
  const formatted = formatInstallRef(installRef);
  return scrub(formatted) === formatted;
}

/**
 * Public bytes only -- the first bytes of the signature, which are already in the email. Keeping a
 * fingerprint rather than the whole code makes the used-code list cheap without ever storing
 * something that could be replayed from it.
 */
export function recoveryCodeFingerprint(signature: Bytes): string {
  return base32Encode(signature.subarray(0, 12));
}

export interface VerifyRecoveryCodeInput {
  /** As typed or pasted; whitespace, separators and case are all tolerated. */
  readonly code: string;
  readonly installRef: Bytes;
  readonly publicKey: Bytes;
  readonly nowMs: number;
  readonly verify: SignatureVerifier;
}

/**
 * Checks the signature FIRST and the expiry second, so a forged code never learns whether the day
 * it guessed was plausible: everything that is not genuinely ours answers the same way.
 */
export function verifyRecoveryCode(input: VerifyRecoveryCodeInput): RecoveryCodeResult {
  const { code, installRef, publicKey, nowMs, verify } = input;
  if (publicKey.length !== PUBLIC_KEY_BYTES || installRef.length !== INSTALL_REF_BYTES) {
    return { ok: false, reason: 'rejected' };
  }

  let payload: Bytes;
  try {
    payload = base32Decode(code);
  } catch (cause) {
    if (cause instanceof Base32Error) return { ok: false, reason: 'malformed' };
    throw cause;
  }
  if (payload.length !== RECOVERY_CODE_BYTES) return { ok: false, reason: 'malformed' };

  const expiresAtDays = ((payload[0] ?? 0) << 8) | (payload[1] ?? 0);
  const signature = payload.subarray(2);

  let genuine: boolean;
  try {
    genuine = verify(recoveryCodeMessage(installRef, expiresAtDays), signature, publicKey);
  } catch {
    // A native verifier may throw rather than return false on a malformed signature. Same answer.
    genuine = false;
  }
  if (!genuine) return { ok: false, reason: 'rejected' };

  const expiresAtMs = expiresAtDays * MS_PER_DAY;
  if (nowMs >= expiresAtMs) return { ok: false, reason: 'expired' };

  return { ok: true, expiresAtMs, fingerprint: recoveryCodeFingerprint(signature) };
}
