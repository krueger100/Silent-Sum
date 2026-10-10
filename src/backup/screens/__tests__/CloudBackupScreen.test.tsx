import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { CloudBackupScreen } from '@/backup/screens/CloudBackupScreen';
import {
  buildCloudHarness,
  buildHarness,
  openVaultWithPhotos,
  renderWithServices,
  type CloudHarness,
} from '@/backup/screens/__tests__/harness';
import { AccountDataRemainsError, BACKUP_PATHS, type BackupService } from '@/backup/types';
import { InMemoryCloudBackend } from '@/firebase/cloudBackend';
import { CloudError } from '@/firebase/types';
import type { VaultRepository } from '@/vault/types';

const EMAIL = 'vault@example.test';
const ACCOUNT_PASSWORD = 'account-password';
const PASSPHRASE = 'correct horse battery staple';

describe('CloudBackupScreen without a cloud backend', () => {
  it('explains that backup is unavailable in this build instead of crashing', async () => {
    const harness = buildHarness();
    expect(harness.services.backup).toBeNull();

    await renderWithServices(harness.services, <CloudBackupScreen />);

    expect(screen.getByTestId('backup_unavailable')).toHaveTextContent(
      /not available in this build/i,
    );
    expect(screen.getByTestId('backup_unavailable')).toHaveTextContent(/unlocked entirely offline/);
    expect(screen.queryByTestId('backup_sign_in')).toBeNull();
    expect(screen.queryByTestId('backup_enable')).toBeNull();
  });
});

describe('CloudBackupScreen with a cloud backend', () => {
  it('says the account is a separate credential that cannot open the vault', async () => {
    const harness = buildCloudHarness();
    await renderWithServices(harness.services, <CloudBackupScreen />);

    expect(screen.getByText(/separate credential from your vault PIN/)).toBeTruthy();
    expect(screen.getByTestId('backup_sign_in')).toBeTruthy();
    expect(screen.getByTestId('backup_sign_up')).toBeTruthy();
  });

  it('refuses a short recovery passphrase before any network call', async () => {
    const harness = buildCloudHarness();
    await openVaultWithPhotos(harness, '2468', 1);
    await harness.cloud.signUp(EMAIL, ACCOUNT_PASSWORD);
    const putDocument = jest.spyOn(harness.cloud, 'putDocument');
    const putBlob = jest.spyOn(harness.cloud, 'putBlob');

    await renderWithServices(harness.services, <CloudBackupScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('backup_enable')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('backup_enable'));
    await fireEvent.changeText(screen.getByTestId('backup_passphrase'), 'short');
    await fireEvent.changeText(screen.getByTestId('backup_passphrase_confirm'), 'short');
    await fireEvent.press(screen.getByTestId('backup_passphrase_submit'));

    expect(screen.getByTestId('backup_error')).toHaveTextContent(/at least 12 characters/);
    expect(putDocument).not.toHaveBeenCalled();
    expect(putBlob).not.toHaveBeenCalled();
    expect(harness.cloud.documents.size).toBe(0);
    expect(harness.services.settings.current.backupEnabled).toBe(false);
  });

  it('refuses a mismatched confirmation before any network call', async () => {
    const harness = buildCloudHarness();
    await openVaultWithPhotos(harness, '2468', 1);
    await harness.cloud.signUp(EMAIL, ACCOUNT_PASSWORD);
    const putDocument = jest.spyOn(harness.cloud, 'putDocument');

    await renderWithServices(harness.services, <CloudBackupScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('backup_enable')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('backup_enable'));
    await fireEvent.changeText(screen.getByTestId('backup_passphrase'), PASSPHRASE);
    await fireEvent.changeText(screen.getByTestId('backup_passphrase_confirm'), `${PASSPHRASE}!`);
    await fireEvent.press(screen.getByTestId('backup_passphrase_submit'));

    expect(screen.getByTestId('backup_error')).toHaveTextContent(/do not match/);
    expect(putDocument).not.toHaveBeenCalled();
  });

  it('warns about losing the passphrase before it will enable anything', async () => {
    const harness = buildCloudHarness();
    await openVaultWithPhotos(harness, '2468', 1);
    await harness.cloud.signUp(EMAIL, ACCOUNT_PASSWORD);

    await renderWithServices(harness.services, <CloudBackupScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('backup_enable')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('backup_enable'));

    expect(screen.getByTestId('backup_passphrase_warning')).toHaveTextContent(
      /permanently unreadable/,
    );
    expect(screen.getByTestId('backup_passphrase_warning')).toHaveTextContent(/cannot be reset/);
  });

  it('enables backup without putting the vault in the cloud', async () => {
    const harness = buildCloudHarness();
    await openVaultWithPhotos(harness, '2468', 2);
    const user = await harness.cloud.signUp(EMAIL, ACCOUNT_PASSWORD);

    await renderWithServices(harness.services, <CloudBackupScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('backup_enable')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('backup_enable'));
    await fireEvent.changeText(screen.getByTestId('backup_passphrase'), PASSPHRASE);
    await fireEvent.changeText(screen.getByTestId('backup_passphrase_confirm'), PASSPHRASE);
    await fireEvent.press(screen.getByTestId('backup_passphrase_submit'));

    await waitFor(() => {
      expect(screen.getByTestId('backup_now')).toBeTruthy();
    });
    expect(harness.cloud.documents.has(BACKUP_PATHS.envelope(user.uid))).toBe(true);
    expect(harness.services.settings.current.backupEnabled).toBe(true);

    await fireEvent.press(screen.getByTestId('backup_now'));

    // Enabling is not consent to upload: nothing has been chosen, so nothing goes.
    await waitFor(() => {
      expect(screen.getByTestId('backup_nothing_dialog')).toHaveTextContent(
        /Nothing has been added to the Cloud Gallery yet/,
      );
    });
    await fireEvent.press(screen.getByTestId('backup_nothing_dialog-confirm'));
    expect(harness.cloud.blobs.has(BACKUP_PATHS.index(user.uid))).toBe(true);
    expect(harness.services.settings.current.lastBackupAt).toBe(harness.clock.now());
    expect(screen.getByTestId('backup_last_backup')).toHaveTextContent(/Last backup:/);

    // Disabling deletes everything in the cloud but leaves the local vault alone.
    await fireEvent.press(screen.getByTestId('backup_disable'));
    await fireEvent.press(screen.getByTestId('backup_disable_dialog-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('backup_status')).toHaveTextContent(
        /everything it held was deleted/,
      );
    });
    expect(harness.cloud.documents.size).toBe(0);
    expect(harness.cloud.blobs.size).toBe(0);
    expect(harness.services.settings.current.backupEnabled).toBe(false);
    expect(harness.services.vault.current?.photos).toHaveLength(2);
  });

  it('reports a wrong account password in plain language', async () => {
    const harness = buildCloudHarness();
    await harness.cloud.signUp(EMAIL, ACCOUNT_PASSWORD);
    await harness.cloud.signOut();

    await renderWithServices(harness.services, <CloudBackupScreen />);

    await fireEvent.changeText(screen.getByTestId('backup_email'), EMAIL);
    await fireEvent.changeText(screen.getByTestId('backup_password'), 'not-the-password');
    await fireEvent.press(screen.getByTestId('backup_sign_in'));

    await waitFor(() => {
      expect(screen.getByTestId('backup_error')).toHaveTextContent(/Wrong email or password/);
    });
  });
});

