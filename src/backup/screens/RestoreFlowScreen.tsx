/**
 * Restoring a vault onto a fresh device.
 *
 * Order matters here, and it is the whole point of the screen. Signing in only says WHERE the
 * ciphertext is, so the first thing that happens afterwards is asking the account whether it has a
 * backup at all -- an account with nothing in it is a dead end, and the user is told that instead
 * of being walked through two more steps to find out. Then the recovery passphrase is checked by
 * actually unwrapping the master key out of the envelope, BEFORE a PIN is chosen and before a byte
 * is downloaded: a wrong passphrase costs one Argon2id run and nothing else. Only once the key is
 * in hand is it re-wrapped under a PIN chosen on THIS device, and only then does the download
 * start. The cloud account never gains the ability to open the vault, and the new PIN is local
 * from the first moment.
 *
 * The recovered master key is a raw buffer that this component owns for a few hundred
 * milliseconds; it is zeroed in a `finally` whatever happens. And a session adopted mid-flow is
 * locked again if the user walks away before the vault is actually handed over.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BackHandler, StyleSheet, Text, View } from 'react-native';

import { useServices } from '@/app/ServicesProvider';
import { radius, spacing, type Palette, typography, useStyles } from '@/app/theme';
import { describePinError, validatePin } from '@/auth/pinPolicy';
import type { VaultKeys } from '@/crypto/types';
import { PIN_POLICY } from '@/auth/types';
import { describeCloudError } from '@/backup/screens/cloudErrors';
import { restoreMessagingIdentity } from '@/messaging/identityRecovery';
import type { RecoveredIdentityResult } from '@/messaging/messagingService';
import { describeMessagingRestore } from '@/messaging/restoreNotice';
import { requestPasswordReset, RESET_REASSURANCE } from '@/backup/screens/passwordReset';
import { validatePassphrase } from '@/backup/passphrasePolicy';
import type { BackupProgress, BackupService } from '@/backup/types';
import { cloudActive } from '@/billing/entitlements';
import { CloudRequiredCard } from '@/billing/screens/CloudRequiredCard';
import { Button } from '@/components/Button';
import { ProgressBar } from '@/components/ProgressBar';
import { Field } from '@/components/Field';
import { Paragraph, Screen } from '@/components/Screen';
import { ANALYTICS_EVENTS, logEventSafely, type CloudBackend } from '@/firebase/types';
import { zeroBytes, type Bytes } from '@/utils/bytes';

export interface RestoreFlowScreenProps {
  /** Called when the restored vault is handed over. The session stays unlocked. */
  onDone: () => void;
  /** Back affordance. Ignored while the restore is running. */
  onBack?: () => void;
  /** Where "See plans" goes when the account's Cloud term has lapsed. */
  onPlans?: () => void;
  /**
   * Replace a vault that is already on this device.
   *
   * Only ever true on the support-issued recovery path, where the user has told us they cannot
   * open the vault that is here. Normally `adoptMasterKey` refuses outright, so that a restore
   * can never silently orphan photos someone can still reach.
   *
   * The replacement happens at the END of the flow rather than the start, which is the whole
   * reason this is a flag and not an erase step: by then the passphrase has already unwrapped
   * the key, so the vault on the device is only given up once the replacement is certain. Erase
   * first and a mistyped passphrase costs the user everything.
   */
  allowOverwrite?: boolean;
}

type Step = 'account' | 'cloudRequired' | 'missing' | 'passphrase' | 'pin' | 'working' | 'done';

export function RestoreFlowScreen({
  onDone,
  onBack,
  onPlans,
  allowOverwrite = false,
}: RestoreFlowScreenProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const services = useServices();
  const backup = services.backup;
  const cloud = services.firebase.cloud;

  if (backup === null || cloud === null || !services.firebase.available) {
    return (
      <Screen
        title="Restore from backup"
        scroll
        testID="restore_flow_screen"
        {...(onBack === undefined ? {} : { onBack })}
      >
        <View style={styles.card} testID="restore_unavailable">
          <Text style={styles.cardTitle}>Cloud backup is not available in this build</Text>
          <Text style={styles.cardLine}>
            There is no cloud configuration in this copy of the app, so there is nothing to restore
            from. Set up a new vault instead.
          </Text>
        </View>
      </Screen>
    );
  }

  return (
    <RestoreFlowBody
      backup={backup}
      cloud={cloud}
      onDone={onDone}
      allowOverwrite={allowOverwrite}
      {...(onBack === undefined ? {} : { onBack })}
      {...(onPlans === undefined ? {} : { onPlans })}
    />
  );
}

