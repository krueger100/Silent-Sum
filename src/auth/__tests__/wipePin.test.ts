/**
 * The wipe PIN as the authenticator sees it: what can be armed, what a calculated result means,
 * and the two things that must never happen -- a fragment firing it, and a lockout disarming it.
 */
import { PinAuthService } from '@/auth/pinAuthService';
import { InvalidPinError } from '@/auth/types';
import { decodeWipePin, encodeWipePin, wipePinConflict } from '@/auth/wipePin';
import {
  Argon2idKeyDerivation,
  KDF_PRESETS,
  SodiumKeyWrapping,
  SodiumSecureRandom,
} from '@/crypto';
import { RecordFormatError } from '@/crypto/types';
import { InMemorySecureStore, SECURE_STORE_KEYS } from '@/secure-storage/secureStore';
import { FakeClock } from '@/utils/clock';

const VAULT_PIN = '12142907';
const WIPE_PIN = '55531';
const NOISE = '87654321';

function build() {
  const store = new InMemorySecureStore();
  const clock = new FakeClock();
  const service = new PinAuthService({
    store,
    kdf: new Argon2idKeyDerivation(),
    wrapping: new SodiumKeyWrapping(),
    clock,
    random: new SodiumSecureRandom(),
    kdfParams: KDF_PRESETS.forTests,
  });
  return { service, store, clock };
}

async function withVault() {
  const harness = build();
  const keys = await harness.service.setupPin(VAULT_PIN);
  keys.dispose();
  return harness;
}

describe('the wipe pin record', () => {
  it('round-trips through the store format', () => {
    const record = { version: 1, pin: WIPE_PIN, scope: 'both', createdAt: 1_700_000_000_000 } as const;
    expect(decodeWipePin(encodeWipePin(record))).toEqual(record);
  });

  it('refuses a record that would arm something unintended', () => {
    expect(() => decodeWipePin('not json')).toThrow(RecordFormatError);
    expect(() => decodeWipePin(JSON.stringify({ v: 1, pin: WIPE_PIN, scope: 'everything' }))).toThrow(
      RecordFormatError,
    );
    // A stored PIN that breaks the policy could never be typed on a calculator anyway.
    expect(() => decodeWipePin(JSON.stringify({ v: 1, pin: '0123', scope: 'device' }))).toThrow(
      RecordFormatError,
    );
  });
});

describe('wipePinConflict', () => {
  it('refuses the vault PIN itself', () => {
    expect(wipePinConflict(VAULT_PIN, VAULT_PIN)).toBe('sameAsVaultPin');
  });

  it('refuses a PIN hiding inside the vault PIN, which would fire while unlocking', () => {
    // "1214" is exactly what the user calculates on their way into the vault.
    expect(wipePinConflict('1214', VAULT_PIN)).toBe('partOfVaultPin');
    expect(wipePinConflict('2907', VAULT_PIN)).toBe('partOfVaultPin');
  });

  it('refuses the other direction too, for the same reason read backwards', () => {
    expect(wipePinConflict(`${VAULT_PIN}1`, VAULT_PIN)).toBe('partOfVaultPin');
  });

  it('allows an unrelated PIN, and anything at all when the vault PIN is not stored', () => {
    expect(wipePinConflict(WIPE_PIN, VAULT_PIN)).toBeNull();
    expect(wipePinConflict('1214', null)).toBeNull();
  });
});

describe('arming the wipe pin', () => {
  it('stores it under its own key and reads it back', async () => {
    const { service, store, clock } = await withVault();
    expect(await service.wipePin()).toBeNull();

    await service.setWipePin(WIPE_PIN, 'both');

    expect(await service.wipePin()).toEqual({
      version: 1,
      pin: WIPE_PIN,
      scope: 'both',
      createdAt: clock.now(),
    });
    expect(store.snapshot[SECURE_STORE_KEYS.wipePin]).toBeDefined();
    // The vault record is untouched: arming a trap does not re-wrap the master key.
    expect(store.snapshot[SECURE_STORE_KEYS.vaultCredentials]).not.toContain(WIPE_PIN);
  });

  it('refuses a PIN that breaks the policy or overlaps the vault PIN', async () => {
    const { service } = await withVault();

    await expect(service.setWipePin('012', 'device')).rejects.toThrow(InvalidPinError);
    await expect(service.setWipePin(VAULT_PIN, 'device')).rejects.toThrow(InvalidPinError);
    await expect(service.setWipePin('1214', 'device')).rejects.toThrow(InvalidPinError);
    expect(await service.wipePin()).toBeNull();
  });

  it('is turned off again by clearing it', async () => {
    const { service } = await withVault();
    await service.setWipePin(WIPE_PIN, 'device');

    await service.clearWipePin();

    expect(await service.wipePin()).toBeNull();
  });

  it('goes with the credentials when the vault is erased', async () => {
    const { service, store } = await withVault();
    await service.setWipePin(WIPE_PIN, 'device');

    await service.eraseCredentials();

    // Leaving it armed would point it at whatever vault is created next.
    expect(await service.wipePin()).toBeNull();
    expect(store.snapshot[SECURE_STORE_KEYS.wipePin]).toBeUndefined();
  });
});

