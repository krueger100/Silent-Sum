/**
 * Optional, explicit, end-to-end-encrypted cloud backup.
 *
 * Three secrets meet on this screen and they must never be confused with each other:
 *   - the vault PIN, which never appears here and is never uploaded;
 *   - the account password, which only identifies where the ciphertext is stored;
 *   - the recovery passphrase, which is the only thing that can ever unwrap the backed-up key,
 *     and which is not uploaded either.
 * The copy says all of that out loud, because a user who thinks the account password can restore
 * their photos will discover otherwise at the worst possible moment.
 *
 * Backup goes both ways from here. "Back up now" pushes the device's photos up; "Restore from
 * backup" pulls down whatever is in the cloud and missing locally, into the vault that is already
 * open. That second direction is deliberately NOT the same thing as the restore on the locked
 * calculator: this one adds to a working vault and needs no new PIN, while that one rebuilds a
 * vault that is gone and has to re-wrap the recovered key under a PIN chosen there. See
 * `RestoreFlowScreen`, and `restoreNow` below for why the two cannot be collapsed into one.
 *
 * Nothing here is required for the vault to work. When the build has no cloud backend the screen
 * explains that and stops; it never crashes and never implies something is broken.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import {
  useEntitlements,
  useIsUnlocked,
  useServices,
  useSettings,
  useVaultState,
} from '@/app/ServicesProvider';
import { radius, spacing, type Palette, typography, useStyles, useTheme } from '@/app/theme';
import { describeCloudError } from '@/backup/screens/cloudErrors';
import { cloudActive } from '@/billing/entitlements';
import { CloudRequiredCard } from '@/billing/screens/CloudRequiredCard';
import { requestPasswordReset, RESET_REASSURANCE } from '@/backup/screens/passwordReset';
import { validatePassphrase } from '@/backup/passphrasePolicy';
import type { BackupService } from '@/backup/types';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { ConfirmDialog, TypedConfirmDialog } from '@/components/Dialog';
import { ListRow } from '@/components/ListRow';
import { Paragraph, Screen, SectionLabel } from '@/components/Screen';
import {
  ANALYTICS_EVENTS,
  logEventSafely,
  type CloudBackend,
  type CloudUser,
} from '@/firebase/types';
import { constantTimeEquals, zeroBytes } from '@/utils/bytes';

export interface CloudBackupScreenProps {
  onBack?: () => void;
  /** Where "See plans" goes when Cloud is required and not on. */
  onPlans?: () => void;
}

const HOW_IT_WORKS: readonly string[] = [
  'Off by default. Nothing leaves this device until you switch it on here.',
  'Photos upload exactly as they are stored: already encrypted. The service never sees an image.',
  'Your vault key is uploaded only inside an envelope locked by a recovery passphrase you choose. The passphrase itself is never uploaded.',
  'Your PIN is never uploaded and is not linked to the account.',
  'Restoring only adds what is missing. Nothing already on this device is deleted or overwritten.',
  'The vault keeps working offline whether backup is on or off.',
];

export function CloudBackupScreen({ onBack, onPlans }: CloudBackupScreenProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const services = useServices();
  const backup = services.backup;
  const cloud = services.firebase.cloud;

  if (backup === null || cloud === null || !services.firebase.available) {
    return (
      <Screen
        title="Cloud backup"
        scroll
        testID="cloud_backup_screen"
        {...(onBack === undefined ? {} : { onBack })}
      >
        <View style={styles.card} testID="backup_unavailable">
          <Text style={styles.cardTitle}>Cloud backup is not available in this build</Text>
          <Text style={styles.cardLine}>
            This copy of the app was built without any cloud configuration, so there is nothing to
            sign in to and nothing to upload to.
          </Text>
          <Text style={styles.cardLine}>
            Everything else works exactly as it should: your vault is local, encrypted and unlocked
            entirely offline.
          </Text>
        </View>
        <HowItWorks />
      </Screen>
    );
  }

  return (
    <CloudBackupBody
      backup={backup}
      cloud={cloud}
      {...(onBack === undefined ? {} : { onBack })}
      {...(onPlans === undefined ? {} : { onPlans })}
    />
  );
}