function RestoreFlowBody({
  backup,
  cloud,
  onDone,
  onBack,
  onPlans,
  allowOverwrite,
}: {
  backup: BackupService;
  cloud: CloudBackend;
  onDone: () => void;
  onBack?: () => void;
  onPlans?: () => void;
  allowOverwrite: boolean;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const services = useServices();

  const [step, setStep] = useState<Step>('account');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [report, setReport] = useState<RestoreTally | null>(null);
  /**
   * Photos finished so far. Null until the download starts, which is a real and slow phase here:
   * Argon2id runs first, then the envelope and index are fetched, and none of that is countable.
   */
  const [progress, setProgress] = useState<{ readonly done: number; readonly total: number } | null>(
    null,
  );

  const mounted = useRef(true);
  const adopted = useRef(false);
  const handedOff = useRef(false);
  /**
   * The restored keys, held until the "Open vault" button.
   *
   * Adopting the session is what makes `useIsUnlocked()` true, and the navigator swaps the whole
   * locked stack - this screen included - the moment it is. Doing that before the restore has
   * finished unmounted this component mid-download, and the unmount guard below then locked the
   * session straight back again: the vault came out empty and the user landed on the calculator
   * with no error anywhere. So the session is adopted last, by the button, and not before.
   */
  const restoredKeys = useRef<VaultKeys | null>(null);
  /**
   * The master key, from the moment the passphrase is verified until it is re-wrapped under the
   * new PIN. Holding it across one step is what lets the passphrase be checked before the user is
   * asked for a PIN, and it costs a single 64 MiB Argon2id run instead of two.
   */
  const recoveredMaster = useRef<Bytes | null>(null);
  /**
   * The key that opens this account's MESSAGING, when that is not the one above.
   *
   * Null in the ordinary case, where the envelope's key is the messaging key and there is nothing
   * extra to hold. Non-null only for an account whose messaging was set up by a different vault,
   * where it is derived here -- during the passphrase step, because `setPassphrase('')` below is
   * the last moment the passphrase exists and deriving it later would mean keeping the passphrase
   * around for a whole restore to avoid one Argon2id run. Zeroed wherever the master key is.
   */
  const recoveredMessaging = useRef<Bytes | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Whatever route the screen leaves by -- finished, abandoned, or a navigator swap -- the raw
  // master key does not outlive it.
  useEffect(
    () => () => {
      const messaging = recoveredMessaging.current;
      recoveredMessaging.current = null;
      if (messaging !== null) zeroBytes(messaging);
      const master = recoveredMaster.current;
      recoveredMaster.current = null;
      if (master !== null) zeroBytes(master);
    },
    [],
  );

  // Abandoning the flow after the key was adopted must not leave an unlocked vault behind.
  useEffect(
    () => () => {
      if (adopted.current && !handedOff.current) services.session.lock();
    },
    [services],
  );

  useEffect(() => {
    if (step !== 'working') return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => {
      subscription.remove();
    };
  }, [step]);

  const signIn = useCallback((): void => {
    setError(null);
    setNotice(null);
    void (async () => {
      const secret = password;
      setPassword('');
      try {
        await cloud.signIn(email.trim(), secret);
        // Restore is a SilentSum Cloud feature. The live document is read here, not the cache:
        // this is usually a new phone, and the cache on it says nothing about this account.
        const owned = await services.entitlements.refresh();
        if (!mounted.current) return;
        if (services.entitlements.enforced && !cloudActive(owned, services.clock.now())) {
          setStep('cloudRequired');
          return;
        }
        // Ask before promising. An account with no envelope has nothing to restore, and finding
        // that out after typing a passphrase and inventing a PIN reads like the passphrase was
        // wrong.
        const found = await backup.hasEnvelope();
        if (!mounted.current) return;
        setStep(found ? 'passphrase' : 'missing');
      } catch (cause) {
        if (mounted.current) setError(describeCloudError(cause));
      }
    })();
  }, [backup, cloud, email, password, services]);

  /** Leaves the dead-end account. Signing out first, so the next attempt starts clean. */
  const useAnotherAccount = useCallback((): void => {
    setError(null);
    setNotice(null);
    void (async () => {
      try {
        await cloud.signOut();
      } catch {
        // The session is being abandoned either way.
      }
      if (!mounted.current) return;
      setPassword('');
      setStep('account');
    })();
  }, [cloud]);

  /**
   * Recovers the ACCOUNT password only. It is offered here because a user restoring onto a new
   * phone is exactly the user most likely to have forgotten it -- and it changes nothing about
   * what step 2 will still demand.
   */
  const forgotPassword = useCallback((): void => {
    setError(null);
    setNotice(null);
    void (async () => {
      const outcome = await requestPasswordReset(cloud, email);
      if (!mounted.current) return;
      if (outcome.kind === 'requested') setNotice(outcome.message);
      else setError(outcome.message);
    })();
  }, [cloud, email]);

  /**
   * Checks the passphrase by unwrapping the envelope with it, here and not later.
   *
   * The alternative -- take it on trust, collect a PIN, then fail during the restore -- is how a
   * user ends up believing the wrong thing about which secret they have lost, on a device whose
   * vault they have usually just erased to get here.
   */
  const confirmPassphrase = useCallback((): void => {
    if (validatePassphrase(passphrase) !== null) {
      setError('Enter the full recovery passphrase you chose when you enabled backup.');
      return;
    }
    setError(null);
    setVerifying(true);
    void (async () => {
      // Paint the busy state before Argon2id takes the thread.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      try {
        const master = await backup.recoverMasterKey(passphrase);
        const previous = recoveredMaster.current;
        if (previous !== null) zeroBytes(previous);
        recoveredMaster.current = master;
        // One document read. A second Argon2id is only spent on an account whose messaging the
        // envelope's key cannot open -- which is exactly the account this whole change is for.
        const staleMessaging = recoveredMessaging.current;
        if (staleMessaging !== null) zeroBytes(staleMessaging);
        recoveredMessaging.current = (await backup.messagingKeyIsMine(master))
          ? null
          : await backup.recoverMessagingKey(passphrase);
        if (!mounted.current) return;
        setPassphrase('');
        setStep('pin');
      } catch (cause) {
        if (mounted.current) setError(describeCloudError(cause));
      } finally {
        if (mounted.current) setVerifying(false);
      }
    })();
  }, [backup, passphrase]);

  const restore = useCallback((): void => {
    const problem = validatePin(pin);
    if (problem !== null) {
      setError(describePinError(problem));
      return;
    }
    if (pin !== pinConfirm) {
      setError('Those PINs do not match.');
      return;
    }
    const master = recoveredMaster.current;
    if (master === null) {
      // Only reachable if the key was zeroed underneath this step. Asking again is the safe
      // answer; there is no way to conjure it back.
      setError('Enter your recovery passphrase again.');
      setStep('passphrase');
      return;
    }
    setError(null);
    void (async () => {
      setStep('working');
      // Paint the busy state before Argon2id takes the thread.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      try {
        const keys = await services.auth.adoptMasterKey(master, pin, {
          overwrite: allowOverwrite,
        });
        restoredKeys.current = keys;
        // The master key has done its one job: it is wrapped under the new PIN and the session
        // sub-keys are derived. Nothing below needs the raw bytes again.
        zeroBytes(master);
        recoveredMaster.current = null;
        const repository = await services.vault.open(keys);
        const onProgress: BackupProgress = (done, total) => {
          if (mounted.current) setProgress({ done, total });
        };
        const result = await backup.restoreInto(repository, keys, onProgress);
        // A new device, which is the case this whole screen exists for -- and the one where
        // messaging silently did not come back. The vault key is already adopted here, so it is
        // handed over first and the escrow is only paid for if that key is not the account's.
        // The passphrase is long gone by now, deliberately. `confirmPassphrase` left behind
        // whichever keys are needed, which is all this call wants.
        const messagingKey = recoveredMessaging.current;
        const messagingOutcome = await restoreMessagingIdentity(backup, services.messaging, '', {
          vaultMasterKey: keys.masterKey,
          ...(messagingKey === null ? {} : { messagingMasterKey: messagingKey }),
        });
        setReport({
          restored: result.restored,
          skipped: result.skipped,
          missing: result.missing,
          messaging: messagingOutcome,
        });
        await services.settings.update({ onboardingDone: true, backupEnabled: true });
        logEventSafely(services.firebase.analytics, ANALYTICS_EVENTS.restoreCompleted);
        if (!mounted.current) return;
        setPin('');
        setPinConfirm('');
        setStep('done');
      } catch (cause) {
        if (!mounted.current) return;
        setError(describeCloudError(cause));
        setStep('pin');
      }
    })();
  }, [allowOverwrite, backup, pin, pinConfirm, services]);

  const canGoBack = onBack !== undefined && step !== 'working';

  return (
    <Screen
      title="Restore from backup"
      scroll
      testID="restore_flow_screen"
      {...(canGoBack && onBack !== undefined ? { onBack } : {})}
    >
      {error === null ? null : (
        <Text testID="restore_error" style={styles.error}>
          {error}
        </Text>
      )}
      {notice === null ? null : (
        <Text testID="restore_notice" style={styles.notice}>
          {notice}
        </Text>
      )}

      {step === 'account' ? (
        <View style={styles.form}>
          <Text style={styles.heading}>1. Sign in to your backup account</Text>
          <Paragraph>
            This account only locates your encrypted backup. It is not your vault PIN and it cannot
            open the vault on its own.
          </Paragraph>
          <Field
            testID="restore_email"
            label="Email"
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
          />
          <Field
            testID="restore_password"
            label="Account password"
            value={password}
            onChangeText={setPassword}
            secure
          />
          <Button testID="restore_sign_in" label="Sign in" onPress={signIn} />
          <Button
            testID="restore_forgot_password"
            label="Forgot account password?"
            variant="ghost"
            onPress={forgotPassword}
          />
          <Text testID="restore_reset_note" style={styles.note}>
            {RESET_REASSURANCE}
          </Text>
        </View>
      ) : null}

      {step === 'cloudRequired' ? (
        <View style={styles.form}>
          <CloudRequiredCard
            feature="restore"
            testID="restore_cloud_required"
            {...(onPlans === undefined ? {} : { onPlans })}
          />
          <Button
            testID="restore_other_account"
            label="Use a different account"
            variant="secondary"
            onPress={useAnotherAccount}
          />
        </View>
      ) : null}

      {step === 'missing' ? (
        <View style={styles.form} testID="restore_missing">
          <Text style={styles.heading}>No backup found for this account</Text>
          <Paragraph>
            You are signed in, but this account has no encrypted backup stored against it. There is
            nothing here to restore. If you used a different email for backup, sign in with that one
            instead.
          </Paragraph>
          <Button
            testID="restore_other_account"
            label="Use a different account"
            variant="secondary"
            onPress={useAnotherAccount}
          />
        </View>
      ) : null}

      {step === 'passphrase' ? (
        <View style={styles.form}>
          <Text style={styles.heading}>2. Enter your recovery passphrase</Text>
          <Paragraph>
            The passphrase you chose when you enabled backup. It is the only thing that can unwrap
            the key; without it the backup is unreadable, including to us.
          </Paragraph>
          <Field
            testID="restore_passphrase"
            label="Recovery passphrase"
            value={passphrase}
            onChangeText={setPassphrase}
            secure
          />
          <Button
            testID="restore_passphrase_next"
            label="Next"
            busy={verifying}
            onPress={confirmPassphrase}
          />
        </View>
      ) : null}

      {step === 'pin' ? (
        <View style={styles.form}>
          <Text style={styles.heading}>3. Choose a PIN for this device</Text>
          <Paragraph>
            {`${String(PIN_POLICY.minLength)} to ${String(PIN_POLICY.maxLength)} digits, not ` +
              'starting with 0. You will type it on the calculator and press = to open the vault. ' +
              'It is stored nowhere and it never reaches the cloud.'}
          </Paragraph>
          <Field
            testID="restore_pin"
            label="New PIN"
            value={pin}
            onChangeText={setPin}
            secure
            keyboardType="number-pad"
          />
          <Field
            testID="restore_pin_confirm"
            label="Confirm PIN"
            value={pinConfirm}
            onChangeText={setPinConfirm}
            secure
            keyboardType="number-pad"
          />
          {allowOverwrite ? (
            <Text testID="restore_overwrite_warning" style={styles.warning}>
              This replaces the vault already on this device. Anything added since the last backup
              was taken is not in the backup and will not come back.
            </Text>
          ) : null}
          <Button testID="restore_submit" label="Restore vault" onPress={restore} />
        </View>
      ) : null}

      {step === 'working' ? (
        <View style={styles.busy} testID="restore_busy">
          <Text style={styles.heading}>Restoring your vault</Text>
          <ProgressBar
            testID="restore_progress"
            {...(progress === null
              ? {}
              : { value: progress.total === 0 ? 1 : progress.done / progress.total })}
            {...(progress === null || progress.total === 0
              ? {}
              : { label: `${String(progress.done)} of ${String(progress.total)} photos` })}
          />
          <Paragraph>
            Unwrapping the key and downloading your encrypted photos. Please keep the app open.
          </Paragraph>
        </View>
      ) : null}

      {step === 'done' ? (
        <View style={styles.form}>
          <Text style={styles.heading}>Restore complete</Text>
          <Text testID="restore_summary" style={styles.body}>
            {report === null ? 'Your vault is ready.' : describeRestore(report)}
          </Text>
          <Paragraph>
            From now on, type your new PIN on the calculator and press = to open the vault.
          </Paragraph>
          <Button
            testID="restore_done"
            label="Open vault"
            onPress={() => {
              handedOff.current = true;
              const keys = restoredKeys.current;
              if (keys !== null) {
                adopted.current = true;
                services.session.adopt(keys);
              }
              onDone();
            }}
          />
        </View>
      ) : null}
    </Screen>
  );
}

