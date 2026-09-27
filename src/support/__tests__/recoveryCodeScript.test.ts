/**
 * The signing script and the app must agree byte for byte.
 *
 * `scripts/recovery-code.js` deliberately duplicates the code layout so that it can run on an
 * offline machine with no project and no npm install. Duplication that nothing checks is
 * duplication that drifts, so this is the check: a code minted by the real script, verified by the
 * real app module, against a real keypair. If either side changes the context string, the field
 * order, the expiry unit or the alphabet, this fails.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
import { signVerify } from '@/crypto/sodium';
import {
  MS_PER_DAY,
  RECOVERY_CODE_TTL_DAYS,
  verifyRecoveryCode,
  type RecoveryCodeResult,
} from '@/support/recoveryCode';
import { base32Decode } from '@/utils/base32';
import { base64Decode } from '@/utils/base64';
import type { Bytes } from '@/utils/bytes';

interface SignedCode {
  readonly code: string;
  readonly expiresAt: string;
}

interface SigningScript {
  readonly DEFAULT_TTL_DAYS: number;
  keygen(): { publicKey: string; privateKey: string };
  privateKeyFrom(base64: string): unknown;
  publicKeyFrom(base64: string): unknown;
  signCode(input: { ref: string; privateKey: unknown; days?: number; nowMs?: number }): SignedCode;
  verifyCode(input: { code: string; ref: string; publicKey: unknown }): boolean;
  base32Encode(bytes: Uint8Array): string;
}

const script = require('../../../scripts/recovery-code.js') as SigningScript;

const NOW = Date.UTC(2026, 8, 19, 9, 30, 0);
/** A reference in the form the About page prints and the operator pastes into the script. */
const REF = script.base32Encode(Uint8Array.from([9, 3, 250, 17, 64, 200, 7, 33, 180, 99]));

function verifyInApp(code: string, publicKey: Bytes, nowMs = NOW): RecoveryCodeResult {
  return verifyRecoveryCode({
    code,
    installRef: base32Decode(REF),
    publicKey,
    nowMs,
    verify: signVerify,
  });
}

describe('signing script and app module', () => {
  it('agrees on a default code: the script signs it and the app accepts it', () => {
    const pair = script.keygen();
    const signed = script.signCode({
      ref: REF,
      privateKey: script.privateKeyFrom(pair.privateKey),
      nowMs: NOW,
    });

    const result = verifyInApp(signed.code, base64Decode(pair.publicKey));

    expect(result.ok).toBe(true);
    // Both sides derive the same expiry from the same day number.
    expect(result.ok && new Date(result.expiresAtMs).toISOString().slice(0, 10)).toBe(
      signed.expiresAt,
    );
  });

  it('defaults to the seven days the product promises', () => {
    const pair = script.keygen();
    const signed = script.signCode({
      ref: REF,
      privateKey: script.privateKeyFrom(pair.privateKey),
      nowMs: NOW,
    });

    const result = verifyInApp(signed.code, base64Decode(pair.publicKey));

    expect(script.DEFAULT_TTL_DAYS).toBe(RECOVERY_CODE_TTL_DAYS);
    expect(result.ok && result.expiresAtMs).toBe(
      (Math.floor(NOW / MS_PER_DAY) + RECOVERY_CODE_TTL_DAYS) * MS_PER_DAY,
    );
  });

  it('produces a code the app calls expired once the day arrives', () => {
    const pair = script.keygen();
    const signed = script.signCode({
      ref: REF,
      privateKey: script.privateKeyFrom(pair.privateKey),
      days: 1,
      nowMs: NOW,
    });

    const publicKey = base64Decode(pair.publicKey);

    expect(verifyInApp(signed.code, publicKey).ok).toBe(true);
    expect(verifyInApp(signed.code, publicKey, NOW + 2 * MS_PER_DAY)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('will not verify a code against another installation, on either side', () => {
    const pair = script.keygen();
    const otherRef = script.base32Encode(Uint8Array.from([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]));
    const signed = script.signCode({
      ref: otherRef,
      privateKey: script.privateKeyFrom(pair.privateKey),
      nowMs: NOW,
    });

    // The script's own verifier agrees with the app's, which is the point of checking both.
    expect(
      script.verifyCode({
        code: signed.code,
        ref: REF,
        publicKey: script.publicKeyFrom(pair.publicKey),
      }),
    ).toBe(false);
    expect(verifyInApp(signed.code, base64Decode(pair.publicKey))).toEqual({
      ok: false,
      reason: 'rejected',
    });
  });

  it('mints a different code for every keypair, so a leaked code implies nothing about the key', () => {
    const a = script.keygen();
    const b = script.keygen();
    const sign = (pair: { privateKey: string }): string =>
      script.signCode({ ref: REF, privateKey: script.privateKeyFrom(pair.privateKey), nowMs: NOW })
        .code;

    expect(sign(a)).not.toBe(sign(b));
    expect(verifyInApp(sign(a), base64Decode(b.publicKey))).toEqual({
      ok: false,
      reason: 'rejected',
    });
  });
});