function CloudBackupBody({
  backup,
  cloud,
  onBack,
  onPlans,
}: {
  backup: BackupService;
  cloud: CloudBackend;
  onBack?: () => void;
  onPlans?: () => void;
}): React.JSX.Element {
  const colors = useTheme();
  const styles = useStyles(makeStyles);
  const services = useServices();
  const settings = useSettings();
  const isUnlocked = useIsUnlocked();
  const vault = useVaultState();
  const { entitlements: owned } = useEntitlements();
  /**
   * Backup and restore are SilentSum Cloud features. In a build that can sell, an account with no
   * active term sees the gate card where the controls would be; the account section and the
   * Danger section stay, because paying and leaving must both remain possible.
   */
  const cloudGated = services.entitlements.enforced && !cloudActive(owned, services.clock.now());

  const [user, setUser] = useState<CloudUser | null>(cloud.currentUser);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [passphraseConfirm, setPassphraseConfirm] = useState('');
  const [prompting, setPrompting] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restorePassphrase, setRestorePassphrase] = useState('');
  /** Set to the sentence explaining why "Back up now" had nothing to do; null hides the alert. */
  const [nothingToUpload, setNothingToUpload] = useState<string | null>(null);
  const [confirmingDisable, setConfirmingDisable] = useState(false);
  const [confirmingDeleteAccount, setConfirmingDeleteAccount] = useState(false);
  /** Whether the account-password field for deletion is showing, and what has been typed into it. */
  const [deleting, setDeleting] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [busy, setBusy] = useState(false);
  /** Synchronous re-entrancy guard; `busy` drives the UI but lags a double tap by a frame. */
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [hasEnvelope, setHasEnvelope] = useState<boolean | null>(null);

  useEffect(() => cloud.onAuthStateChanged(setUser), [cloud]);

  /** Whether this account has a key envelope, or null when that is not knowable right now. */
  const readEnvelope = useCallback(async (): Promise<boolean | null> => {
    if (cloud.currentUser === null) return null;
    try {
      return await backup.hasEnvelope();
    } catch {
      // A read failure is not a state: leave it unknown rather than claiming backup is off.
      return null;
    }
  }, [backup, cloud]);

  const refreshEnvelope = useCallback(async (): Promise<void> => {
    setHasEnvelope(await readEnvelope());
  }, [readEnvelope]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const next = await readEnvelope();
      if (!cancelled) setHasEnvelope(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [readEnvelope, user]);

  /** Runs an action with the busy flag, turning any failure into safe copy. */
  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(describeCloudError(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, []);

  /**
   * Typing into a credential field is an attempt to fix whatever the last message complained
   * about, so the message goes. Leaving it up was what made a working button look broken: the
   * refusal for an empty field stayed on screen while the user filled the field in, and the
   * obvious reading of an unchanged error is that the press did nothing.
   */
  const editCredential =
    (setter: (value: string) => void) =>
    (value: string): void => {
      setter(value);
      setError(null);
    };

  const authenticate = (create: boolean): void => {
    const address = email.trim();
    const secret = password;
    // Checked here rather than at the server: an empty field is the user's own typing, and
    // sending it produces a code the SDK reports differently on each platform. Named one field at
    // a time, and differently for the two buttons: one sentence covering both left a user staring
    // at an unchanged message, sure that "Create account" was dead when it had simply told them
    // the same thing twice.
    if (address === '') {
      setError('Enter the email address for the backup account.');
      return;
    }
    if (secret === '') {
      setError(
        create
          ? 'Choose a password for the new backup account.'
          : 'Enter the password for the backup account.',
      );
      return;
    }
    void run(async () => {
      setStatus(null);
      const account = create
        ? await cloud.signUp(address, secret)
        : await cloud.signIn(address, secret);
      // Cleared only once it has been used: clearing before the call meant a failed attempt left
      // the field empty, so pressing the button again sent an empty password and a confusing
      // error rather than retrying what the user typed.
      setPassword('');
      setUser(account);
      await refreshEnvelope();
    });
  };

  const enableBackup = (): void => {
    const problem = validatePassphrase(passphrase);
    if (problem !== null) {
      // Refused here, before any network call: a weak passphrase never reaches a server log.
      setError(problem);
      return;
    }
    if (passphrase !== passphraseConfirm) {
      setError('Those passphrases do not match.');
      return;
    }
    if (!isUnlocked) {
      setError('Open the vault first: enabling backup needs the key that your PIN unwraps.');
      return;
    }
    void run(async () => {
      const chosen = passphrase;
      await backup.enable(services.session.requireKeys(), chosen);
      setPassphrase('');
      setPassphraseConfirm('');
      setPrompting(false);
      await services.settings.update({ backupEnabled: true });
      await refreshEnvelope();
      setStatus('Backup enabled. Use "Back up now" to upload your photos.');
    });
  };

  /**
   * Uploads whatever the cloud does not already have.
   *
   * Two outcomes, and they are reported differently on purpose. An upload that moved something
   * gets the quiet status line, because the user asked for it and got it. An upload with nothing
   * to do gets a dialog they have to dismiss: "nothing happened" written in small type under a
   * button is indistinguishable from a button that did not work, and the whole reason someone
   * presses this twice is that they were not sure the first press counted.
   */
  const backupNow = (): void => {
    const repository = services.vault.current;
    if (repository === null) {
      setError('Open the vault first: there is nothing to read while it is locked.');
      return;
    }
    void run(async () => {
      const report = await backup.backupNow(repository, services.session.requireKeys());
      await services.settings.update({ backupEnabled: true, lastBackupAt: services.clock.now() });
      logEventSafely(services.firebase.analytics, ANALYTICS_EVENTS.backupCompleted, {
        count: report.total,
      });
      if (report.uploaded === 0) {
        setStatus(null);
        setNothingToUpload(
          report.total === 0
            ? 'There are no photos in the vault yet, so there was nothing to upload.'
            : `Every photo on this device is already in the backup, so nothing was uploaded. ` +
                `${plural(report.total, 'photo')} are in the backup and none of them were changed.`,
        );
      } else {
        setStatus(
          `Uploaded ${plural(report.uploaded, 'photo')}. ` +
            `${plural(report.total, 'photo')} now in the backup.` +
            (report.cloudOnly === 0
              ? ''
              : ` That includes ${plural(report.cloudOnly, 'photo')} this device no longer has, ` +
                'kept rather than deleted.'),
        );
      }
      await refreshEnvelope();
    });
  };

  /**
   * Pulls down the photos that are in the backup and not on this device.
   *
   * Additive and idempotent. `restoreInto` skips every id the repository already holds, so running
   * it twice downloads the index and changes nothing; it never deletes a local photo and never
   * overwrites one. This is the opposite direction from "Back up now", not a mirror of it -- a
   * mirror would propagate a deletion, and there is no undo for that.
   *
   * The passphrase is checked by unwrapping the envelope, which costs one Argon2id run and touches
   * nothing. The key that comes out is then compared against the key this vault is running on, and
   * the two can legitimately differ: a backup made before the vault was erased and set up again
   * belongs to an older master key. That used to be refused here, with an explanation and a
   * detour through the locked calculator's Forgot-PIN route. It should not have been. The user
   * proved they own the backup by producing the passphrase that unwraps it, and "the right
   * passphrase, and nothing happens" is not an acceptable answer to someone trying to get their
   * photos back.
   *
   * So the mismatch is handled rather than reported: each item is decrypted with the backup's key
   * and re-encrypted with this vault's on the way in, and the account is then re-pointed at this
   * vault's key so the next "Back up now" is coherent. The vault keeps its own key and its own
   * photos throughout; nothing local is replaced.
   *
   * The recovered key is a raw buffer this function owns; it is zeroed in a `finally` whatever
   * happens.
   */
  const restoreNow = (): void => {
    const repository = services.vault.current;
    if (repository === null) {
      setError('Open the vault first: restored photos are written into it.');
      return;
    }
    if (restorePassphrase === '') {
      setError('Enter the recovery passphrase you chose when you turned backup on.');
      return;
    }
    void run(async () => {
      setStatus(null);
      const keys = services.session.requireKeys();
      const recovered = await backup.recoverMasterKey(restorePassphrase);
      const foreign = !constantTimeEquals(recovered, keys.masterKey);
      try {
        const report = foreign
          ? await backup.restoreForeignInto(repository, keys, recovered)
          : await backup.restoreInto(repository, keys);
        if (foreign) {
          // The photos are now here under this vault's key, so the account is moved onto it too.
          // Skipping this would leave the next "Back up now" unable to read its own index.
          await backup.rebindBackup(repository, keys, restorePassphrase);
        }
        // A restore proves this device has a backup, whatever the local flag said beforehand -- it
        // reads false on a device that was erased, or that restored without ever backing up. The
        // rebind re-uploaded everything, so for that path a backup genuinely did just run.
        await services.settings.update({
          backupEnabled: true,
          ...(foreign ? { lastBackupAt: services.clock.now() } : {}),
        });
        setRestorePassphrase('');
        setRestoring(false);
        logEventSafely(services.firebase.analytics, ANALYTICS_EVENTS.restoreCompleted);
        setStatus(
          report.restored === 0 && report.skipped === 0
            ? 'There was nothing in the backup to restore.'
            : `Restored ${plural(report.restored, 'photo')}. ` +
                `${plural(report.skipped, 'photo')} already on this device, left untouched.` +
                (foreign
                  ? ' That backup was made by an earlier vault, so its photos were re-encrypted for ' +
                    'this one and the backup now follows this device.'
                  : ''),
        );
      } finally {
        zeroBytes(recovered);
      }
    });
  };

  const disableBackup = (): void => {
    setConfirmingDisable(false);
    void run(async () => {
      await backup.disable();
      await services.settings.update({ backupEnabled: false, lastBackupAt: null });
      await refreshEnvelope();
      setStatus('Cloud backup is off and everything it held was deleted.');
    });
  };

  /**
   * Deletes the stored backup and then the account itself, in that order and never the other way
   * round.
   *
   * The server has no cascade: `deleteAccount` removes the credential, not the documents and blobs
   * filed under its uid. Those are reachable only by that uid -- the storage and Firestore rules
   * say so -- which means an account deleted while its data is still there leaves bytes nobody can
   * ever read or remove again, paid for forever.
   *
   * The password comes first, and that ordering was learned the hard way. Firebase refuses to
   * delete an account on a session more than a few minutes old, and the original flow discovered
   * that only after the purge had already run: every photo deleted, the account still standing,
   * and a message telling a signed-in user to sign in. Re-authenticating up front turns that into
   * a refusal that costs nothing -- a wrong password stops the whole thing with the backup intact.
   *
   * Then `purgeAccount()`, while the credential that authorises those deletes still exists. It
   * sweeps the account's own prefix in the bucket, deletes the Firestore documents, and reads back
   * to confirm both are empty -- a check, not an assumption, because the next line is irreversible.
   *
   * Nothing is swallowed. If clearing the cloud fails, or anything at all survives it, the account
   * is deliberately left standing and the error is shown: the alternative -- pressing on and
   * deleting the credential anyway -- is precisely how an account orphans its own data. Keeping the
   * account keeps the only credential that can still reach those bytes. The user presses again.
   *
   * Local state is untouched throughout: the vault, its photos and its PIN are on this device and
   * this account cannot reach them.
   */
  const deleteAccount = (): void => {
    const secret = deletePassword;
    if (secret === '') {
      setError('Enter the account password to confirm deleting the account.');
      return;
    }
    setConfirmingDeleteAccount(false);
    void run(async () => {
      setStatus(null);
      await cloud.reauthenticate(secret);
      await backup.purgeAccount();
      await cloud.deleteAccount();
      setDeletePassword('');
      setDeleting(false);
      await services.settings.update({ backupEnabled: false, lastBackupAt: null });
      setUser(null);
      setHasEnvelope(null);
      setEmail('');
      setPassword('');
      setStatus(
        'That backup account and everything stored in it were deleted. The vault on this device ' +
          'is untouched.',
      );
    });
  };

  /**
   * Mails a reset link for whatever is in the email field. It needs no password, no PIN and no
   * recovery passphrase -- it is the account credential being recovered, and that credential
   * cannot decrypt anything.
   */
  const forgotPassword = (): void => {
    setError(null);
    setStatus(null);
    void run(async () => {
      const outcome = await requestPasswordReset(cloud, email);
      if (outcome.kind === 'requested') setStatus(outcome.message);
      else setError(outcome.message);
    });
  };

  const signOut = (): void => {
    void run(async () => {
      await cloud.signOut();
      setUser(null);
      setHasEnvelope(null);
      setStatus(null);
      setDeletePassword('');
      setDeleting(false);
    });
  };

  return (
    <Screen
      title="Cloud backup"
      scroll
      testID="cloud_backup_screen"
      {...(onBack === undefined ? {} : { onBack })}
    >
      <HowItWorks />

      {busy ? <ActivityIndicator testID="backup_busy" color={colors.accent} /> : null}
      {error === null ? null : (
        <Text testID="backup_error" style={styles.error}>
          {error}
        </Text>
      )}
      {status === null ? null : (
        <Text testID="backup_status" style={styles.status}>
          {status}
        </Text>
      )}

      <SectionLabel>Backup account</SectionLabel>
      {user === null ? (
        <View style={styles.form}>
          <Paragraph>
            This account only says where your encrypted backup is stored. It is a completely
            separate credential from your vault PIN, and it cannot open the vault: signing in on
            another device gives you ciphertext and nothing else.
          </Paragraph>
          <Field
            testID="backup_email"
            label="Email"
            value={email}
            onChangeText={editCredential(setEmail)}
            keyboardType="email-address"
          />
          <Field
            testID="backup_password"
            label="Account password"
            value={password}
            onChangeText={editCredential(setPassword)}
            secure
          />
          <Button
            testID="backup_sign_in"
            label="Sign in"
            busy={busy}
            onPress={() => {
              authenticate(false);
            }}
          />
          <Button
            testID="backup_sign_up"
            label="Create account"
            variant="secondary"
            disabled={busy}
            onPress={() => {
              authenticate(true);
            }}
          />
          <Button
            testID="backup_forgot_password"
            label="Forgot account password?"
            variant="ghost"
            disabled={busy}
            onPress={forgotPassword}
          />
          <Text testID="backup_reset_note" style={styles.muted}>
            {RESET_REASSURANCE}
          </Text>
        </View>
      ) : (
        <>
          <ListRow
            testID="backup_account_row"
            label={user.email ?? user.uid}
            detail="Signed in for backup only. This password cannot open your vault."
            trailing={
              <Button
                testID="backup_sign_out"
                label="Sign out"
                variant="ghost"
                disabled={busy}
                onPress={signOut}
              />
            }
          />

          {cloudGated ? (
            <CloudRequiredCard feature="backup" {...(onPlans === undefined ? {} : { onPlans })} />
          ) : (
            <>
              <SectionLabel>Status</SectionLabel>
              <Text testID="backup_state" style={styles.body}>
                {hasEnvelope === null
                  ? 'Checking this account for a backup...'
                  : hasEnvelope
                    ? 'Backup is enabled for this account.'
                    : 'Backup is not enabled for this account yet.'}
              </Text>
              <Text testID="backup_last_backup" style={styles.muted}>
                {settings.lastBackupAt === null
                  ? 'No backup has run on this device yet.'
                  : `Last backup: ${formatTimestamp(settings.lastBackupAt)}.`}
              </Text>
              {isUnlocked && vault.isOpen ? null : (
                <Text testID="backup_locked_note" style={styles.muted}>
                  Open the vault to enable backup or upload photos.
                </Text>
              )}

              {hasEnvelope === true ? (
                <>
                  <Button testID="backup_now" label="Back up now" busy={busy} onPress={backupNow} />

                  <SectionLabel>Restore</SectionLabel>
                  <Paragraph>
                    Downloads photos that are in the backup but not on this device, straight into
                    the open vault. Photos already here are left exactly as they are, and nothing is
                    deleted - restoring twice is harmless.
                  </Paragraph>
                  {restoring ? (
                    <View style={styles.form}>
                      <Paragraph>
                        This is the recovery passphrase you chose when you turned backup on, not
                        your account password and not your PIN. It is the only thing that can unwrap
                        the backed-up key, and it is checked before anything is downloaded.
                      </Paragraph>
                      <Field
                        testID="backup_restore_passphrase"
                        label="Recovery passphrase"
                        value={restorePassphrase}
                        onChangeText={setRestorePassphrase}
                        secure
                      />
                      <Button
                        testID="backup_restore_submit"
                        label="Restore now"
                        busy={busy}
                        onPress={restoreNow}
                      />
                      <Button
                        testID="backup_restore_cancel"
                        label="Cancel"
                        variant="ghost"
                        disabled={busy}
                        onPress={() => {
                          setRestorePassphrase('');
                          setRestoring(false);
                          setError(null);
                        }}
                      />
                    </View>
                  ) : (
                    <Button
                      testID="backup_restore"
                      label="Restore from backup"
                      variant="secondary"
                      disabled={busy}
                      onPress={() => {
                        setError(null);
                        setStatus(null);
                        setRestoring(true);
                      }}
                    />
                  )}
                </>
              ) : prompting ? (
                <View style={styles.form}>
                  <View style={styles.warning} testID="backup_passphrase_warning">
                    <Text style={styles.warningTitle}>Write this passphrase down first</Text>
                    <Text style={styles.warningLine}>
                      The recovery passphrase is the only thing that can ever unlock this backup. It
                      is not stored anywhere, not on this device and not on the server, and it
                      cannot be reset or recovered.
                    </Text>
                    <Text style={styles.warningLine}>
                      If you lose it, the backup is permanently unreadable - by you and by everyone
                      else. Use at least 12 characters and keep it somewhere safe.
                    </Text>
                  </View>
                  <Field
                    testID="backup_passphrase"
                    label="Recovery passphrase"
                    value={passphrase}
                    onChangeText={setPassphrase}
                    secure
                  />
                  <Field
                    testID="backup_passphrase_confirm"
                    label="Confirm recovery passphrase"
                    value={passphraseConfirm}
                    onChangeText={setPassphraseConfirm}
                    secure
                  />
                  <Button
                    testID="backup_passphrase_submit"
                    label="Enable backup"
                    busy={busy}
                    onPress={enableBackup}
                  />
                  <Button
                    testID="backup_passphrase_cancel"
                    label="Cancel"
                    variant="ghost"
                    disabled={busy}
                    onPress={() => {
                      setPassphrase('');
                      setPassphraseConfirm('');
                      setPrompting(false);
                      setError(null);
                    }}
                  />
                </View>
              ) : (
                <Button
                  testID="backup_enable"
                  label="Enable backup"
                  disabled={busy}
                  onPress={() => {
                    setError(null);
                    setPrompting(true);
                  }}
                />
              )}
            </>
          )}

          <SectionLabel>Danger</SectionLabel>
          {hasEnvelope === true ? (
            <Button
              testID="backup_disable"
              label="Turn off backup and delete cloud data"
              variant="danger"
              disabled={busy}
              onPress={() => {
                setConfirmingDisable(true);
              }}
            />
          ) : null}
          <Paragraph>
            Deleting the account removes the backup and then the account itself, so the same email
            can be registered again from scratch. The vault on this device, its photos and its PIN
            are not touched: they are local, and this account was never able to reach them.
          </Paragraph>
          {deleting ? (
            <View style={styles.form}>
              <Paragraph>
                This is the account password you sign in with - not your PIN, and not the recovery
                passphrase. Deleting an account is refused on an old sign-in, so it is proved again
                here, before anything is deleted rather than after.
              </Paragraph>
              <Field
                testID="backup_delete_password"
                label="Account password"
                value={deletePassword}
                onChangeText={setDeletePassword}
                secure
              />
              <Button
                testID="backup_delete_submit"
                label="Delete account"
                variant="danger"
                busy={busy}
                onPress={() => {
                  setError(null);
                  setConfirmingDeleteAccount(true);
                }}
              />
              <Button
                testID="backup_delete_cancel"
                label="Cancel"
                variant="ghost"
                disabled={busy}
                onPress={() => {
                  setDeletePassword('');
                  setDeleting(false);
                  setError(null);
                }}
              />
            </View>
          ) : (
            <Button
              testID="backup_delete_account"
              label="Delete backup account"
              variant="danger"
              disabled={busy}
              onPress={() => {
                setError(null);
                setStatus(null);
                setDeleting(true);
              }}
            />
          )}
        </>
      )}

      <ConfirmDialog
        testID="backup_nothing_dialog"
        visible={nothingToUpload !== null}
        title="Nothing to upload"
        message={nothingToUpload ?? ''}
        confirmLabel="OK"
        hideCancel
        onConfirm={() => {
          setNothingToUpload(null);
        }}
        onCancel={() => {
          setNothingToUpload(null);
        }}
      />

      <ConfirmDialog
        testID="backup_disable_dialog"
        visible={confirmingDisable}
        title="Turn off cloud backup?"
        message={
          'Every backed-up photo and the key envelope are deleted from the cloud. The photos on ' +
          'this device are not touched.'
        }
        confirmLabel="Turn off"
        destructive
        busy={busy}
        onConfirm={disableBackup}
        onCancel={() => {
          setConfirmingDisable(false);
        }}
      />

      <TypedConfirmDialog
        testID="backup_delete_account_dialog"
        visible={confirmingDeleteAccount}
        phrase="DELETE"
        title="Delete backup account?"
        message={
          "Everything in this account's backup is deleted first, then the account itself. This " +
          'cannot be undone. The vault on this device, its photos and its PIN are untouched.'
        }
        confirmLabel="Delete account"
        destructive
        busy={busy}
        onConfirm={deleteAccount}
        onCancel={() => {
          setConfirmingDeleteAccount(false);
        }}
      />
    </Screen>
  );
}

function HowItWorks(): React.JSX.Element {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.card} testID="backup_explainer">
      <Text style={styles.cardTitle}>How cloud backup works</Text>
      {HOW_IT_WORKS.map((line) => (
        <View key={line} style={styles.point}>
          <Text style={styles.bullet}>{'•'}</Text>
          <Text style={styles.cardLine}>{line}</Text>
        </View>
      ))}
    </View>
  );
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

function formatTimestamp(epochMs: number): string {
  const date = new Date(epochMs);
  return `${date.toDateString()}, ${date.toTimeString().slice(0, 5)}`;
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      padding: spacing.md,
      gap: spacing.sm,
    },
    cardTitle: { ...typography.label, color: colors.text, fontSize: 16 },
    cardLine: { ...typography.body, color: colors.textMuted, flex: 1, lineHeight: 22 },
    point: { flexDirection: 'row', gap: spacing.sm },
    bullet: { ...typography.body, color: colors.accent },
    form: { gap: spacing.sm },
    body: { ...typography.body, color: colors.text },
    muted: { ...typography.caption, color: colors.textMuted },
    error: { ...typography.label, color: colors.danger },
    status: { ...typography.label, color: colors.success },
    warning: {
      backgroundColor: colors.surfaceAlt,
      borderRadius: radius.md,
      borderLeftWidth: 3,
      borderLeftColor: colors.danger,
      padding: spacing.md,
      gap: spacing.xs,
    },
    warningTitle: { ...typography.label, color: colors.text, fontSize: 16 },
    warningLine: { ...typography.body, color: colors.textMuted, lineHeight: 22 },
  });
