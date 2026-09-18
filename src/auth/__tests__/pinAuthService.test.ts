import { PinAuthService } from '@/auth/pinAuthService';
import {
  CredentialsUnreadableError,
  InvalidPinError,
  VaultAlreadyExistsError,
  type UnlockResult,
} from '@/auth/types';
import {
  Argon2idKeyDerivation,
  KDF_PRESETS,
  SodiumKeyWrapping,
  SodiumSecureRandom,
  VaultKeyId,
  type KdfParams,
  type KeyDerivation,
} from '@/crypto';
import { InMemorySecureStore, SECURE_STORE_KEYS } from '@/secure-storage/secureStore';
import { toHex, type Bytes } from '@/utils/bytes';
import { FakeClock, MINUTE_MS, SECOND_MS } from '@/utils/clock';

/** Wraps the real KDF so tests can assert it was NOT run on paths that must stay cheap. */
class CountingKdf implements KeyDerivation {
  calls = 0;
  private readonly inner = new Argon2idKeyDerivation();

  async deriveKey(secret: Bytes, salt: Bytes, params: KdfParams): Promise<Bytes> {
    this.calls += 1;
    return this.inner.deriveKey(secret, salt, params);
  }
}

function build() {
  const store = new InMemorySecureStore();
  const clock = new FakeClock();
  const kdf = new CountingKdf();
  const service = new PinAuthService({
    store,
    kdf,
    wrapping: new SodiumKeyWrapping(),
    clock,
    random: new SodiumSecureRandom(),
    kdfParams: KDF_PRESETS.forTests,
  });
  return { service, store, clock, kdf };
}

const PIN = '2468';

function expectSuccess(result: UnlockResult) {
  if (result.kind !== 'success') throw new Error(`expected success, got ${result.kind}`);
  return result;
}

describe('PinAuthService setup', () => {
  it('creates credentials and returns usable keys', async () => {
    const { service, store } = build();
    expect(await service.isConfigured()).toBe(false);

    const keys = await service.setupPin(PIN);
    expect(keys.keyFor(VaultKeyId.photo)).toHaveLength(32);
    expect(await service.isConfigured()).toBe(true);
    expect(await service.configuredPinLength()).toBe(4);
    expect(store.snapshot[SECURE_STORE_KEYS.vaultCredentials]).toBeDefined();
  });

  /**
   * Answering with a part of the PIN means the PIN must be readable at unlock time, so it is
   * stored - but only inside the secure-store credential record. See docs/security.md.
   */
  it('writes the PIN into the secure-store record and nowhere else', async () => {
    const { service, store } = build();
    await service.setupPin('13579');

    expect(JSON.parse(store.snapshot[SECURE_STORE_KEYS.vaultCredentials] ?? '{}')).toMatchObject({
      v: 1,
      pinLength: 5,
      pin: '13579',
    });
    for (const [key, value] of Object.entries(store.snapshot)) {
      if (key === SECURE_STORE_KEYS.vaultCredentials) continue;
      expect(value).not.toContain('13579');
    }
  });

  it('refuses to overwrite an existing vault', async () => {
    const { service } = build();
    await service.setupPin(PIN);
    await expect(service.setupPin('97531')).rejects.toThrow(VaultAlreadyExistsError);
  });

  it.each([
    ['too short', '123'],
    ['too long', '123456789'],
    ['not digits', '12a4'],
    ['a leading zero', '0246'],
    ['empty', ''],
  ])('rejects a PIN that is %s', async (_label, pin) => {
    const { service } = build();
    await expect(service.setupPin(pin)).rejects.toThrow(InvalidPinError);
    expect(await service.isConfigured()).toBe(false);
  });
});

