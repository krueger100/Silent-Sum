/**
 * Resetting the ACCOUNT password, and everything that must survive it untouched.
 *
 * The reset exists because the account password is the one secret in this app that a provider CAN
 * legitimately help with: it says where the ciphertext lives and nothing more. The tests below are
 * mostly about the other side of that sentence -- that a reset moves nothing else. The envelope,
 * the uploaded blobs, the local credential record, the master key inside it and the recovery
 * passphrase requirement are each compared byte for byte, or exercised, across a reset.
 *
 * The screens are also held to not answering "does this address have an account", which is a
 * question an app like this should never be an oracle for.
 */
import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { CloudBackupScreen } from '@/backup/screens/CloudBackupScreen';
import { RestoreFlowScreen } from '@/backup/screens/RestoreFlowScreen';
import {
  requestPasswordReset,
  resetRequestedMessage,
  RESET_REASSURANCE,
} from '@/backup/screens/passwordReset';
import {
  buildCloudHarness,
  openVaultWithPhotos,
  renderWithServices,
  type CloudHarness,
} from '@/backup/screens/__tests__/harness';
import { BACKUP_PATHS, type BackupService } from '@/backup/types';
import { InMemoryCloudBackend } from '@/firebase/cloudBackend';
import { CloudError } from '@/firebase/types';
import { encodeCredentials } from '@/auth/vaultCredentials';
import { bytesEqual, toHex } from '@/utils/bytes';

const EMAIL = 'vault@example.test';
const OLD_PASSWORD = 'account-password';
const NEW_PASSWORD = 'a-brand-new-account-password';
const PASSPHRASE = 'correct horse battery staple';
const PIN = '2468';

function requireBackup(harness: CloudHarness): BackupService {
  const backup = harness.services.backup;
  if (backup === null) throw new Error('expected a backup service');
  return backup;
}

/** A device with a vault, an account, an envelope and an upload already done. */
async function seeded(cloud: InMemoryCloudBackend): Promise<CloudHarness> {
  const harness = buildCloudHarness(cloud);
  await openVaultWithPhotos(harness, PIN, 2);
  await cloud.signUp(EMAIL, OLD_PASSWORD);
  const backup = requireBackup(harness);
  await backup.enable(harness.services.session.requireKeys(), PASSPHRASE);
  const repository = harness.services.vault.current;
  if (repository === null) throw new Error('expected an open vault');
  await backup.backupNow(repository, harness.services.session.requireKeys());
  return harness;
}

/**
 * Everything a reset must not touch, captured as comparable values.
 *
 * `uid` is passed in rather than read from `currentUser`, because completing a reset signs the
 * session out -- the point of the test is that the DATA under that uid is unchanged, not that
 * somebody is still holding a token for it.
 */
async function snapshot(cloud: InMemoryCloudBackend, harness: CloudHarness, uid: string) {
  return {
    envelope: JSON.stringify(cloud.documents.get(BACKUP_PATHS.envelope(uid)) ?? null),
    manifest: JSON.stringify(cloud.documents.get(BACKUP_PATHS.manifest(uid)) ?? null),
    blobs: [...cloud.blobs.entries()]
      .map(([path, bytes]) => `${path}:${toHex(bytes)}`)
      .sort()
      .join('|'),
    // The whole persisted record: salt, KDF parameters and the wrapped master key.
    credentials: await harness.services.auth
      .loadCredentials()
      .then((record) => (record === null ? null : encodeCredentials(record))),
  };
}

