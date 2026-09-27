/**
 * The recovery code itself, verified against a real Ed25519 keypair rather than a stub, so these
 * tests fail if the signed message layout ever drifts from what the signing script produces.
 */
import { crypto_sign_detached, crypto_sign_keypair } from 'react-native-libsodium';

import {
  dayNumber,
  encodeRecoveryCode,
  formatInstallRef,
  INSTALL_REF_BYTES,
  MS_PER_DAY,
  recoveryCodeFingerprint,
  recoveryCodeMessage,
  RECOVERY_CODE_TTL_DAYS,
  SIGNATURE_BYTES,
  verifyRecoveryCode,
} from '@/support/recoveryCode';
import { signVerify } from '@/crypto/sodium';
import type { Bytes } from '@/utils/bytes';

const NOW = Date.UTC(2026, 8, 19, 12, 0, 0);

const keys = (): { publicKey: Bytes; privateKey: Bytes } => crypto_sign_keypair();

function installRef(seed: number): Bytes {
  const ref = new Uint8Array(INSTALL_REF_BYTES);
  for (let i = 0; i < ref.length; i++) ref[i] = (seed + i * 31) & 0xff;
  return ref;
}

/** What the offline signing script does, in one line. */
function mint(ref: Bytes, privateKey: Bytes, expiresAtDays: number): string {
  const signature = crypto_sign_detached(recoveryCodeMessage(ref, expiresAtDays), privateKey);
  return encodeRecoveryCode(expiresAtDays, signature);
}

const inSevenDays = dayNumber(NOW) + RECOVERY_CODE_TTL_DAYS;

describe('recovery code', () => {
  it('accepts a code signed for this installation and still in date', () => {
    const { publicKey, privateKey } = keys();
    const ref = installRef(7);

    const result = verifyRecoveryCode({
      code: mint(ref, privateKey, inSevenDays),
      installRef: ref,
      publicKey,
      nowMs: NOW,
      verify: signVerify,
    });

    expect(result).toEqual({
      ok: true,
      expiresAtMs: inSevenDays * MS_PER_DAY,
      fingerprint: expect.any(String),
    });
  });

  it('rejects a code whose signature was made by another key', () => {
    const { publicKey } = keys();
    const impostor = keys();
    const ref = installRef(7);

    const result = verifyRecoveryCode({
      code: mint(ref, impostor.privateKey, inSevenDays),
      installRef: ref,
      publicKey,
      nowMs: NOW,
      verify: signVerify,
    });

    expect(result).toEqual({ ok: false, reason: 'rejected' });
  });

  it('rejects a code issued for a different installation', () => {
    const { publicKey, privateKey } = keys();

    const result = verifyRecoveryCode({
      // Genuinely ours, genuinely in date -- but minted against another phone's reference.
      code: mint(installRef(99), privateKey, inSevenDays),
      installRef: installRef(7),
      publicKey,
      nowMs: NOW,
      verify: signVerify,
    });

    expect(result).toEqual({ ok: false, reason: 'rejected' });
  });

  it('rejects a genuine code once its expiry day has arrived', () => {
    const { publicKey, privateKey } = keys();
    const ref = installRef(7);
    const code = mint(ref, privateKey, inSevenDays);

    const onTheLastDay = verifyRecoveryCode({
      code,
      installRef: ref,
      publicKey,
      nowMs: inSevenDays * MS_PER_DAY - 1,
      verify: signVerify,
    });
    const theMomentItExpires = verifyRecoveryCode({
      code,
      installRef: ref,
      publicKey,
      nowMs: inSevenDays * MS_PER_DAY,
      verify: signVerify,
    });

    expect(onTheLastDay.ok).toBe(true);
    expect(theMomentItExpires).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a code with a single character changed', () => {
    const { publicKey, privateKey } = keys();
    const ref = installRef(7);
    const code = mint(ref, privateKey, inSevenDays);
    // Flip one payload character to a different one in the alphabet.
    const at = 20;
    const tampered = code.slice(0, at) + (code.charAt(at) === 'Z' ? 'Y' : 'Z') + code.slice(at + 1);

    const result = verifyRecoveryCode({
      code: tampered,
      installRef: ref,
      publicKey,
      nowMs: NOW,
      verify: signVerify,
    });

    expect(result).toEqual({ ok: false, reason: 'rejected' });
  });

  it.each([
    ['empty', ''],
    ['too short', 'ABCDEF-GHJKMN'],
    ['not base32', 'ABCDEF-GHJKMN-######'],
  ])('reports %s as malformed rather than rejected', (_name, code) => {
    const { publicKey } = keys();

    expect(
      verifyRecoveryCode({
        code,
        installRef: installRef(7),
        publicKey,
        nowMs: NOW,
        verify: signVerify,
      }),
    ).toEqual({ ok: false, reason: 'malformed' });
  });

  it('accepts the code however it was retyped: case, spacing and confusable characters', () => {
    const { publicKey, privateKey } = keys();
    const ref = installRef(7);
    const code = mint(ref, privateKey, inSevenDays);

    const mangled = [
      code.toLowerCase(),
      code.replace(/-/g, ''),
      code.replace(/-/g, ' '),
      `\n  ${code}  \n`,
      // Crockford folds these back: a hand-copied code survives the obvious misreadings.
      code.replace(/0/g, 'O').replace(/1/g, 'l'),
    ];

    for (const variant of mangled) {
      expect(
        verifyRecoveryCode({
          code: variant,
          installRef: ref,
          publicKey,
          nowMs: NOW,
          verify: signVerify,
        }).ok,
      ).toBe(true);
    }
  });

  it('gives the same fingerprint for the same code and a different one for another', () => {
    const { privateKey } = keys();
    const ref = installRef(7);
    const a = crypto_sign_detached(recoveryCodeMessage(ref, inSevenDays), privateKey);
    const b = crypto_sign_detached(recoveryCodeMessage(ref, inSevenDays + 1), privateKey);

    expect(recoveryCodeFingerprint(a)).toBe(recoveryCodeFingerprint(a));
    expect(recoveryCodeFingerprint(a)).not.toBe(recoveryCodeFingerprint(b));
  });

  it('prints a reference short enough to read out and a code of a fixed length', () => {
    const { privateKey } = keys();
    const ref = installRef(7);

    // 10 bytes -> 16 base32 characters, in four groups.
    expect(formatInstallRef(ref)).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    // 66 bytes -> 106 characters, plus the separators.
    const code = mint(ref, privateKey, inSevenDays);
    expect(code.replace(/-/g, '')).toHaveLength(106);
    expect(SIGNATURE_BYTES).toBe(64);
  });
});
