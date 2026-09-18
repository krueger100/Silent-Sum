/**
 * PIN creation (first run) and PIN change (from settings), in one component.
 *
 * The PIN only ever exists in this component's transient state: it is handed to the auth service
 * and dropped. It is never logged, never persisted, never put in navigation params and never
 * rendered - the dots above the keypad show a count, nothing else.
 *
 * Argon2id blocks the JS thread for a few hundred milliseconds on a real device, so the busy state
 * is painted and a frame yielded before the derivation starts; without the yield the spinner would
 * only appear after the work it is meant to cover. The hardware back button is blocked for the
 * same window, because unmounting mid-derivation would abandon a half-written credential record.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, StyleSheet, Text, View } from 'react-native';

import { useServices } from '@/app/ServicesProvider';
import {
  formatDuration,
  radius,
  spacing,
  type Palette,
  typography,
  useStyles,
  useTheme,
} from '@/app/theme';
import { describePinError, validatePin } from '@/auth/pinPolicy';
import { PinDots, PinKeypad } from '@/auth/screens/PinKeypad';
import {
  CredentialsUnreadableError,
  InvalidPinError,
  NoVaultError,
  PIN_POLICY,
  VaultAlreadyExistsError,
} from '@/auth/types';
import { Button } from '@/components/Button';
import { Paragraph, Screen } from '@/components/Screen';
import type { VaultKeys } from '@/crypto/types';
import { ANALYTICS_EVENTS, logEventSafely } from '@/firebase/types';

export type PinSetupMode = 'create' | 'change';

export interface PinSetupScreenProps {
  /** `create` is the first run; `change` verifies the current PIN first. */
  mode: PinSetupMode;
  /** Called from the success screen. The navigator decides where to go next. */
  onDone: () => void;
  /** Back affordance. Hidden while a key derivation is in flight. */
  onCancel?: () => void;
  /** Offered during `create` when a cloud backup could be restored instead. */
  onRestoreInstead?: () => void;
}

type Step = 'current' | 'enter' | 'confirm' | 'working' | 'done';

const MISMATCH = 'Those PINs do not match. Type the same PIN again to confirm.';