describe('requestPasswordReset', () => {
  it('asks the backend to mail a link for the address that was typed', async () => {
    const cloud = new InMemoryCloudBackend();
    await cloud.signUp(EMAIL, OLD_PASSWORD);
    await cloud.signOut();

    const outcome = await requestPasswordReset(cloud, `  ${EMAIL}  `);

    expect(outcome).toEqual({ kind: 'requested', message: resetRequestedMessage(EMAIL) });
    expect(cloud.passwordResets).toEqual([EMAIL]);
  });

  /** An app whose users are not supposed to be obvious must not confirm who has an account. */
  it('answers an unknown address exactly as it answers a known one', async () => {
    const cloud = new InMemoryCloudBackend();
    await cloud.signUp(EMAIL, OLD_PASSWORD);
    await cloud.signOut();

    const known = await requestPasswordReset(cloud, EMAIL);
    const unknown = await requestPasswordReset(cloud, 'nobody@example.test');

    expect(known.kind).toBe('requested');
    expect(unknown.kind).toBe('requested');
    expect(unknown.message).toBe(resetRequestedMessage('nobody@example.test'));
    // The attempt still reached the backend; only the ANSWER is indistinguishable.
    expect(cloud.passwordResets).toEqual([EMAIL, 'nobody@example.test']);
  });

  it('refuses an empty address before any network call', async () => {
    const cloud = new InMemoryCloudBackend();

    const outcome = await requestPasswordReset(cloud, '   ');

    expect(outcome).toEqual({
      kind: 'failed',
      message: 'Enter the email address of your backup account first.',
    });
    expect(cloud.passwordResets).toEqual([]);
  });

  it('reports a real failure rather than pretending a mail went out', async () => {
    const cloud = new InMemoryCloudBackend();
    jest.spyOn(cloud, 'sendPasswordReset').mockRejectedValue(
      new CloudError('network-request-failed'),
    );

    const outcome = await requestPasswordReset(cloud, EMAIL);

    expect(outcome.kind).toBe('failed');
    expect(outcome.message).toMatch(/No network connection/);
  });
});

describe('the reset link on the Cloud backup sign-in form', () => {
  it('sends a link and says so, without asking for a password, PIN or passphrase', async () => {
    const cloud = new InMemoryCloudBackend();
    await cloud.signUp(EMAIL, OLD_PASSWORD);
    await cloud.signOut();
    const harness = buildCloudHarness(cloud);

    await renderWithServices(harness.services, <CloudBackupScreen />);

    expect(screen.getByTestId('backup_reset_note')).toHaveTextContent(RESET_REASSURANCE);
    await fireEvent.changeText(screen.getByTestId('backup_email'), EMAIL);
    await fireEvent.press(screen.getByTestId('backup_forgot_password'));

    await waitFor(() => {
      expect(screen.getByTestId('backup_status')).toHaveTextContent(/reset link is on its way/);
    });
    expect(cloud.passwordResets).toEqual([EMAIL]);
    // Nothing else on the screen was needed or touched.
    expect(screen.queryByTestId('backup_passphrase')).toBeNull();
    expect(harness.services.session.isUnlocked).toBe(false);
  });

  it('says what to do when the email box is empty', async () => {
    const cloud = new InMemoryCloudBackend();
    const harness = buildCloudHarness(cloud);

    await renderWithServices(harness.services, <CloudBackupScreen />);
    await fireEvent.press(screen.getByTestId('backup_forgot_password'));

    await waitFor(() => {
      expect(screen.getByTestId('backup_error')).toHaveTextContent(/Enter the email address/);
    });
    expect(cloud.passwordResets).toEqual([]);
  });
});

describe('the reset link on the Restore sign-in form', () => {
  it('is offered at step 1 and does not skip the passphrase step', async () => {
    const cloud = new InMemoryCloudBackend();
    await cloud.signUp(EMAIL, OLD_PASSWORD);
    await cloud.signOut();
    const harness = buildCloudHarness(cloud);

    await renderWithServices(harness.services, <RestoreFlowScreen onDone={jest.fn()} />);

    expect(screen.getByTestId('restore_reset_note')).toHaveTextContent(RESET_REASSURANCE);
    await fireEvent.changeText(screen.getByTestId('restore_email'), EMAIL);
    await fireEvent.press(screen.getByTestId('restore_forgot_password'));

    await waitFor(() => {
      expect(screen.getByTestId('restore_notice')).toHaveTextContent(/reset link is on its way/);
    });
    expect(cloud.passwordResets).toEqual([EMAIL]);
    // Still on step 1: a reset request is not a sign-in.
    expect(screen.getByTestId('restore_sign_in')).toBeTruthy();
    expect(screen.queryByTestId('restore_passphrase')).toBeNull();
  });
});