describe('PinAuthService unlock', () => {
  it('unlocks with the right PIN and derives the same keys every time', async () => {
    const { service } = build();
    const created = await service.setupPin(PIN);
    const expected = toHex(created.keyFor(VaultKeyId.photo));

    const first = expectSuccess(await service.unlock(PIN));
    const second = expectSuccess(await service.unlock(PIN));
    expect(toHex(first.keys.keyFor(VaultKeyId.photo))).toBe(expected);
    expect(toHex(second.keys.keyFor(VaultKeyId.manifest))).toBe(
      toHex(created.keyFor(VaultKeyId.manifest)),
    );
  });

  it('reports a wrong PIN without revealing anything else', async () => {
    const { service } = build();
    await service.setupPin(PIN);

    const result = await service.unlock('1357');
    expect(result).toEqual({ kind: 'wrongPin', failedCount: 1, nextDelayMs: 0 });
  });

  it('reports notConfigured before any vault exists', async () => {
    const { service } = build();
    expect(await service.unlock(PIN)).toEqual({ kind: 'notConfigured' });
  });

  it('does not run the KDF for a PIN of the wrong length', async () => {
    const { service, kdf } = build();
    await service.setupPin(PIN);
    const before = kdf.calls;

    const result = await service.unlock('135791');
    expect(result.kind).toBe('wrongPin');
    expect(kdf.calls).toBe(before);
  });

  it('resets the failure count after a success', async () => {
    const { service } = build();
    await service.setupPin(PIN);
    await service.unlock('1357');
    await service.unlock('1357');
    expect((await service.throttleState()).failedCount).toBe(2);

    expectSuccess(await service.unlock(PIN));
    expect((await service.throttleState()).failedCount).toBe(0);
  });
});