export function PinSetupScreen({
  mode,
  onDone,
  onCancel,
  onRestoreInstead,
}: PinSetupScreenProps): React.JSX.Element {
  const colors = useTheme();
  const styles = useStyles(makeStyles);
  const services = useServices();
  const create = mode === 'create';

  const [step, setStep] = useState<Step>(create ? 'enter' : 'current');
  const [typed, setTyped] = useState('');
  const [currentPin, setCurrentPin] = useState('');
  const [firstPin, setFirstPin] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mounted = useRef(true);
  /** Keys of a vault just created, owned by this screen until the user presses Done. */
  const pendingKeys = useRef<VaultKeys | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Leaving without finishing must not strand live key material.
      pendingKeys.current?.dispose();
      pendingKeys.current = null;
    };
  }, []);

  // A half-finished setupPin/changePin must not be abandoned by a back press.
  useEffect(() => {
    if (step !== 'working') return undefined;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => {
      subscription.remove();
    };
  }, [step]);

  const restart = useCallback((message: string | null, next: Step) => {
    if (!mounted.current) return;
    setError(message);
    setTyped('');
    setFirstPin('');
    if (next === 'current') setCurrentPin('');
    setStep(next);
  }, []);

  const handleDigit = useCallback((digit: string) => {
    setError(null);
    setTyped((value) => (value.length >= PIN_POLICY.maxLength ? value : value + digit));
  }, []);

  const handleBackspace = useCallback(() => {
    setTyped((value) => value.slice(0, -1));
  }, []);

  /**
   * Creates the vault. The keys are parked in a ref rather than adopted inline, so that whatever
   * happens next - including this screen being unmounted the instant the session unlocks - there
   * is exactly one owner of that key material and it is always either handed over or disposed.
   *
   * `onboardingDone` is recorded here: the vault genuinely exists from this moment, even if the
   * process dies before the handover.
   */
  const commitCreate = useCallback(
    async (pin: string): Promise<void> => {
      const keys = await services.auth.setupPin(pin);
      pendingKeys.current = keys;
      await services.settings.update({ onboardingDone: true });
      logEventSafely(services.firebase.analytics, ANALYTICS_EVENTS.vaultSetup);
    },
    [services],
  );

  /**
   * Hands the new vault over: open it, unlock the session, then tell the navigator.
   *
   * The vault is opened BEFORE the session is adopted, so that the instant `isUnlocked` flips there
   * is already a repository behind it and no vault screen can mount against a closed vault. Safe to
   * call twice: once the keys are handed over it only re-signals `onDone`.
   */
  const finishCreate = useCallback((): void => {
    const keys = pendingKeys.current;
    if (keys === null) {
      onDone();
      return;
    }
    pendingKeys.current = null;
    void (async () => {
      try {
        await services.vault.open(keys);
        services.session.adopt(keys);
      } catch {
        keys.dispose();
        if (mounted.current) {
          // The vault exists and the PIN works; it just could not be opened right now.
          setError(
            'The vault was created but could not be opened. Type your PIN on the calculator.',
          );
        }
      }
      onDone();
    })();
  }, [onDone, services]);

  /** Returns where to restart when the change was refused, or null on success. */
  const commitChange = useCallback(
    async (current: string, next: string): Promise<{ message: string; step: Step } | null> => {
      const result = await services.auth.changePin(current, next);
      switch (result.kind) {
        case 'success':
          return null;
        case 'wrongCurrent':
          return { message: 'That is not your current PIN.', step: 'current' };
        case 'throttled':
          return {
            message: `Too many attempts. Try again in ${formatDuration(result.remainingMs)}.`,
            step: 'current',
          };
        case 'invalidNew':
          return { message: describePinError(result.error), step: 'enter' };
        default:
          return { message: 'The PIN could not be changed.', step: 'enter' };
      }
    },
    [services],
  );

  const commit = useCallback(
    async (pin: string): Promise<void> => {
      setError(null);
      setStep('working');
      // Let the busy state paint before Argon2id takes the thread.
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      try {
        if (create) {
          await commitCreate(pin);
        } else {
          const refusal = await commitChange(currentPin, pin);
          if (refusal !== null) {
            restart(refusal.message, refusal.step);
            return;
          }
        }
        if (!mounted.current) return;
        setTyped('');
        setFirstPin('');
        setCurrentPin('');
        setStep('done');
        // First run ends in the open vault. The success screen below is what a navigator that does
        // NOT swap on unlock would show; the session-gated one takes over before it is read.
        if (create) finishCreate();
      } catch (cause) {
        restart(describeSetupFailure(cause), create ? 'enter' : 'current');
      }
    },
    [commitChange, commitCreate, create, currentPin, finishCreate, restart],
  );

  const handleNext = useCallback(() => {
    if (typed.length === 0) return;
    switch (step) {
      case 'current':
        setCurrentPin(typed);
        setTyped('');
        setError(null);
        setStep('enter');
        return;
      case 'enter': {
        const problem = validatePin(typed);
        if (problem !== null) {
          setError(describePinError(problem));
          return;
        }
        setFirstPin(typed);
        setTyped('');
        setError(null);
        setStep('confirm');
        return;
      }
      case 'confirm':
        if (typed !== firstPin) {
          // The confirmation starts over; "Start over" goes back to choosing the PIN itself.
          setTyped('');
          setError(MISMATCH);
          return;
        }
        void commit(typed);
        return;
      default:
        return;
    }
  }, [commit, firstPin, step, typed]);

  const title = create ? 'Set up your vault' : 'Change your PIN';

  if (step === 'working') {
    return (
      <Screen title={title} testID="pin_setup_screen">
        <View style={styles.centered} testID="pin_busy">
          <ActivityIndicator size="large" color={colors.accent} />
          <Text style={styles.busyText}>Deriving your vault key</Text>
          <Paragraph>
            This takes a moment on purpose: it is what makes guessing the PIN expensive.
          </Paragraph>
        </View>
      </Screen>
    );
  }

  if (step === 'done') {
    return (
      <Screen title={title} scroll testID="pin_setup_screen">
        <Text style={styles.heading}>{create ? 'Your vault is ready' : 'PIN changed'}</Text>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>How to open the vault</Text>
          <Text style={styles.cardLine}>
            1. Work out sums that total your PIN, whole or a part at a time.
          </Text>
          <Text style={styles.cardLine}>2. Press the = key.</Text>
          <Text style={styles.cardLine}>3. The vault opens. Lock it again whenever you like.</Text>
        </View>
        <Paragraph>
          There is no recovery. If you forget this PIN, nobody can open the vault, including us: the
          photos are encrypted with a key that only the PIN unwraps.
        </Paragraph>
        {error === null ? null : (
          <Text testID="pin_error" style={styles.error}>
            {error}
          </Text>
        )}
        <Button
          testID="pin_done"
          label={create ? 'Open the vault' : 'Done'}
          onPress={create ? finishCreate : onDone}
        />
      </Screen>
    );
  }

  const copy = copyForStep(step, create);

  return (
    <Screen
      title={title}
      scroll
      testID="pin_setup_screen"
      {...(onCancel === undefined ? {} : { onBack: onCancel })}
    >
      <Text style={styles.heading}>{copy.heading}</Text>
      <Paragraph>{copy.subtitle}</Paragraph>
      <PinDots count={typed.length} />
      <View style={styles.errorSlot}>
        {error === null ? null : (
          <Text testID="pin_error" style={styles.error}>
            {error}
          </Text>
        )}
      </View>
      <PinKeypad onDigit={handleDigit} onBackspace={handleBackspace} />
      <Button
        testID="pin_next"
        label={copy.action}
        onPress={handleNext}
        disabled={typed.length === 0}
      />
      {step === 'confirm' ? (
        <Button
          testID="pin_start_over"
          label="Start over"
          variant="ghost"
          onPress={() => {
            restart(null, 'enter');
          }}
        />
      ) : null}
      {create && step === 'enter' && onRestoreInstead !== undefined ? (
        <Button
          testID="pin_restore_instead"
          label="Restore from a cloud backup instead"
          variant="ghost"
          onPress={onRestoreInstead}
        />
      ) : null}
    </Screen>
  );
}

