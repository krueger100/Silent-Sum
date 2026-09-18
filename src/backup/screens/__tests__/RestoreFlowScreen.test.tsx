import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { RestoreFlowScreen } from '@/backup/screens/RestoreFlowScreen';
import {
  buildCloudHarness,
  buildHarness,
  openVaultWithPhotos,
  renderWithServices,
  type CloudHarness,
} from '@/backup/screens/__tests__/harness';
import type { BackupService } from '@/backup/types';
import { InMemoryCloudBackend } from '@/firebase/cloudBackend';
import type { Bytes } from '@/utils/bytes';

const EMAIL = 'vault@example.test';
const ACCOUNT_PASSWORD = 'account-password';
const PASSPHRASE = 'correct horse battery staple';
const OLD_PIN = '2468';
const NEW_PIN = '9753';

function requireBackup(harness: CloudHarness): BackupService {
  const backup = harness.services.backup;
  if (backup === null) throw new Error('expected a backup service');
  return backup;
}

/** A device that already has a vault and has pushed it to the cloud, then signs out. */
async function seedCloudBackup(cloud: InMemoryCloudBackend, photos: number): Promise<void> {
  const source = buildCloudHarness(cloud);
  await openVaultWithPhotos(source, OLD_PIN, photos);
  await cloud.signUp(EMAIL, ACCOUNT_PASSWORD);
  const backup = requireBackup(source);
  await backup.enable(source.services.session.requireKeys(), PASSPHRASE);
  const repository = source.services.vault.current;
  if (repository === null) throw new Error('expected an open vault');
  await backup.backupNow(repository, source.services.session.requireKeys());
  source.services.session.lock();
  await cloud.signOut();
}

/** Step 1, as far as the passphrase prompt, which only appears when a backup was detected. */
async function signInToBackup(): Promise<void> {
  await fireEvent.changeText(screen.getByTestId('restore_email'), EMAIL);
  await fireEvent.changeText(screen.getByTestId('restore_password'), ACCOUNT_PASSWORD);
  await fireEvent.press(screen.getByTestId('restore_sign_in'));
  await waitFor(() => {
    expect(screen.getByTestId('restore_passphrase')).toBeTruthy();
  });
}

/** Step 2. The passphrase is unwrapped against the envelope here, so this can fail on its own. */
async function enterPassphrase(passphrase: string): Promise<void> {
  await fireEvent.changeText(screen.getByTestId('restore_passphrase'), passphrase);
  await fireEvent.press(screen.getByTestId('restore_passphrase_next'));
}

async function runFlow(pin: string, passphrase: string): Promise<void> {
  await signInToBackup();
  await enterPassphrase(passphrase);
  // Only a verified passphrase opens the PIN step.
  await waitFor(() => {
    expect(screen.getByTestId('restore_pin')).toBeTruthy();
  });
  await fireEvent.changeText(screen.getByTestId('restore_pin'), pin);
  await fireEvent.changeText(screen.getByTestId('restore_pin_confirm'), pin);
  await fireEvent.press(screen.getByTestId('restore_submit'));
}