describe('what a password reset leaves alone', () => {
  it('changes no envelope, no blob and no local credential record', async () => {
    const cloud = new InMemoryCloudBackend();
    const harness = await seeded(cloud);
    const uid = cloud.currentUser?.uid ?? '';
    const before = await snapshot(cloud, harness, uid);

    await requestPasswordReset(cloud, EMAIL);
    cloud.completePasswordReset(EMAIL, NEW_PASSWORD);

    const after = await snapshot(cloud, harness, uid);
    expect(after.envelope).toBe(before.envelope);
    expect(after.manifest).toBe(before.manifest);
    expect(after.blobs).toBe(before.blobs);
    expect(after.credentials).toBe(before.credentials);
    // And the envelope is really there, so the comparison is not two nulls agreeing.
    expect(before.envelope).not.toBe('null');
    expect(before.blobs.length).toBeGreaterThan(0);
  });

  it('leaves the same master key recoverable by the same passphrase', async () => {
    const cloud = new InMemoryCloudBackend();
    const harness = await seeded(cloud);
    const backup = requireBackup(harness);
    const before = await backup.recoverMasterKey(PASSPHRASE);
    const beforeHex = toHex(before);
    before.fill(0);

    cloud.completePasswordReset(EMAIL, NEW_PASSWORD);
    await cloud.signIn(EMAIL, NEW_PASSWORD);

    const after = await backup.recoverMasterKey(PASSPHRASE);
    expect(toHex(after)).toBe(beforeHex);
    // It is also still the key the LOCAL vault opens with, so the PIN path is untouched too.
    const unlocked = await harness.services.auth.unlock(PIN);
    if (unlocked.kind !== 'success') throw new Error('expected the PIN to still unlock');
    expect(bytesEqual(unlocked.keys.masterKey, after)).toBe(true);
    unlocked.keys.dispose();
    after.fill(0);
  });

  it('keeps the vault openable offline with the same PIN', async () => {
    const cloud = new InMemoryCloudBackend();
    const harness = await seeded(cloud);
    harness.services.session.lock();

    cloud.completePasswordReset(EMAIL, NEW_PASSWORD);

    const unlocked = await harness.services.auth.unlock(PIN);
    expect(unlocked.kind).toBe('success');
    if (unlocked.kind === 'success') {
      const repository = await harness.services.vault.open(unlocked.keys);
      expect(repository.photos).toHaveLength(2);
      unlocked.keys.dispose();
    }
  });
});

describe('signing back in with the new password', () => {
  it('finds the existing backup, and still demands the recovery passphrase to restore it', async () => {
    const cloud = new InMemoryCloudBackend();
    await seeded(cloud);
    cloud.completePasswordReset(EMAIL, NEW_PASSWORD);
    expect(cloud.currentUser).toBeNull();

    // A fresh device: nothing local at all, only the new account password and the passphrase.
    const fresh = buildCloudHarness(cloud);
    const onDone = jest.fn();
    await renderWithServices(fresh.services, <RestoreFlowScreen onDone={onDone} />);

    // The OLD password no longer works...
    await fireEvent.changeText(screen.getByTestId('restore_email'), EMAIL);
    await fireEvent.changeText(screen.getByTestId('restore_password'), OLD_PASSWORD);
    await fireEvent.press(screen.getByTestId('restore_sign_in'));
    await waitFor(() => {
      expect(screen.getByTestId('restore_error')).toHaveTextContent(/Wrong email or password/);
    });

    // ...and the new one does.
    await fireEvent.changeText(screen.getByTestId('restore_password'), NEW_PASSWORD);
    await fireEvent.press(screen.getByTestId('restore_sign_in'));
    await waitFor(() => {
      expect(screen.getByTestId('restore_passphrase')).toBeTruthy();
    });

    // The backup is found -- and the account alone gets no further than this screen.
    await fireEvent.changeText(screen.getByTestId('restore_passphrase'), 'not the passphrase');
    await fireEvent.press(screen.getByTestId('restore_passphrase_next'));

    await waitFor(() => {
      expect(screen.getByTestId('restore_error')).toHaveTextContent(/Wrong recovery passphrase/);
    });
    // Checked against the envelope right here, so the account password never buys even the PIN
    // step, let alone a restore.
    expect(screen.queryByTestId('restore_pin')).toBeNull();
    expect(onDone).not.toHaveBeenCalled();
    expect(fresh.services.session.isUnlocked).toBe(false);

    // The right passphrase, with the same new account password, restores everything.
    await fireEvent.changeText(screen.getByTestId('restore_passphrase'), PASSPHRASE);
    await fireEvent.press(screen.getByTestId('restore_passphrase_next'));
    await waitFor(() => {
      expect(screen.getByTestId('restore_pin')).toBeTruthy();
    });
    await fireEvent.changeText(screen.getByTestId('restore_pin'), '9753');
    await fireEvent.changeText(screen.getByTestId('restore_pin_confirm'), '9753');
    await fireEvent.press(screen.getByTestId('restore_submit'));

    await waitFor(() => {
      expect(screen.getByTestId('restore_summary')).toHaveTextContent(/Restored 2 photos/);
    });
  });
});