describe('PinAuthService unlock from a calculated result', () => {
  const SPEC_PIN = '12142907';

  async function withSpecPin() {
    const built = build();
    const created = await built.service.setupPin(SPEC_PIN);
    created.dispose();
    return built;
  }

  it('opens the vault for the whole PIN in one calculation', async () => {
    const { service } = await withSpecPin();
    const result = expectSuccess(await service.unlockWithCalculatedDigits(SPEC_PIN));
    result.keys.dispose();
  });

  it('derives exactly the keys the PIN has always derived', async () => {
    const { service } = build();
    const created = await service.setupPin(SPEC_PIN);
    const expected = toHex(created.keyFor(VaultKeyId.photo));

    const result = expectSuccess(await service.unlockWithCalculatedDigits(SPEC_PIN));
    expect(toHex(result.keys.keyFor(VaultKeyId.photo))).toBe(expected);
  });

  /** The three examples from the spec. None of them opens anything on its own. */
  it.each<[string, string, number]>([
    ['2 - 1 = 1', '1', 7],
    ['6 + 6 = 12', '12', 6],
    ['1000 + 214 = 1214', '1214', 4],
  ])('stays locked and counts the missing digits for %s', async (_label, digits, missing) => {
    const { service } = await withSpecPin();
    expect(await service.unlockWithCalculatedDigits(digits)).toEqual({
      kind: 'partialPin',
      digits,
      missingDigits: missing,
    });
  });

  it('opens the vault once the parts add up to the whole PIN', async () => {
    const { service } = await withSpecPin();
    for (const [digits, missing] of [
      ['1', 7],
      ['12', 6],
      ['1214', 4],
    ] as const) {
      expect(await service.unlockWithCalculatedDigits(digits)).toMatchObject({
        kind: 'partialPin',
        missingDigits: missing,
      });
    }

    const opened = expectSuccess(await service.unlockWithCalculatedDigits('2907'));
    opened.keys.dispose();
  });

  /** Progress is a convenience for the person entering the PIN, not a credential. */
  it('starts from nothing again after a successful unlock', async () => {
    const { service } = await withSpecPin();
    expectSuccess(await service.unlockWithCalculatedDigits(SPEC_PIN)).keys.dispose();

    expect(await service.unlockWithCalculatedDigits('1')).toMatchObject({
      kind: 'partialPin',
      missingDigits: 7,
    });
  });

  it('never runs the KDF for a part of the PIN', async () => {
    const { service, kdf } = await withSpecPin();
    const before = kdf.calls;
    await service.unlockWithCalculatedDigits('1214');
    expect(kdf.calls).toBe(before);
  });

  /** Counting these would lock the user out halfway through entering their own PIN. */
  it('does not count a part of the PIN as a failed attempt', async () => {
    const { service } = await withSpecPin();
    for (const digits of ['1', '12', '1214', '29']) {
      await service.unlockWithCalculatedDigits(digits);
    }
    expect((await service.throttleState()).failedCount).toBe(0);
    expect(await service.remainingLockoutMs()).toBe(0);
  });

  it('confirms nothing and gains no ground while locked out', async () => {
    const { service, clock } = await withSpecPin();
    for (let i = 0; i < 3; i++) await service.unlockWithCalculatedDigits('49');
    expect(await service.remainingLockoutMs()).toBeGreaterThan(0);

    expect((await service.unlockWithCalculatedDigits('1214')).kind).toBe('throttled');

    clock.advance(SECOND_MS * 6);
    // Nothing was credited during the lockout: all eight digits were still outstanding.
    expect(await service.unlockWithCalculatedDigits('1214')).toMatchObject({
      kind: 'partialPin',
      missingDigits: 4,
    });
  });

  it.each<[string, string]>([
    ['a result that is not in the PIN', '49'],
    ['a subsequence that is not contiguous', '1227'],
    ['a result longer than the PIN', '121429070'],
    ['an empty result', ''],
  ])('stays silent for %s', async (_label, digits) => {
    const { service } = await withSpecPin();
    const result = await service.unlockWithCalculatedDigits(digits);
    expect(result.kind).toBe('wrongPin');
  });

  it('never runs the KDF for a result that is not in the PIN', async () => {
    const { service, kdf } = await withSpecPin();
    const before = kdf.calls;
    await service.unlockWithCalculatedDigits('49');
    expect(kdf.calls).toBe(before);
  });

  it('counts a non-matching result as a failed attempt', async () => {
    const { service } = await withSpecPin();
    await service.unlockWithCalculatedDigits('49');
    await service.unlockWithCalculatedDigits('3');
    expect((await service.throttleState()).failedCount).toBe(2);
  });

  /**
   * Ordinary arithmetic must not turn the calculator into a lockout notice generator, and must
   * not keep pushing an existing deadline further out.
   */
  it('stays silent and does not extend the lockout while throttled', async () => {
    const { service, clock } = await withSpecPin();
    for (let i = 0; i < 3; i++) await service.unlockWithCalculatedDigits('49');
    const locked = await service.throttleState();
    expect(await service.remainingLockoutMs()).toBeGreaterThan(0);

    const result = await service.unlockWithCalculatedDigits('3');
    expect(result.kind).toBe('wrongPin');
    expect((await service.throttleState()).lockedUntil).toBe(locked.lockedUntil);
    expect((await service.throttleState()).failedCount).toBe(3);

    // The whole PIN during the lockout IS reported, so the user knows why nothing happened.
    expect((await service.unlockWithCalculatedDigits(SPEC_PIN)).kind).toBe('throttled');

    clock.advance(SECOND_MS * 6);
    const opened = expectSuccess(await service.unlockWithCalculatedDigits(SPEC_PIN));
    opened.keys.dispose();
  });

  it('reports notConfigured before any vault exists', async () => {
    const { service } = build();
    expect(await service.unlockWithCalculatedDigits('1')).toEqual({ kind: 'notConfigured' });
  });

  /** A vault written before partial answers has no stored PIN; it must not become unopenable. */
  describe('a vault created before partial answers existed', () => {
    async function legacyVault() {
      const built = await withSpecPin();
      const record: Record<string, unknown> = JSON.parse(
        built.store.snapshot[SECURE_STORE_KEYS.vaultCredentials] ?? '{}',
      );
      delete record.pin;
      await built.store.write(SECURE_STORE_KEYS.vaultCredentials, JSON.stringify(record));
      return built;
    }

    it('still opens for the whole PIN, and stores it on the way through', async () => {
      const { service, store } = await legacyVault();
      expect((await service.loadCredentials())?.pin).toBeNull();

      const opened = expectSuccess(await service.unlockWithCalculatedDigits(SPEC_PIN));
      opened.keys.dispose();

      expect(JSON.parse(store.snapshot[SECURE_STORE_KEYS.vaultCredentials] ?? '{}')).toMatchObject({
        pin: SPEC_PIN,
        pinLength: SPEC_PIN.length,
      });
      // Upgraded: a part of the PIN now counts towards opening it.
      expect((await service.unlockWithCalculatedDigits('1214')).kind).toBe('partialPin');
    });

    it('says nothing about a part of the PIN until it has been upgraded', async () => {
      const { service } = await legacyVault();
      expect((await service.unlockWithCalculatedDigits('1214')).kind).toBe('wrongPin');
    });
  });
});