/** What the restore did, in the three outcomes an item can have. */
interface RestoreTally {
  readonly restored: number;
  readonly skipped: number;
  readonly missing: number;
  readonly messaging: RecoveredIdentityResult;
}

/**
 * The restore, in plain sentences.
 *
 * This screen restores into a vault that was just created, so `skipped` is almost always zero
 * and `missing` is almost always a real loss. The old line read "Restored 45 photos, skipped 28
 * photos" either way -- a number that sounded procedural for the one thing on this screen the
 * user cannot recover from and would want to know about immediately.
 */
function describeRestore(report: RestoreTally): string {
  const sentences = [`Restored ${plural(report.restored, 'photo')}.`];
  if (report.skipped > 0) {
    sentences.push(`${plural(report.skipped, 'photo')} were already in this vault.`);
  }
  if (report.missing > 0) {
    sentences.push(
      `${plural(report.missing, 'photo')} could not be downloaded: the backup lists them, but ` +
        'their files are no longer in the cloud.',
    );
  }
  const messaging = describeMessagingRestore(report.messaging);
  if (messaging !== null) sentences.push(messaging);
  return sentences.join(' ');
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
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
    cardLine: { ...typography.body, color: colors.textMuted, lineHeight: 22 },
    form: { gap: spacing.sm },
    warning: { ...typography.label, color: colors.danger, lineHeight: 19 },
    heading: { ...typography.title, color: colors.text, fontSize: 18 },
    body: { ...typography.body, color: colors.text },
    error: { ...typography.label, color: colors.danger },
    notice: { ...typography.label, color: colors.accent },
    note: { ...typography.caption, color: colors.textMuted, lineHeight: 17 },
    busy: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xl },
  });