/**
 * The account flow end to end, and the two things that must hold around it: nothing can be
 * uploaded before an account exists, and no account at all still leaves a working vault.
 */
describe('CloudBackupScreen account flow', () => {
  const NEW_EMAIL = 'fresh@example.test';

  it('registers an account and keeps every written byte under that uid', async () => {
    const harness = buildCloudHarness();
    await openVaultWithPhotos(harness, '2468', 2);

    await renderWithServices(harness.services, <CloudBackupScreen />);

    // Register. There is no account yet, so this is the "Create account" path.
    await fireEvent.changeText(screen.getByTestId('backup_email'), NEW_EMAIL);
    await fireEvent.changeText(screen.getByTestId('backup_password'), ACCOUNT_PASSWORD);
    await fireEvent.press(screen.getByTestId('backup_sign_up'));

    await waitFor(() => {
      expect(screen.getByTestId('backup_enable')).toBeTruthy();
    });
    const user = harness.cloud.currentUser;
    if (user === null) throw new Error('registration did not sign the account in');
    expect(user.email).toBe(NEW_EMAIL);

    // Enable: the recovery passphrase, not the account password, is what wraps the key.
    await fireEvent.press(screen.getByTestId('backup_enable'));
    await fireEvent.changeText(screen.getByTestId('backup_passphrase'), PASSPHRASE);
    await fireEvent.changeText(screen.getByTestId('backup_passphrase_confirm'), PASSPHRASE);
    await fireEvent.press(screen.getByTestId('backup_passphrase_submit'));

    await waitFor(() => {
      expect(screen.getByTestId('backup_now')).toBeTruthy();
    });

    // Choosing both for the cloud, which is now the only way anything goes up.
    const repository = harness.services.vault.current;
    const backupService = harness.services.backup;
    if (repository === null || backupService === null) throw new Error('no vault or backup');
    await backupService.backupNow(repository, harness.services.session.requireKeys(), {
      ids: repository.photos.map((photo) => photo.id),
    });

    // Everything that was written is addressed to this account and nothing else.
    const written = [...harness.cloud.blobs.keys(), ...harness.cloud.documents.keys()];
    expect(written.length).toBeGreaterThan(0);
    for (const key of written) {
      expect(key.startsWith(`users/${user.uid}/`)).toBe(true);
    }

    // And what went up is ciphertext: no stored blob carries a JPEG signature.
    for (const bytes of harness.cloud.blobs.values()) {
      expect(bytes[0] === 0xff && bytes[1] === 0xd8).toBe(false);
    }
  });

  it('offers nothing to upload until an account is signed in', async () => {
    const harness = buildCloudHarness();
    await openVaultWithPhotos(harness, '2468', 1);

    await renderWithServices(harness.services, <CloudBackupScreen />);

    expect(screen.getByTestId('backup_sign_in')).toBeTruthy();
    expect(screen.queryByTestId('backup_enable')).toBeNull();
    expect(screen.queryByTestId('backup_now')).toBeNull();
    expect(harness.cloud.blobs.size).toBe(0);
    expect(harness.cloud.documents.size).toBe(0);
  });

  it('leaves the vault completely usable when there is no Firebase at all', async () => {
    const harness = buildHarness();
    await openVaultWithPhotos(harness, '2468', 2);
    expect(harness.services.firebase.available).toBe(false);
    expect(harness.services.backup).toBeNull();

    await renderWithServices(harness.services, <CloudBackupScreen />);
    expect(screen.getByTestId('backup_unavailable')).toBeTruthy();

    // The photos are still there, and the PIN still opens the vault with no cloud layer present.
    expect(harness.services.vault.current?.photos).toHaveLength(2);
    harness.services.session.lock();
    expect((await harness.services.auth.unlock('2468')).kind).toBe('success');
  });
});

/**
 * Regressions from a real failure on device: two taps on "Create account" 1.1s apart, the second
 * one carrying an already-cleared password, surfacing as the generic "reported a problem" line.
 */