describe('PinAuthService throttling', () => {
  async function failTimes(service: PinAuthService, times: number) {
    for (let i = 0; i < times; i++) await service.unlock('1357');
  }

  it('allows two free failures then imposes the escalating delays', async () => {
    const { service, clock } = build();
    await service.setupPin(PIN);

    await failTimes(service, 2);
    expect(await service.remainingLockoutMs()).toBe(0);

    const third = await service.unlock('1357');
    expect(third).toMatchObject({ kind: 'wrongPin', failedCount: 3, nextDelayMs: 5 * SECOND_MS });
    expect(await service.remainingLockoutMs()).toBe(5 * SECOND_MS);

    clock.advance(5 * SECOND_MS);
    expect(await service.remainingLockoutMs()).toBe(0);

    const fourth = await service.unlock('1357');
    expect(fourth).toMatchObject({ failedCount: 4, nextDelayMs: 15 * SECOND_MS });
  });

  it('refuses an attempt during the delay without running the KDF, even with the right PIN', async () => {
    const { service, kdf } = build();
    await service.setupPin(PIN);
    await failTimes(service, 3);

    const before = kdf.calls;
    const result = await service.unlock(PIN);
    expect(result).toMatchObject({ kind: 'throttled' });
    expect(kdf.calls).toBe(before);
  });

  it('cannot be shortened by winding the system clock forward while running', async () => {
    const { service, clock } = build();
    await service.setupPin(PIN);
    await failTimes(service, 3);

    // Wall clock jumps an hour ahead; the in-process monotonic deadline still stands.
    clock.setNow(clock.now() + 60 * MINUTE_MS);
    expect(await service.remainingLockoutMs()).toBe(5 * SECOND_MS);
    expect((await service.unlock(PIN)).kind).toBe('throttled');
  });

  it('treats a clock wound backwards as still locked', async () => {
    const { service, store, clock } = build();
    await service.setupPin(PIN);
    await failTimes(service, 3);

    // Simulate a restart: a fresh service has no monotonic deadline, only the persisted one.
    const restarted = new PinAuthService({
      store,
      kdf: new Argon2idKeyDerivation(),
      wrapping: new SodiumKeyWrapping(),
      clock,
      random: new SodiumSecureRandom(),
      kdfParams: KDF_PRESETS.forTests,
    });
    clock.setNow(clock.now() - 60 * MINUTE_MS);
    expect(await restarted.remainingLockoutMs()).toBe(5 * SECOND_MS);
    expect((await restarted.unlock(PIN)).kind).toBe('throttled');
  });

  it('caps the delay at one hour', async () => {
    const { service, clock } = build();
    await service.setupPin(PIN);
    for (let i = 0; i < 12; i++) {
      clock.advance(2 * 60 * MINUTE_MS);
      await service.unlock('1357');
    }
    const state = await service.throttleState();
    expect(state.failedCount).toBe(12);
    expect(await service.remainingLockoutMs()).toBe(60 * MINUTE_MS);
  });

  it('never wipes anything automatically', async () => {
    const { service, clock } = build();
    await service.setupPin(PIN);
    for (let i = 0; i < 15; i++) {
      clock.advance(2 * 60 * MINUTE_MS);
      await service.unlock('1357');
    }
    expect(await service.isConfigured()).toBe(true);
    clock.advance(2 * 60 * MINUTE_MS);
    expectSuccess(await service.unlock(PIN));
  });
});