describe('RestoreFlowScreen', () => {
  it('explains that there is nothing to restore from in a build without a cloud backend', async () => {
    const harness = buildHarness();
    await renderWithServices(harness.services, <RestoreFlowScreen onDone={jest.fn()} />);

    expect(screen.getByTestId('restore_unavailable')).toHaveTextContent(
      /not available in this build/i,
    );
    expect(screen.queryByTestId('restore_sign_in')).toBeNull();
  });

  it('signs in, unwraps the key, adopts a new local PIN and downloads the photos', async () => {
    const cloud = new InMemoryCloudBackend();
    await seedCloudBackup(cloud, 2);

    // A different device: same cloud account, empty disk, no credentials.
    const harness = buildCloudHarness(cloud);
    const backup = requireBackup(harness);
    const recoveredBuffers: Bytes[] = [];
    const realRecover = backup.recoverMasterKey.bind(backup);
    jest.spyOn(backup, 'recoverMasterKey').mockImplementation(async (passphrase: string) => {
      const master = await realRecover(passphrase);
      recoveredBuffers.push(master);
      return master;
    });
    const onDone = jest.fn();

    await renderWithServices(harness.services, <RestoreFlowScreen onDone={onDone} />);
    await runFlow(NEW_PIN, PASSPHRASE);

    await waitFor(() => {
      expect(screen.getByTestId('restore_summary')).toHaveTextContent(
        /Restored 2 photos, skipped 0 photos/,
      );
    });

    expect(await harness.services.auth.isConfigured()).toBe(true);
    // Still locked while the summary is on screen. Unlocking here would swap the navigator's
    // locked stack out from under this screen and abort the restore it is still reporting on.
    expect(harness.services.session.isUnlocked).toBe(false);
    expect(harness.services.vault.current?.photos).toHaveLength(2);
    expect(harness.services.settings.current.onboardingDone).toBe(true);
    expect(harness.services.settings.current.backupEnabled).toBe(true);

    // The recovered master key buffer was zeroed once it had been re-wrapped.
    const recovered = recoveredBuffers.at(0);
    expect(recovered).toBeDefined();
    expect(recovered === undefined ? null : [...recovered].every((byte) => byte === 0)).toBe(true);

    // The new PIN is the one that opens the vault now; the old one does not.
    harness.services.session.lock();
    const withNew = await harness.services.auth.unlock(NEW_PIN);
    expect(withNew.kind).toBe('success');
    if (withNew.kind === 'success') withNew.keys.dispose();
    const withOld = await harness.services.auth.unlock(OLD_PIN);
    expect(withOld.kind).toBe('wrongPin');

    await fireEvent.press(screen.getByTestId('restore_done'));
    expect(onDone).toHaveBeenCalledTimes(1);
    // The vault is handed over only now, once there is something in it to hand over.
    expect(harness.services.session.isUnlocked).toBe(true);
  });

  it('rejects a wrong recovery passphrase and changes nothing on the device', async () => {
    const cloud = new InMemoryCloudBackend();
    await seedCloudBackup(cloud, 1);
    const harness = buildCloudHarness(cloud);

    await renderWithServices(harness.services, <RestoreFlowScreen onDone={jest.fn()} />);
    await signInToBackup();
    await enterPassphrase('not the right passphrase');

    await waitFor(() => {
      expect(screen.getByTestId('restore_error')).toHaveTextContent(/Wrong recovery passphrase/);
    });
    expect(await harness.services.auth.isConfigured()).toBe(false);
    expect(harness.services.session.isUnlocked).toBe(false);
    // Still on the passphrase step, and the user was never asked to invent a PIN for a restore
    // that was never going to happen.
    expect(screen.getByTestId('restore_passphrase')).toBeTruthy();
    expect(screen.queryByTestId('restore_pin')).toBeNull();
  });

  it('reports an account with no backup instead of asking for a passphrase', async () => {
    const cloud = new InMemoryCloudBackend();
    // A real account, signed out again, but nothing was ever backed up under it.
    await cloud.signUp(EMAIL, ACCOUNT_PASSWORD);
    await cloud.signOut();
    const harness = buildCloudHarness(cloud);

    await renderWithServices(harness.services, <RestoreFlowScreen onDone={jest.fn()} />);
    await fireEvent.changeText(screen.getByTestId('restore_email'), EMAIL);
    await fireEvent.changeText(screen.getByTestId('restore_password'), ACCOUNT_PASSWORD);
    await fireEvent.press(screen.getByTestId('restore_sign_in'));

    await waitFor(() => {
      expect(screen.getByTestId('restore_missing')).toHaveTextContent(/No backup found/i);
    });
    expect(screen.queryByTestId('restore_passphrase')).toBeNull();

    // And the dead end has a way out that does not require killing the app.
    await fireEvent.press(screen.getByTestId('restore_other_account'));
    await waitFor(() => {
      expect(screen.getByTestId('restore_email')).toBeTruthy();
    });
    expect(cloud.currentUser).toBeNull();
  });

  it('refuses a PIN that breaks the policy without re-deriving or writing anything', async () => {
    const cloud = new InMemoryCloudBackend();
    await seedCloudBackup(cloud, 1);
    const harness = buildCloudHarness(cloud);
    const backup = requireBackup(harness);
    const recover = jest.spyOn(backup, 'recoverMasterKey');

    await renderWithServices(harness.services, <RestoreFlowScreen onDone={jest.fn()} />);
    await runFlow('0123', PASSPHRASE);

    expect(screen.getByTestId('restore_error')).toHaveTextContent(/cannot start with 0/);
    // One Argon2id run, at the passphrase step. The bad PIN never reached the vault.
    expect(recover).toHaveBeenCalledTimes(1);
    expect(await harness.services.auth.isConfigured()).toBe(false);
    expect(harness.services.vault.current).toBeNull();
  });

  it('locks the session again when the user abandons the flow after adopting a key', async () => {
    const cloud = new InMemoryCloudBackend();
    await seedCloudBackup(cloud, 1);
    const harness = buildCloudHarness(cloud);

    const view = await renderWithServices(
      harness.services,
      <RestoreFlowScreen onDone={jest.fn()} />,
    );
    await runFlow(NEW_PIN, PASSPHRASE);
    await waitFor(() => {
      expect(screen.getByTestId('restore_summary')).toBeTruthy();
    });
    expect(harness.services.session.isUnlocked).toBe(false);

    // Leaving without pressing "Open vault" must not park an unlocked vault behind the calculator.
    await view.unmount();

    expect(harness.services.session.isUnlocked).toBe(false);
  });
});
