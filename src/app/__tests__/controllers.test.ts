import { createServices } from '@/app/services';
import { SettingsController } from '@/app/settingsController';
import { VaultSession } from '@/auth/vaultSession';
import { KDF_PRESETS, SodiumSecureRandom, VaultKeyId, deriveVaultKeys } from '@/crypto';
import { InMemorySecureStore } from '@/secure-storage/secureStore';
import { DEFAULT_SETTINGS, InMemorySettingsStore } from '@/settings/appSettings';
import { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import { FakeThumbnailGenerator } from '@/vault/thumbnailGenerator';
import { VaultLockedError } from '@/vault/types';
import { toHex } from '@/utils/bytes';
import { FakeClock } from '@/utils/clock';

const random = new SodiumSecureRandom();

function testServices() {
  const fs = new InMemoryFileSystem();
  const clock = new FakeClock();
  return createServices({
    fs,
    clock,
    random,
    secureStore: new InMemorySecureStore(),
    settingsStore: new InMemorySettingsStore(),
    thumbnails: new FakeThumbnailGenerator(),
    kdfParams: KDF_PRESETS.forTests,
  });
}

describe('VaultSession', () => {
  it('starts locked and refuses to hand out keys', () => {
    const session = new VaultSession(() => 0);
    expect(session.isUnlocked).toBe(false);
    expect(session.peekKeys()).toBeNull();
    expect(() => session.requireKeys()).toThrow(VaultLockedError);
  });

  it('adopts keys and reports unlocked without exposing them in observable state', () => {
    const session = new VaultSession(() => 1234);
    const keys = deriveVaultKeys(random.bytes(32));

    session.adopt(keys);

    expect(session.isUnlocked).toBe(true);
    expect(session.store.getState()).toEqual({ isUnlocked: true, unlockedAtMs: 1234 });
    // The key material must not be reachable from the store at all.
    expect(JSON.stringify(session.store.getState())).not.toContain(
      toHex(keys.keyFor(VaultKeyId.photo)),
    );
    expect(session.requireKeys()).toBe(keys);
  });

  it('wipes the key material on lock and is idempotent', () => {
    const session = new VaultSession(() => 0);
    const keys = deriveVaultKeys(random.bytes(32));
    const photo = keys.keyFor(VaultKeyId.photo);
    session.adopt(keys);

    session.lock();

    expect(toHex(photo)).toBe('00'.repeat(32));
    expect(session.isUnlocked).toBe(false);
    expect(() => session.requireKeys()).toThrow(VaultLockedError);
    expect(() => session.lock()).not.toThrow();
  });

  it('notifies lock listeners exactly once, after the keys are already gone', () => {
    const session = new VaultSession(() => 0);
    let unlockedDuringCallback: boolean | null = null;
    let calls = 0;
    session.onLock(() => {
      calls += 1;
      unlockedDuringCallback = session.isUnlocked;
    });

    session.adopt(deriveVaultKeys(random.bytes(32)));
    session.lock();
    session.lock();

    expect(calls).toBe(1);
    expect(unlockedDuringCallback).toBe(false);
  });

  it('locks the previous session when a new one is adopted', () => {
    const session = new VaultSession(() => 0);
    const first = deriveVaultKeys(random.bytes(32));
    const firstPhoto = first.keyFor(VaultKeyId.photo);
    session.adopt(first);

    session.adopt(deriveVaultKeys(random.bytes(32)));

    expect(toHex(firstPhoto)).toBe('00'.repeat(32));
    expect(session.isUnlocked).toBe(true);
  });

  it('treats externally disposed keys as locked', () => {
    const session = new VaultSession(() => 0);
    const keys = deriveVaultKeys(random.bytes(32));
    session.adopt(keys);

    keys.dispose();

    expect(session.peekKeys()).toBeNull();
    expect(() => session.requireKeys()).toThrow(VaultLockedError);
  });
});

describe('VaultController', () => {
  it('opens on unlock and exposes the photo list', async () => {
    const services = testServices();
    const keys = await services.auth.setupPin('2468');
    services.session.adopt(keys);

    await services.vault.open(keys);
    expect(services.vault.store.getState()).toMatchObject({ isOpen: true, unreadable: false });

    await services.vault.requireRepository().addPhoto(
      { bytes: random.bytes(512) },
      { source: 'camera' },
    );
    expect(services.vault.store.getState().photos).toHaveLength(1);
  });

  it('closes and empties the photo list when the session locks', async () => {
    const services = testServices();
    const keys = await services.auth.setupPin('2468');
    services.session.adopt(keys);
    await services.vault.open(keys);
    await services.vault.requireRepository().addPhoto(
      { bytes: random.bytes(512) },
      { source: 'camera' },
    );

    services.session.lock();
    // The lock listener closes asynchronously; let the microtask queue drain.
    await Promise.resolve();
    await Promise.resolve();

    expect(services.vault.current).toBeNull();
    expect(services.vault.store.getState()).toEqual({
      photos: [],
      isOpen: false,
      unreadable: false,
    });
    expect(() => services.vault.requireRepository()).toThrow(VaultLockedError);
  });

  it('reports unreadable when the vault files do not decrypt with the session keys', async () => {
    const services = testServices();
    const keys = await services.auth.setupPin('2468');
    await services.vault.open(keys);
    await services.vault.requireRepository().addPhoto(
      { bytes: random.bytes(512) },
      { source: 'camera' },
    );

    const foreign = deriveVaultKeys(random.bytes(32));
    await expect(services.vault.open(foreign)).rejects.toThrow();

    expect(services.vault.store.getState()).toMatchObject({ isOpen: false, unreadable: true });
    expect(services.vault.current).toBeNull();
  });

  it('replaces a previously open vault rather than leaking it', async () => {
    const services = testServices();
    const keys = await services.auth.setupPin('2468');
    const first = await services.vault.open(keys);
    const second = await services.vault.open(keys);

    expect(first).not.toBe(second);
    expect(services.vault.current).toBe(second);
  });
});

describe('SettingsController', () => {
  it('starts on the defaults and loads persisted values once', async () => {
    const store = new InMemorySettingsStore();
    await store.save({ ...DEFAULT_SETTINGS, analyticsEnabled: true });
    const controller = new SettingsController(store);

    expect(controller.current).toEqual(DEFAULT_SETTINGS);
    await controller.load();
    expect(controller.current.analyticsEnabled).toBe(true);

    const spy = jest.spyOn(store, 'load');
    await controller.load();
    expect(spy).not.toHaveBeenCalled();
  });

  it('applies updates immediately and persists them', async () => {
    const store = new InMemorySettingsStore();
    const controller = new SettingsController(store);

    await controller.update({ autoLockTimeout: 'fifteenMinutes' });

    expect(controller.current.autoLockTimeout).toBe('fifteenMinutes');
    expect((await store.load()).autoLockTimeout).toBe('fifteenMinutes');
  });

  it('keeps the new value in this session even if persistence fails', async () => {
    const store = new InMemorySettingsStore();
    jest.spyOn(store, 'save').mockRejectedValueOnce(new Error('disk full'));
    const controller = new SettingsController(store);

    await expect(controller.update({ screenProtection: false })).resolves.toBeUndefined();
    expect(controller.current.screenProtection).toBe(false);
  });

  it('falls back to defaults when the persisted record cannot be read', async () => {
    const store = new InMemorySettingsStore();
    jest.spyOn(store, 'load').mockRejectedValueOnce(new Error('corrupt'));
    const controller = new SettingsController(store);

    expect(await controller.load()).toEqual(DEFAULT_SETTINGS);
  });

  it('resets everything on vault erase', async () => {
    const store = new InMemorySettingsStore();
    const controller = new SettingsController(store);
    await controller.update({ analyticsEnabled: true, backupEnabled: true });

    await controller.reset();

    expect(controller.current).toEqual(DEFAULT_SETTINGS);
  });
});

describe('createServices', () => {
  it('wires a working offline stack with no Firebase', async () => {
    const services = testServices();

    expect(services.firebase.available).toBe(false);
    expect(services.firebase.cloud).toBeNull();
    expect(services.backup).toBeNull();

    // The whole vault lifecycle works regardless.
    const keys = await services.auth.setupPin('2468');
    services.session.adopt(keys);
    await services.vault.open(keys);
    const entry = await services.vault.requireRepository().addPhoto(
      { bytes: random.bytes(256) },
      { source: 'camera' },
    );
    expect(await services.vault.requireRepository().readFullImage(entry.id)).toBeDefined();
  });

  it('derives the vault directory from the injected file system', () => {
    const fs = new InMemoryFileSystem();
    const services = createServices({ fs, settingsStore: new InMemorySettingsStore() });
    expect(services.paths.root.startsWith(fs.documentDirectory)).toBe(true);
  });
});