describe('PinAuthService change PIN', () => {
  it('keeps the same master key, so stored photos stay readable', async () => {
    const { service } = build();
    const original = await service.setupPin(PIN);
    const before = toHex(original.keyFor(VaultKeyId.photo));

    expect(await service.changePin(PIN, '97531')).toEqual({ kind: 'success' });

    const reopened = expectSuccess(await service.unlock('97531'));
    expect(toHex(reopened.keys.keyFor(VaultKeyId.photo))).toBe(before);
    expect(await service.configuredPinLength()).toBe(5);
  });

  it('rejects the old PIN afterwards', async () => {
    const { service } = build();
    await service.setupPin(PIN);
    await service.changePin(PIN, '97531');
    expect((await service.unlock(PIN)).kind).toBe('wrongPin');
  });

  it('refuses with the wrong current PIN and validates the new one', async () => {
    const { service } = build();
    await service.setupPin(PIN);
    expect(await service.changePin('1357', '97531')).toMatchObject({ kind: 'wrongCurrent' });
    expect(await service.changePin(PIN, '012')).toMatchObject({
      kind: 'invalidNew',
      error: 'tooShort',
    });
  });

  it('surfaces the throttle instead of letting change-PIN bypass it', async () => {
    const { service } = build();
    await service.setupPin(PIN);
    for (let i = 0; i < 3; i++) await service.unlock('1357');
    expect(await service.changePin(PIN, '97531')).toMatchObject({ kind: 'throttled' });
  });
});

describe('PinAuthService recovery paths', () => {
  it('adopts a recovered master key under a new PIN', async () => {
    const { service } = build();
    const master = new SodiumSecureRandom().bytes(32);
    const keys = await service.adoptMasterKey(master, PIN);
    const expected = toHex(keys.keyFor(VaultKeyId.photo));

    const unlocked = expectSuccess(await service.unlock(PIN));
    expect(toHex(unlocked.keys.keyFor(VaultKeyId.photo))).toBe(expected);
  });

  it('refuses to adopt over an existing vault unless told to overwrite', async () => {
    const { service } = build();
    await service.setupPin(PIN);
    const master = new SodiumSecureRandom().bytes(32);

    await expect(service.adoptMasterKey(master, '97531')).rejects.toThrow(VaultAlreadyExistsError);
    await expect(
      service.adoptMasterKey(master, '97531', { overwrite: true }),
    ).resolves.toBeDefined();
  });

  it('erases credentials and throttle state together', async () => {
    const { service, store } = build();
    await service.setupPin(PIN);
    await service.unlock('1357');

    await service.eraseCredentials();
    expect(await service.isConfigured()).toBe(false);
    expect(store.snapshot[SECURE_STORE_KEYS.vaultCredentials]).toBeUndefined();
    expect(store.snapshot[SECURE_STORE_KEYS.throttleState]).toBeUndefined();
  });
});

describe('PinAuthService corrupt records', () => {
  it.each([
    ['not JSON', 'definitely not json'],
    ['missing fields', '{"v":1}'],
    ['a bad salt length', '{"v":1,"salt":"AAAA","kdf":{"alg":"argon2id","m":1024,"t":1,"p":1,"len":32},"wrapped":{"nonce":"","ct":"","mac":""},"pinLength":4,"createdAt":"2026-01-01T00:00:00.000Z"}'],
    ['an unsupported version', '{"v":2}'],
  ])('fails closed when the record is %s', async (_label, raw) => {
    const { service, store } = build();
    await store.write(SECURE_STORE_KEYS.vaultCredentials, raw);

    await expect(service.isConfigured()).rejects.toThrow(CredentialsUnreadableError);
    await expect(service.unlock(PIN)).rejects.toThrow(CredentialsUnreadableError);
    // Critically, it must NOT look like an unconfigured device, which would let setup overwrite it.
    await expect(service.setupPin(PIN)).rejects.toThrow(CredentialsUnreadableError);
  });

  it('falls back to no throttling when only the throttle record is damaged', async () => {
    const { service, store } = build();
    await service.setupPin(PIN);
    await store.write(SECURE_STORE_KEYS.throttleState, 'garbage');

    expect(await service.throttleState()).toEqual({
      failedCount: 0,
      lockedUntil: null,
      lastFailureAt: null,
    });
    expectSuccess(await service.unlock(PIN));
  });

  it('propagates a secure store that cannot be read at all', async () => {
    const { service, store } = build();
    jest.spyOn(store, 'read').mockRejectedValue(new Error('keystore unavailable'));
    await expect(service.loadCredentials()).rejects.toThrow(CredentialsUnreadableError);
  });
});