describe('what a calculated result means', () => {
  it('reports the armed scope for the whole wipe PIN', async () => {
    const { service } = await withVault();
    await service.setWipePin(WIPE_PIN, 'backup');

    expect(await service.unlockWithCalculatedDigits(WIPE_PIN)).toEqual({
      kind: 'wipe',
      scope: 'backup',
    });
  });

  it('never fires on a fragment of it', async () => {
    const { service } = await withVault();
    await service.setWipePin(WIPE_PIN, 'both');

    // The vault opens on a contiguous PART of its PIN; the wipe PIN deliberately does not.
    for (const fragment of ['5', '55', '555', '5553', '5531']) {
      expect((await service.unlockWithCalculatedDigits(fragment)).kind).not.toBe('wipe');
    }
  });

  it('still fires while the vault is locked out after wrong attempts', async () => {
    const { service } = await withVault();
    await service.setWipePin(WIPE_PIN, 'device');

    for (let attempt = 0; attempt < 3; attempt++) await service.unlock(NOISE);
    expect((await service.unlock(VAULT_PIN)).kind).toBe('throttled');

    // The emergency path is not something an attacker can switch off by guessing badly first.
    expect(await service.unlockWithCalculatedDigits(WIPE_PIN)).toEqual({
      kind: 'wipe',
      scope: 'device',
    });
  });

  it('is not reachable from the PIN entry screens, only from the calculator', async () => {
    const { service } = await withVault();
    await service.setWipePin(WIPE_PIN, 'both');

    // `unlock` is what Change PIN and the restore flow use. A wipe PIN there is simply wrong.
    expect((await service.unlock(WIPE_PIN)).kind).toBe('wrongPin');
    expect((await service.changePin(WIPE_PIN, '4826')).kind).toBe('wrongCurrent');
    expect(await service.wipePin()).not.toBeNull();
  });

  it('leaves the vault PIN working exactly as before', async () => {
    const { service } = await withVault();
    await service.setWipePin(WIPE_PIN, 'both');

    const result = await service.unlockWithCalculatedDigits(VAULT_PIN);
    expect(result.kind).toBe('success');
    if (result.kind === 'success') result.keys.dispose();
  });
});

/**
 * The other half of the overlap guarantee.
 *
 * Arming a wipe PIN checks it against the vault PIN. Nothing used to check the reverse, so the
 * guarantee lasted exactly until the next Change PIN: a user could arm a wipe PIN and then move
 * their vault PIN on top of it, after which their own PIN destroyed the vault instead of opening
 * it, silently, with no way to find out except by doing it.
 */
describe('a vault pin can never be moved on top of the wipe pin', () => {
  it('refuses a new vault PIN that is, contains, or is contained by the wipe PIN', async () => {
    const { service } = await withVault();
    await service.setWipePin(WIPE_PIN, 'both');

    for (const candidate of [WIPE_PIN, `4${WIPE_PIN}`, '5553']) {
      expect(await service.changePin(VAULT_PIN, candidate)).toEqual({
        kind: 'invalidNew',
        error: 'clashesWithWipePin',
      });
    }

    // Nothing moved: the old PIN still opens the vault, the wipe PIN is still armed.
    const opened = await service.unlockWithCalculatedDigits(VAULT_PIN);
    expect(opened.kind).toBe('success');
    if (opened.kind === 'success') opened.keys.dispose();
    expect(await service.wipePin()).toMatchObject({ pin: WIPE_PIN });
  });

  it('allows an unrelated new vault PIN, and both PINs still mean what they meant', async () => {
    const { service } = await withVault();
    await service.setWipePin(WIPE_PIN, 'device');

    expect(await service.changePin(VAULT_PIN, '48267')).toEqual({ kind: 'success' });

    const opened = await service.unlockWithCalculatedDigits('48267');
    expect(opened.kind).toBe('success');
    if (opened.kind === 'success') opened.keys.dispose();
    expect(await service.unlockWithCalculatedDigits(WIPE_PIN)).toEqual({
      kind: 'wipe',
      scope: 'device',
    });
  });

  it('refuses a first-run PIN that clashes with a wipe record left behind', async () => {
    const { service } = build();
    await service.setWipePin(WIPE_PIN, 'device');

    await expect(service.setupPin(WIPE_PIN)).rejects.toThrow(InvalidPinError);
    await expect(service.setupPin(`9${WIPE_PIN}`)).rejects.toThrow(InvalidPinError);
    expect(await service.isConfigured()).toBe(false);
  });

  it('refuses a restored vault whose new PIN would clash', async () => {
    const { service } = build();
    await service.setWipePin(WIPE_PIN, 'both');
    const master = new Uint8Array(32).fill(7);

    await expect(service.adoptMasterKey(master, WIPE_PIN)).rejects.toThrow(InvalidPinError);
    expect(await service.isConfigured()).toBe(false);

    // An unrelated PIN is still fine, so the guard has not broken restore.
    const keys = await service.adoptMasterKey(master, '48267');
    keys.dispose();
    expect(await service.isConfigured()).toBe(true);
  });
});