describe('CloudBackupScreen account form', () => {
  it('sends one request however fast the button is pressed twice', async () => {
    const harness = buildCloudHarness();
    const signUp = jest.spyOn(harness.cloud, 'signUp');
    await renderWithServices(harness.services, <CloudBackupScreen />);

    await fireEvent.changeText(screen.getByTestId('backup_email'), EMAIL);
    await fireEvent.changeText(screen.getByTestId('backup_password'), ACCOUNT_PASSWORD);

    // Both presses land before any state flush, which is what a double tap actually does.
    const button = screen.getByTestId('backup_sign_up');
    await act(async () => {
      fireEvent.press(button);
      fireEvent.press(button);
    });

    await waitFor(() => {
      expect(screen.getByTestId('backup_enable')).toBeTruthy();
    });
    expect(signUp).toHaveBeenCalledTimes(1);
  });

  it('refuses an empty password without asking the server about it', async () => {
    const harness = buildCloudHarness();
    const signIn = jest.spyOn(harness.cloud, 'signIn');
    await renderWithServices(harness.services, <CloudBackupScreen />);

    await fireEvent.changeText(screen.getByTestId('backup_email'), EMAIL);
    await fireEvent.press(screen.getByTestId('backup_sign_in'));

    // Names the field that is actually missing; the combined sentence this replaced could not
    // change between two presses, which made a working button look disabled.
    expect(screen.getByTestId('backup_error')).toHaveTextContent(
      /Enter the password for the backup account/,
    );
    expect(signIn).not.toHaveBeenCalled();
  });

  it('keeps the typed password when the attempt fails, so trying again retries it', async () => {
    const harness = buildCloudHarness();
    await harness.cloud.signUp(EMAIL, ACCOUNT_PASSWORD);
    await harness.cloud.signOut();
    await renderWithServices(harness.services, <CloudBackupScreen />);

    await fireEvent.changeText(screen.getByTestId('backup_email'), EMAIL);
    await fireEvent.changeText(screen.getByTestId('backup_password'), 'wrong-password');
    await fireEvent.press(screen.getByTestId('backup_sign_in'));

    await waitFor(() => {
      expect(screen.getByTestId('backup_error')).toHaveTextContent(/Wrong email or password/);
    });
    // The field still holds what was typed: an empty one would send an empty password next press.
    expect(screen.getByTestId('backup_password').props.value).toBe('wrong-password');
  });

  it('clears the password once it has actually been used', async () => {
    const harness = buildCloudHarness();
    await renderWithServices(harness.services, <CloudBackupScreen />);

    await fireEvent.changeText(screen.getByTestId('backup_email'), EMAIL);
    await fireEvent.changeText(screen.getByTestId('backup_password'), ACCOUNT_PASSWORD);
    await fireEvent.press(screen.getByTestId('backup_sign_up'));

    await waitFor(() => {
      expect(screen.getByTestId('backup_enable')).toBeTruthy();
    });
    expect(screen.queryByTestId('backup_password')).toBeNull();
  });
});

/**
 * Restoring INTO a vault that is already open, which is a different problem from restoring onto a
 * bare device (`RestoreFlowScreen`). Here there is already a master key in play, and the danger is
 * not a lost passphrase but a *right* passphrase belonging to the wrong vault: those blobs would
 * be noise to this vault. So the assertions are mostly about what does not happen -- nothing
 * downloaded, nothing deleted, nothing overwritten -- with one test for the case that works.
 */
