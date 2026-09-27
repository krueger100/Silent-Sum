/**
 * The installation reference has to survive the trip to a support inbox.
 *
 * Everything a user sends is scrubbed, and `scrub` redacts runs of four to eight digits because
 * that is the shape of a PIN. The reference prints as four groups of four Crockford characters,
 * and Crockford includes the digits -- so roughly one reference in twenty-six would arrive as
 * "[redacted]" if nothing stopped it, and the code signed against what arrived would be rejected
 * by the very phone that asked for it.
 *
 * These tests pin both halves: that such a reference is recognised as unusable, and that the one
 * an installation actually ends up with is never one of them.
 */
import { SequentialRandom } from '@/crypto/random';
import { InMemorySecureStore } from '@/secure-storage/secureStore';
import { RecoveryAccess } from '@/support/recoveryAccess';
import { formatInstallRef, installRefIsQuotable, INSTALL_REF_BYTES } from '@/support/recoveryCode';
import { base32Decode } from '@/utils/base32';
import { FakeClock } from '@/utils/clock';
import { scrub } from '@/utils/scrub';
import type { Bytes } from '@/utils/bytes';

/** Bytes that encode to a reference whose first group is four digits. */
function refWithDigitGroup(): Bytes {
  // '00000' base32 -> the first group is '0000'.
  const ref = base32Decode('0000000000000000');
  if (ref.length !== INSTALL_REF_BYTES) throw new Error('fixture is the wrong length');
  return ref;
}

function access(random = new SequentialRandom()): RecoveryAccess {
  return new RecoveryAccess({
    store: new InMemorySecureStore(),
    random,
    clock: new FakeClock(),
    publicKey: new Uint8Array(32),
  });
}

describe('installation reference', () => {
  it('recognises a reference the scrubber would eat', () => {
    const doomed = refWithDigitGroup();

    expect(formatInstallRef(doomed)).toBe('0000-0000-0000-0000');
    expect(scrub(formatInstallRef(doomed))).not.toBe(formatInstallRef(doomed));
    expect(installRefIsQuotable(doomed)).toBe(false);
  });

  it('accepts one the scrubber leaves alone', () => {
    const fine = base32Decode('7K4M2QX9VB3TZ8QP');

    expect(installRefIsQuotable(fine)).toBe(true);
    expect(scrub(formatInstallRef(fine))).toBe(formatInstallRef(fine));
  });

  it('never hands out a reference that would not survive being written down', async () => {
    // SequentialRandom starts at zero, which is exactly the doomed case above, so this fails
    // without the retry rather than passing by luck.
    for (let i = 0; i < 40; i++) {
      const shown = await access().displayRef();

      expect(scrub(shown)).toBe(shown);
      expect(shown).not.toContain('[redacted]');
    }
  });

  it('survives being written into a message and scrubbed on the way out', async () => {
    const shown = await access().displayRef();

    const sent = scrub(`Reference ${shown}\n\nI forgot my password`);

    expect(sent).toContain(shown);
  });

  it('still redacts a PIN sitting next to the reference', async () => {
    const shown = await access().displayRef();

    const sent = scrub(`Reference ${shown}\n\nmy pin 4821 stopped working`);

    // The reference is intact and the PIN is gone: the exemption is in the reference's SHAPE,
    // not in any weakening of the rule.
    expect(sent).toContain(shown);
    expect(sent).not.toContain('4821');
    expect(sent).toContain('[redacted]');
  });

  it('is stable: the reference shown is the reference stored', async () => {
    const service = access();

    const shown = await service.displayRef();
    const raw = await service.installRef();

    expect(shown).toBe(formatInstallRef(raw));
    expect(base32Decode(shown)).toHaveLength(INSTALL_REF_BYTES);
  });
});

describe('concurrent callers', () => {
  it('all get the SAME reference, however many ask at once', async () => {
    const service = access();

    // The card and the support draft both ask on mount, before either has finished.
    const answers = await Promise.all([
      service.displayRef(),
      service.displayRef(),
      service.installRef().then(formatInstallRef),
      service.displayRef(),
    ]);

    expect(new Set(answers).size).toBe(1);
  });

  it('agrees with what was persisted, not just with itself', async () => {
    const store = new InMemorySecureStore();
    const service = new RecoveryAccess({
      store,
      random: new SequentialRandom(),
      clock: new FakeClock(),
      publicKey: new Uint8Array(32),
    });

    const [first, second] = await Promise.all([service.displayRef(), service.displayRef()]);
    const persisted = formatInstallRef(
      base32Decode(store.snapshot['silentsum.install.ref.v1'] ?? ''),
    );

    expect(first).toBe(persisted);
    expect(second).toBe(persisted);
  });
});