function copyForStep(
  step: Step,
  create: boolean,
): { heading: string; subtitle: string; action: string } {
  switch (step) {
    case 'current':
      return {
        heading: 'Enter your current PIN',
        subtitle: 'This proves it is you before the PIN is replaced.',
        action: 'Next',
      };
    case 'confirm':
      return {
        heading: 'Confirm your PIN',
        subtitle: 'Type the same PIN once more, so a typo cannot lock you out.',
        action: 'Confirm',
      };
    default:
      return {
        heading: create ? 'Choose a vault PIN' : 'Choose a new PIN',
        subtitle:
          `${String(PIN_POLICY.minLength)} to ${String(PIN_POLICY.maxLength)} digits, not ` +
          'starting with 0. Calculations answering parts of it add up to open the vault.',
        action: 'Next',
      };
  }
}

/** Failure copy. Never echoes anything derived from the PIN. */
function describeSetupFailure(cause: unknown): string {
  if (cause instanceof InvalidPinError) return cause.message;
  if (cause instanceof VaultAlreadyExistsError) {
    return 'A vault already exists on this device. Change its PIN instead, or erase it first.';
  }
  if (cause instanceof NoVaultError) return 'There is no vault PIN to change yet.';
  if (cause instanceof CredentialsUnreadableError) {
    return 'The stored vault credentials cannot be read. Erasing the vault is the only way forward.';
  }
  return 'Something went wrong. Nothing was changed; please try again.';
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.md,
      padding: spacing.lg,
    },
    busyText: { ...typography.body, color: colors.text },
    heading: { ...typography.title, color: colors.text, textAlign: 'center' },
    errorSlot: { minHeight: 40, justifyContent: 'center' },
    error: { ...typography.label, color: colors.danger, textAlign: 'center' },
    card: {
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      padding: spacing.md,
      gap: spacing.xs,
    },
    cardTitle: { ...typography.label, color: colors.text, fontSize: 16 },
    cardLine: { ...typography.body, color: colors.textMuted },
  });