describe('CloudBackupScreen restore', () => {
  const PIN = '2468';

  function requireBackup(harness: CloudHarness): BackupService {
    const backup = harness.services.backup;
    if (backup === null) throw new Error('expected a backup service');
    return backup;
  }

  function requireRepository(harness: CloudHarness): VaultRepository {
    const repository = harness.services.vault.current;
    if (repository === null) throw new Error('expected an open vault');
    return repository;
  }

  /** An open vault with `count` photos, signed in, enabled, and already uploaded. */
  async function deviceWithBackup(harness: CloudHarness, count: number): Promise<VaultRepository> {
    await openVaultWithPhotos(harness, PIN, count);
    await harness.cloud.signUp(EMAIL, ACCOUNT_PASSWORD);
    const backup = requireBackup(harness);
    await backup.enable(harness.services.session.requireKeys(), PASSPHRASE);
    const repository = requireRepository(harness);
    await backup.backupNow(repository, harness.services.session.requireKeys());
    return repository;
  }

  /** Opens the restore form and submits `passphrase`. */
  async function restoreWith(passphrase: string): Promise<void> {
    await waitFor(() => {
      expect(screen.getByTestId('backup_restore')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('backup_restore'));
    await fireEvent.changeText(screen.getByTestId('backup_restore_passphrase'), passphrase);
    await fireEvent.press(screen.getByTestId('backup_restore_submit'));
  }

  it('downloads what is missing and leaves what is already here alone', async () => {
    const harness = buildCloudHarness();
    const repository = await deviceWithBackup(harness, 2);
    const [removed] = repository.photos;
    if (removed === undefined) throw new Error('expected a photo to remove');
    await repository.deletePhotos([removed.id]);
    expect(repository.photos).toHaveLength(1);

    await renderWithServices(harness.services, <CloudBackupScreen />);
    await restoreWith(PASSPHRASE);

    await waitFor(() => {
      expect(screen.getByTestId('backup_status')).toHaveTextContent(/Restored 1 photo/);
    });
    // The one still on the device was skipped rather than downloaded again or replaced.
    expect(screen.getByTestId('backup_status')).toHaveTextContent(
      /1 photo already on this device, left untouched/,
    );
    expect(repository.photos).toHaveLength(2);
    expect(repository.photos.map((photo) => photo.id)).toContain(removed.id);
  });

  it('is safe to run twice: the second time changes nothing', async () => {
    const harness = buildCloudHarness();
    const repository = await deviceWithBackup(harness, 2);

    await renderWithServices(harness.services, <CloudBackupScreen />);
    await restoreWith(PASSPHRASE);

    await waitFor(() => {
      expect(screen.getByTestId('backup_status')).toHaveTextContent(/Restored 0 photos/);
    });
    expect(screen.getByTestId('backup_status')).toHaveTextContent(/2 photos already on this device/);
    expect(repository.photos).toHaveLength(2);
  });

  it('downloads nothing when the recovery passphrase is wrong', async () => {
    const harness = buildCloudHarness();
    const repository = await deviceWithBackup(harness, 2);
    const getBlob = jest.spyOn(harness.cloud, 'getBlob');

    await renderWithServices(harness.services, <CloudBackupScreen />);
    await restoreWith('not the passphrase at all');

    await waitFor(() => {
      expect(screen.getByTestId('backup_error')).toHaveTextContent(/Wrong recovery passphrase/);
    });
    // The envelope is a document read; a blob read would mean a download had started.
    expect(getBlob).not.toHaveBeenCalled();
    expect(repository.photos).toHaveLength(2);
  });

  /**
   * The case the whole feature exists for: a backup made by a vault that no longer exists, which
   * is the ordinary state of affairs after a wipe, a forgotten PIN or a new phone. The right
   * passphrase has to be enough. Refusing here -- which is what this used to do -- told someone
   * holding the correct secret that their photos were unreachable, which was simply untrue.
   */
  it('restores a backup that belongs to an earlier vault, keeping this one intact', async () => {
    const cloud = new InMemoryCloudBackend();
    const source = buildCloudHarness(cloud);
    const sourceRepository = await deviceWithBackup(source, 2);
    const backedUpIds = sourceRepository.photos.map((photo) => photo.id);
    source.services.session.lock();
    await cloud.signOut();

    // Same account, same passphrase -- but a vault set up separately, so a different master key.
    const other = buildCloudHarness(cloud);
    await openVaultWithPhotos(other, '1357', 1);
    await cloud.signIn(EMAIL, ACCOUNT_PASSWORD);
    const repository = requireRepository(other);
    const own = repository.photos[0]?.id;

    await renderWithServices(other.services, <CloudBackupScreen />);
    await restoreWith(PASSPHRASE);

    await waitFor(() => {
      expect(screen.getByTestId('backup_status')).toHaveTextContent(/Restored 2 photos/);
    });
    expect(screen.getByTestId('backup_status')).toHaveTextContent(/re-encrypted for this one/);

    // Both backed-up photos arrived, with their ids, and this vault's own photo is still here.
    expect(new Set(repository.photos.map((photo) => photo.id))).toEqual(
      new Set([...backedUpIds, own]),
    );
    // Readable under THIS vault's keys, which is the point of re-encrypting rather than refusing.
    for (const id of backedUpIds) await expect(repository.readThumbnail(id)).resolves.toBeDefined();
  });

  /**
   * A foreign restore used to re-point the account at this vault on its own, and that was the
   * cross-account leak: it re-uploaded the WHOLE device vault -- including photos belonging to
   * whichever other account had backed them up -- and rewrapped this account's envelope around
   * this device's master key. It now offers, and changes nothing until asked.
   */
  it('offers to move the backup rather than moving it', async () => {
    const cloud = new InMemoryCloudBackend();
    const source = buildCloudHarness(cloud);
    await deviceWithBackup(source, 2);
    source.services.session.lock();
    await cloud.signOut();

    const other = buildCloudHarness(cloud);
    await openVaultWithPhotos(other, '1357', 1);
    await cloud.signIn(EMAIL, ACCOUNT_PASSWORD);
    const uid = cloud.currentUser?.uid ?? '';
    const envelopeBefore = await cloud.getDocument(BACKUP_PATHS.envelope(uid));
    const blobsBefore = [...cloud.blobs.keys()].sort();

    await renderWithServices(other.services, <CloudBackupScreen />);
    await restoreWith(PASSPHRASE);
    await waitFor(() => {
      expect(screen.getByTestId('backup_status')).toHaveTextContent(/Restored 2 photos/);
    });

    // The photos arrived, and the account is untouched: same envelope, same blobs.
    expect(screen.getByTestId('backup_rebind_offer')).toBeTruthy();
    expect(await cloud.getDocument(BACKUP_PATHS.envelope(uid))).toEqual(envelopeBefore);
    expect([...cloud.blobs.keys()].sort()).toEqual(blobsBefore);
  });

  it('moves it once the move is typed out, and uploads only the account\'s own photos', async () => {
    const cloud = new InMemoryCloudBackend();
    const source = buildCloudHarness(cloud);
    await deviceWithBackup(source, 2);
    source.services.session.lock();
    await cloud.signOut();

    const other = buildCloudHarness(cloud);
    await openVaultWithPhotos(other, '1357', 1);
    await cloud.signIn(EMAIL, ACCOUNT_PASSWORD);
    const uid = cloud.currentUser?.uid ?? '';
    const repository = requireRepository(other);
    // The photo this device already had. It belongs to this vault, not to this account.
    const localOnly = repository.photos.map((photo) => photo.id);

    await renderWithServices(other.services, <CloudBackupScreen />);
    await restoreWith(PASSPHRASE);
    await waitFor(() => {
      expect(screen.getByTestId('backup_rebind_offer')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('backup_rebind'));
    await fireEvent.changeText(screen.getByTestId('typed-confirm-input'), 'MOVE');
    await fireEvent.press(screen.getByTestId('backup_rebind_dialog-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('backup_status')).toHaveTextContent(/now owns the backup/);
    });

    // The two photos the account already had were re-uploaded; the one this device brought was
    // not. That is the whole distinction the old code collapsed.
    const uploaded = [...cloud.blobs.keys()]
      .filter((key) => key.startsWith(`users/${uid}/photos/`))
      .map((key) => key.split('/').pop()?.replace('.enc', '') ?? '');
    expect(uploaded).toHaveLength(2);
    for (const id of localOnly) expect(uploaded).not.toContain(id);

    // And the account is usable again on this vault's key, with the same passphrase.
    const backup = requireBackup(other);
    const keys = other.services.session.requireKeys();
    await expect(backup.backupNow(repository, keys)).resolves.toBeDefined();
    expect(await backup.recoverMasterKey(PASSPHRASE)).toEqual(keys.masterKey);
  });

  /**
   * A backup holding no photos is a real shape, and the one most likely to be restored by someone
   * who only wants their messages back.
   *
   * The offer belongs there: `rebindBackup` with no ids still writes the index and manifest and
   * still calls `enable`, which rewraps the envelope around this vault's key -- and that, not the
   * uploading, is the operation. Without it the three ownership gates refuse every future backup
   * from this device, so suppressing the offer would strand this user for good.
   *
   * What it must not do is describe itself by counting photos. It used to offer to re-upload
   * photos there were none of, then ask for MOVE to be typed under the words "0 photos", then
   * report that "0 photos were re-uploaded" -- three chances to read a working feature as broken.
   */
  it('offers an empty backup without promising photos, and still moves it', async () => {
    const cloud = new InMemoryCloudBackend();
    const source = buildCloudHarness(cloud);
    await deviceWithBackup(source, 0);
    source.services.session.lock();
    await cloud.signOut();

    const other = buildCloudHarness(cloud);
    await openVaultWithPhotos(other, '1357', 1);
    await cloud.signIn(EMAIL, ACCOUNT_PASSWORD);

    await renderWithServices(other.services, <CloudBackupScreen />);
    await restoreWith(PASSPHRASE);

    const offer = await waitFor(() => screen.getByTestId('backup_rebind_offer'));
    expect(offer).toHaveTextContent(/holds no photos/);
    expect(offer).not.toHaveTextContent(/re-uploads its own photos/);

    await fireEvent.press(screen.getByTestId('backup_rebind'));
    const dialog = screen.getByTestId('backup_rebind_dialog');
    expect(dialog).toHaveTextContent(/holds no photos/);
    expect(dialog).not.toHaveTextContent(/0 photos/);

    await fireEvent.changeText(screen.getByTestId('typed-confirm-input'), 'MOVE');
    await fireEvent.press(screen.getByTestId('backup_rebind_dialog-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('backup_status')).toHaveTextContent(/held no photos/);
    });
    expect(screen.getByTestId('backup_status')).not.toHaveTextContent(/0 photos/);

    // Why the offer was worth making: the account now follows this vault, so the ownership gate
    // no longer refuses a backup from this device.
    const backup = requireBackup(other);
    const keys = other.services.session.requireKeys();
    expect(await backup.recoverMasterKey(PASSPHRASE)).toEqual(keys.masterKey);
    await expect(backup.backupNow(requireRepository(other), keys)).resolves.toBeDefined();
  });

  it('will not restore into a vault that is not open', async () => {
    const harness = buildCloudHarness();
    await deviceWithBackup(harness, 1);
    await harness.services.vault.close();
    harness.services.session.lock();
    const getBlob = jest.spyOn(harness.cloud, 'getBlob');

    await renderWithServices(harness.services, <CloudBackupScreen />);
    await restoreWith(PASSPHRASE);

    await waitFor(() => {
      expect(screen.getByTestId('backup_error')).toHaveTextContent(/Open the vault first/);
    });
    expect(getBlob).not.toHaveBeenCalled();
  });

  it('alerts rather than whispering when nothing needs repairing', async () => {
    const harness = buildCloudHarness();
    await deviceWithBackup(harness, 2);
    const putBlob = jest.spyOn(harness.cloud, 'putBlob');

    await renderWithServices(harness.services, <CloudBackupScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('backup_now')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('backup_now'));

    // A dialog, not a status line: "nothing happened" in small type under a button reads exactly
    // like a button that did not work, and not being sure is why people press this twice.
    const dialog = await waitFor(() => screen.getByTestId('backup_nothing_dialog'));
    expect(dialog).toHaveTextContent(/are backed up/);
    expect(dialog).toHaveTextContent(/Nothing needed repairing/);
    expect(screen.queryByTestId('backup_status')).toBeNull();
    // Only the index and manifest are rewritten; no photo or thumbnail was re-uploaded.
    expect(putBlob.mock.calls.every(([path]) => path.endsWith('index.enc'))).toBe(true);

    await fireEvent.press(screen.getByTestId('backup_nothing_dialog-confirm'));
    await waitFor(() => {
      expect(screen.queryByTestId('backup_nothing_dialog')).toBeNull();
    });
  });

  /**
   * The outcome that used to be indistinguishable from success. An item whose cloud files have
   * gone AND whose local copy has gone cannot be repaired by anything on this screen, so a run
   * that uploaded nothing for that reason must not be handed back as a clean bill of health.
   */
  it('refuses to call a loss "nothing needed repairing"', async () => {
    const harness = buildCloudHarness();
    const repository = await deviceWithBackup(harness, 2);
    const uid = harness.cloud.currentUser?.uid ?? '';
    const gone = repository.photos[0]?.id;
    if (gone === undefined) throw new Error('expected a photo');
    harness.cloud.blobs.delete(BACKUP_PATHS.photo(uid, gone));
    harness.cloud.blobs.delete(BACKUP_PATHS.thumb(uid, gone));
    await repository.deletePhotos([gone]);

    await renderWithServices(harness.services, <CloudBackupScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('backup_now')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('backup_now'));

    const dialog = await waitFor(() => screen.getByTestId('backup_nothing_dialog'));
    expect(dialog).toHaveTextContent(/could not be put back/);
    expect(dialog).toHaveTextContent(/no copy either/);
    expect(dialog).not.toHaveTextContent(/Nothing needed repairing/);
  });

  /** The repairable half is still repaired, and the loss is reported beside it rather than instead. */
  it('repairs what it can and still reports what it could not', async () => {
    const harness = buildCloudHarness();
    const repository = await deviceWithBackup(harness, 3);
    const uid = harness.cloud.currentUser?.uid ?? '';
    const ids = repository.photos.map((photo) => photo.id);
    const fixable = ids[0];
    const lost = ids[1];
    if (fixable === undefined || lost === undefined) throw new Error('expected photos');
    harness.cloud.blobs.delete(BACKUP_PATHS.photo(uid, fixable));
    harness.cloud.blobs.delete(BACKUP_PATHS.photo(uid, lost));
    harness.cloud.blobs.delete(BACKUP_PATHS.thumb(uid, lost));
    await repository.deletePhotos([lost]);

    await renderWithServices(harness.services, <CloudBackupScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('backup_now')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('backup_now'));

    await waitFor(() => {
      expect(screen.getByTestId('backup_status')).toHaveTextContent(/Restored 1 item/);
    });
    expect(screen.getByTestId('backup_status')).toHaveTextContent(/could not be put back/);
  });

  it('says plainly that nothing has been chosen for the cloud yet', async () => {
    const harness = buildCloudHarness();
    await openVaultWithPhotos(harness, PIN, 0);
    await harness.cloud.signUp(EMAIL, ACCOUNT_PASSWORD);
    await requireBackup(harness).enable(harness.services.session.requireKeys(), PASSPHRASE);

    await renderWithServices(harness.services, <CloudBackupScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('backup_now')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('backup_now'));

    await waitFor(() => {
      expect(screen.getByTestId('backup_nothing_dialog')).toHaveTextContent(
        /Nothing has been added to the Cloud Gallery yet/,
      );
    });
  });

  /**
   * The rule the opt-in model rests on: a photo added to the vault AFTER the cloud set was
   * chosen is not swept in by pressing this. The Local Gallery is unlimited and private, and
   * one tap here must never quietly turn that into an upload.
   */
  it('never sweeps in a photo that was not chosen for the cloud', async () => {
    const harness = buildCloudHarness();
    const repository = await deviceWithBackup(harness, 2);
    const added = await repository.addPhoto(
      { bytes: new Uint8Array(512).fill(7) },
      { source: 'import' },
    );
    const deleteBlob = jest.spyOn(harness.cloud, 'deleteBlob');

    await renderWithServices(harness.services, <CloudBackupScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('backup_now')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('backup_now'));

    await waitFor(() => {
      expect(screen.getByTestId('backup_nothing_dialog')).toHaveTextContent(
        /are backed up/,
      );
    });
    const uid = harness.cloud.currentUser?.uid ?? '';
    // The new photo is in the vault and nowhere else.
    expect(repository.photos.some((photo) => photo.id === added.id)).toBe(true);
    expect(harness.cloud.blobs.has(BACKUP_PATHS.photo(uid, added.id))).toBe(false);
    expect(deleteBlob).not.toHaveBeenCalled();
  });

  it('offers no restore until this account actually has a backup', async () => {
    const harness = buildCloudHarness();
    await openVaultWithPhotos(harness, PIN, 1);
    await harness.cloud.signUp(EMAIL, ACCOUNT_PASSWORD);

    await renderWithServices(harness.services, <CloudBackupScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('backup_enable')).toBeTruthy();
    });
    expect(screen.queryByTestId('backup_restore')).toBeNull();
  });
});

/**
 * Deleting the backup account.
 *
 * The ordering is the whole point and it is asserted directly: the stored backup goes first, while
 * the credential that authorises those deletes still exists, and only then the account. Reversed,
 * the documents and blobs would survive under a uid nobody can ever authenticate as again.
 */
describe('CloudBackupScreen delete account', () => {
  it('deletes the stored backup and then the account, leaving the vault alone', async () => {
    const harness = buildCloudHarness();
    await openVaultWithPhotos(harness, '2468', 2);
    const user = await harness.cloud.signUp(EMAIL, ACCOUNT_PASSWORD);

    await renderWithServices(harness.services, <CloudBackupScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('backup_enable')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('backup_enable'));
    await fireEvent.changeText(screen.getByTestId('backup_passphrase'), PASSPHRASE);
    await fireEvent.changeText(screen.getByTestId('backup_passphrase_confirm'), PASSPHRASE);
    await fireEvent.press(screen.getByTestId('backup_passphrase_submit'));
    await waitFor(() => {
      expect(screen.getByTestId('backup_now')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('backup_now'));
    await waitFor(() => {
      expect(harness.cloud.blobs.has(BACKUP_PATHS.index(user.uid))).toBe(true);
    });

    await fireEvent.press(screen.getByTestId('backup_delete_account'));
    await fireEvent.changeText(screen.getByTestId('backup_delete_password'), ACCOUNT_PASSWORD);
    await fireEvent.press(screen.getByTestId('backup_delete_submit'));
    await fireEvent.changeText(screen.getByTestId('typed-confirm-input'), 'DELETE');
    await fireEvent.press(screen.getByTestId('backup_delete_account_dialog-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('backup_status')).toHaveTextContent(
        /were deleted\. The vault on this device is untouched/,
      );
    });

    // Nothing of the account survives: no blobs, no documents, no credential to sign back in with.
    expect(harness.cloud.blobs.size).toBe(0);
    expect(harness.cloud.documents.size).toBe(0);
    expect(harness.cloud.currentUser).toBeNull();
    expect(harness.cloud.passwordFor(EMAIL)).toBeUndefined();
    expect(harness.services.settings.current.backupEnabled).toBe(false);
    expect(harness.services.settings.current.lastBackupAt).toBeNull();

    // The vault is local and was never in reach of that account.
    expect(harness.services.vault.current?.photos).toHaveLength(2);
    await waitFor(() => {
      expect(screen.getByTestId('backup_email')).toBeTruthy();
    });
  });

  it('leaves the account standing when the stored backup could not be cleared', async () => {
    const harness = buildCloudHarness();
    await openVaultWithPhotos(harness, '2468', 1);
    await harness.cloud.signUp(EMAIL, ACCOUNT_PASSWORD);

    const backup = harness.services.backup as BackupService;
    jest.spyOn(backup, 'purgeAccount').mockRejectedValue(new CloudError('unavailable'));
    const deleteAccount = jest.spyOn(harness.cloud, 'deleteAccount');

    await renderWithServices(harness.services, <CloudBackupScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('backup_delete_account')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('backup_delete_account'));
    await fireEvent.changeText(screen.getByTestId('backup_delete_password'), ACCOUNT_PASSWORD);
    await fireEvent.press(screen.getByTestId('backup_delete_submit'));
    await fireEvent.changeText(screen.getByTestId('typed-confirm-input'), 'DELETE');
    await fireEvent.press(screen.getByTestId('backup_delete_account_dialog-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('backup_error')).toHaveTextContent(/unreachable right now/);
    });
    // The credential outlives the failure on purpose: it is the only thing that can retry.
    expect(deleteAccount).not.toHaveBeenCalled();
    expect(harness.cloud.currentUser).not.toBeNull();
    expect(harness.cloud.passwordFor(EMAIL)).toBe(ACCOUNT_PASSWORD);
  });

  it('will not act on a confirmation phrase that was not typed correctly', async () => {
    const harness = buildCloudHarness();
    await openVaultWithPhotos(harness, '2468', 1);
    await harness.cloud.signUp(EMAIL, ACCOUNT_PASSWORD);
    const deleteAccount = jest.spyOn(harness.cloud, 'deleteAccount');

    await renderWithServices(harness.services, <CloudBackupScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('backup_delete_account')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('backup_delete_account'));
    await fireEvent.changeText(screen.getByTestId('backup_delete_password'), ACCOUNT_PASSWORD);
    await fireEvent.press(screen.getByTestId('backup_delete_submit'));
    await fireEvent.changeText(screen.getByTestId('typed-confirm-input'), 'delete please');
    await fireEvent.press(screen.getByTestId('backup_delete_account_dialog-confirm'));

    expect(deleteAccount).not.toHaveBeenCalled();
    expect(harness.cloud.passwordFor(EMAIL)).toBe(ACCOUNT_PASSWORD);
  });

  it('offers account deletion to an account that never had a backup', async () => {
    const harness = buildCloudHarness();
    await harness.cloud.signUp(EMAIL, ACCOUNT_PASSWORD);

    await renderWithServices(harness.services, <CloudBackupScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('backup_delete_account')).toBeTruthy();
    });
    // Nothing to turn off, so that button is absent; the account can still be removed.
    expect(screen.queryByTestId('backup_disable')).toBeNull();
  });
});

describe('CloudBackupScreen delete account keeps the account when data survives', () => {
  it('reports the leftovers and does not delete the credential that could still remove them', async () => {
    const harness = buildCloudHarness();
    await openVaultWithPhotos(harness, '2468', 1);
    await harness.cloud.signUp(EMAIL, ACCOUNT_PASSWORD);

    const backup = harness.services.backup as BackupService;
    jest.spyOn(backup, 'purgeAccount').mockRejectedValue(new AccountDataRemainsError(2));
    const deleteAccount = jest.spyOn(harness.cloud, 'deleteAccount');

    await renderWithServices(harness.services, <CloudBackupScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('backup_delete_account')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('backup_delete_account'));
    await fireEvent.changeText(screen.getByTestId('backup_delete_password'), ACCOUNT_PASSWORD);
    await fireEvent.press(screen.getByTestId('backup_delete_submit'));
    await fireEvent.changeText(screen.getByTestId('typed-confirm-input'), 'DELETE');
    await fireEvent.press(screen.getByTestId('backup_delete_account_dialog-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('backup_error')).toHaveTextContent(
        /could not be deleted \(2 left\), so the account was kept/,
      );
    });
    expect(deleteAccount).not.toHaveBeenCalled();
    expect(harness.cloud.passwordFor(EMAIL)).toBe(ACCOUNT_PASSWORD);
  });
});

/**
 * Regression cover for the failure seen on a real device on 2026-09-18.
 *
 * The purge ran, every photo and both documents were deleted, and only then did Firebase refuse to
 * delete the account because the sign-in was a few minutes old. The screen showed "Sign in to your
 * backup account first." above the signed-in address. Both halves are pinned here: the password is
 * proved before anything is destroyed, and a stale session never produces the sign-in message.
 */
describe('CloudBackupScreen delete account and a stale session', () => {
  it('stops on a wrong account password with the backup completely intact', async () => {
    const harness = buildCloudHarness();
    await openVaultWithPhotos(harness, '2468', 2);
    const user = await harness.cloud.signUp(EMAIL, ACCOUNT_PASSWORD);
    await renderWithServices(harness.services, <CloudBackupScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('backup_enable')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('backup_enable'));
    await fireEvent.changeText(screen.getByTestId('backup_passphrase'), PASSPHRASE);
    await fireEvent.changeText(screen.getByTestId('backup_passphrase_confirm'), PASSPHRASE);
    await fireEvent.press(screen.getByTestId('backup_passphrase_submit'));
    await waitFor(() => {
      expect(screen.getByTestId('backup_now')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('backup_now'));
    await waitFor(() => {
      expect(harness.cloud.blobs.has(BACKUP_PATHS.index(user.uid))).toBe(true);
    });
    const blobsBefore = harness.cloud.blobs.size;

    await fireEvent.press(screen.getByTestId('backup_delete_account'));
    await fireEvent.changeText(screen.getByTestId('backup_delete_password'), 'not-the-password');
    await fireEvent.press(screen.getByTestId('backup_delete_submit'));
    await fireEvent.changeText(screen.getByTestId('typed-confirm-input'), 'DELETE');
    await fireEvent.press(screen.getByTestId('backup_delete_account_dialog-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('backup_error')).toHaveTextContent(/Wrong email or password/);
    });
    // The whole point of proving the password first: nothing was deleted.
    expect(harness.cloud.blobs.size).toBe(blobsBefore);
    expect(harness.cloud.documents.has(BACKUP_PATHS.envelope(user.uid))).toBe(true);
    expect(harness.cloud.passwordFor(EMAIL)).toBe(ACCOUNT_PASSWORD);
  });

  it('deletes everything once the password is re-proved on a stale session', async () => {
    const harness = buildCloudHarness();
    await openVaultWithPhotos(harness, '2468', 2);
    const user = await harness.cloud.signUp(EMAIL, ACCOUNT_PASSWORD);
    await renderWithServices(harness.services, <CloudBackupScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('backup_enable')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('backup_enable'));
    await fireEvent.changeText(screen.getByTestId('backup_passphrase'), PASSPHRASE);
    await fireEvent.changeText(screen.getByTestId('backup_passphrase_confirm'), PASSPHRASE);
    await fireEvent.press(screen.getByTestId('backup_passphrase_submit'));
    await waitFor(() => {
      expect(screen.getByTestId('backup_now')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('backup_now'));
    await waitFor(() => {
      expect(harness.cloud.blobs.has(BACKUP_PATHS.index(user.uid))).toBe(true);
    });

    // Exactly the device's situation: signed in, but the sign-in is old.
    harness.cloud.expireRecentLogin();

    await fireEvent.press(screen.getByTestId('backup_delete_account'));
    await fireEvent.changeText(screen.getByTestId('backup_delete_password'), ACCOUNT_PASSWORD);
    await fireEvent.press(screen.getByTestId('backup_delete_submit'));
    await fireEvent.changeText(screen.getByTestId('typed-confirm-input'), 'DELETE');
    await fireEvent.press(screen.getByTestId('backup_delete_account_dialog-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('backup_status')).toHaveTextContent(/were deleted/);
    });
    expect(harness.cloud.blobs.size).toBe(0);
    expect(harness.cloud.documents.size).toBe(0);
    expect(harness.cloud.passwordFor(EMAIL)).toBeUndefined();
    expect(harness.services.vault.current?.photos).toHaveLength(2);
  });

  it('never tells a signed-in user to sign in when the session is merely stale', async () => {
    const harness = buildCloudHarness();
    await openVaultWithPhotos(harness, '2468', 1);
    await harness.cloud.signUp(EMAIL, ACCOUNT_PASSWORD);
    // A session that goes stale between the re-auth and the delete: the narrow window the copy has
    // to survive. Reauthenticating no longer helps, so the message must not say "sign in first".
    jest.spyOn(harness.cloud, 'reauthenticate').mockResolvedValue(undefined);

    await renderWithServices(harness.services, <CloudBackupScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('backup_delete_account')).toBeTruthy();
    });
    harness.cloud.expireRecentLogin();

    await fireEvent.press(screen.getByTestId('backup_delete_account'));
    await fireEvent.changeText(screen.getByTestId('backup_delete_password'), ACCOUNT_PASSWORD);
    await fireEvent.press(screen.getByTestId('backup_delete_submit'));
    await fireEvent.changeText(screen.getByTestId('typed-confirm-input'), 'DELETE');
    await fireEvent.press(screen.getByTestId('backup_delete_account_dialog-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('backup_error')).toHaveTextContent(/sign-in is too old/);
    });
    expect(screen.getByTestId('backup_error')).not.toHaveTextContent(/Sign in to your backup/);
    // Still signed in, and the screen still says so -- which is what made the old copy absurd.
    expect(screen.getByText(EMAIL)).toBeTruthy();
    expect(screen.getByTestId('backup_sign_out')).toBeTruthy();
  });
});

/**
 * "Create account" looked dead to a user on 2026-09-18, right after they had deleted an account.
 *
 * It was never disabled and nothing had gone wrong at the server -- no request reached it. The
 * press hit the empty-field guard, and the refusal then sat on screen unchanged while they typed,
 * which reads exactly like a button that does nothing. These pin the button as usable and the
 * message as responsive.
 */
describe('CloudBackupScreen creating an account', () => {
  it('offers Create account as an enabled button while signed out', async () => {
    const harness = buildCloudHarness();
    await renderWithServices(harness.services, <CloudBackupScreen />);

    const create = screen.getByTestId('backup_sign_up');
    expect(create).toBeTruthy();
    expect(create.props.accessibilityState?.disabled).toBe(false);
  });

  it('creates the account and signs in when both fields are filled', async () => {
    const harness = buildCloudHarness();
    await renderWithServices(harness.services, <CloudBackupScreen />);

    await fireEvent.changeText(screen.getByTestId('backup_email'), 'fresh@example.test');
    await fireEvent.changeText(screen.getByTestId('backup_password'), ACCOUNT_PASSWORD);
    await fireEvent.press(screen.getByTestId('backup_sign_up'));

    await waitFor(() => {
      expect(screen.getByTestId('backup_sign_out')).toBeTruthy();
    });
    expect(harness.cloud.currentUser?.email).toBe('fresh@example.test');
    expect(harness.cloud.passwordFor('fresh@example.test')).toBe(ACCOUNT_PASSWORD);
    expect(screen.queryByTestId('backup_error')).toBeNull();
  });

  it('names the missing field, and says something different for each button', async () => {
    const harness = buildCloudHarness();
    await renderWithServices(harness.services, <CloudBackupScreen />);

    await fireEvent.press(screen.getByTestId('backup_sign_up'));
    expect(screen.getByTestId('backup_error')).toHaveTextContent(/Enter the email address/);

    await fireEvent.changeText(screen.getByTestId('backup_email'), 'fresh@example.test');
    await fireEvent.press(screen.getByTestId('backup_sign_up'));
    expect(screen.getByTestId('backup_error')).toHaveTextContent(/Choose a password for the new/);

    // The same empty password, pressed on the other button, is a different sentence -- so a press
    // that changes the message is visibly a press that registered.
    await fireEvent.press(screen.getByTestId('backup_sign_in'));
    expect(screen.getByTestId('backup_error')).toHaveTextContent(/Enter the password for/);
  });

  it('clears the refusal as soon as the user starts filling the field in', async () => {
    const harness = buildCloudHarness();
    await renderWithServices(harness.services, <CloudBackupScreen />);

    await fireEvent.press(screen.getByTestId('backup_sign_up'));
    expect(screen.getByTestId('backup_error')).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('backup_email'), 'f');
    expect(screen.queryByTestId('backup_error')).toBeNull();

    await fireEvent.press(screen.getByTestId('backup_sign_up'));
    expect(screen.getByTestId('backup_error')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('backup_password'), 'x');
    expect(screen.queryByTestId('backup_error')).toBeNull();
  });

  it('lets a brand new account be created after the previous one was deleted', async () => {
    const harness = buildCloudHarness();
    await openVaultWithPhotos(harness, '2468', 1);
    await harness.cloud.signUp(EMAIL, ACCOUNT_PASSWORD);
    await renderWithServices(harness.services, <CloudBackupScreen />);

    await waitFor(() => {
      expect(screen.getByTestId('backup_delete_account')).toBeTruthy();
    });
    await fireEvent.press(screen.getByTestId('backup_delete_account'));
    await fireEvent.changeText(screen.getByTestId('backup_delete_password'), ACCOUNT_PASSWORD);
    await fireEvent.press(screen.getByTestId('backup_delete_submit'));
    await fireEvent.changeText(screen.getByTestId('typed-confirm-input'), 'DELETE');
    await fireEvent.press(screen.getByTestId('backup_delete_account_dialog-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('backup_email')).toBeTruthy();
    });

    // The freed address is reusable: deletion removed the credential, not just its data.
    await fireEvent.changeText(screen.getByTestId('backup_email'), EMAIL);
    await fireEvent.changeText(screen.getByTestId('backup_password'), 'a-new-password');
    await fireEvent.press(screen.getByTestId('backup_sign_up'));

    await waitFor(() => {
      expect(screen.getByTestId('backup_sign_out')).toBeTruthy();
    });
    expect(harness.cloud.currentUser?.email).toBe(EMAIL);
    expect(harness.cloud.passwordFor(EMAIL)).toBe('a-new-password');
  });
});
