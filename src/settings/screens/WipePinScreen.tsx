/**
 * Arming the wipe PIN.
 *
 * Everything dangerous about this feature is concentrated here, on purpose. Using the PIN asks one
 * question and then destroys what it was told to destroy, with nothing afterwards to undo it or
 * even to say it happened -- so the real deliberation has to happen now, while the user is safe,
 * unlocked and reading. That is why the page spells out what each scope destroys rather than
 * labelling three radio buttons, and why both choosing a scope and arming a PIN go through a dialog
 * that names the consequence again.
 *
 * **The armed scope and the draft scope are different things, and the page never mixes them.**
 * This is the whole reason the screen was rewritten. It used to hold one `scope` value that was
 * both "what the picker has selected" and "what is armed": it started at `device`, so a page with
 * nothing armed still showed a tick beside "This device", and a page with `both` armed showed the
 * same kind of tick with no way to tell which of the two it meant. Someone read that tick as the
 * truth, armed `both` by accident, and lost a cloud backup to it.
 *
 * So now:
 *
 * - {@link WipePinScreen.armed} comes from the stored record and nowhere else. It is printed once,
 *   in full, as `Wipe PIN active: <scope>`, and never abbreviated or inferred.
 * - The picker's `draft` starts at null and is NEVER seeded from the armed record. Nothing is
 *   ticked until the user ticks it, so a tick can only ever mean "I chose this, just now".
 * - Choosing a scope is itself confirmed, because a stray tap on a list row is precisely how the
 *   accident happened.
 *
 * The PIN itself is checked against the vault PIN before it can be armed. A wipe PIN hiding inside
 * the vault PIN would fire while its owner was unlocking, which would be the worst possible bug in
 * the worst possible place; `wipePinConflict` is what refuses it.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useServices } from '@/app/ServicesProvider';
import { spacing, type Palette, typography, useStyles } from '@/app/theme';
import { describePinError, validatePin } from '@/auth/pinPolicy';
import type { WipePinRecord, WipeScope } from '@/auth/types';
import {
  WIPE_PIN_RULE,
  WIPE_SCOPES,
  WIPE_SCOPE_CLOUD_WARNING,
  WIPE_SCOPE_DETAIL,
  WIPE_SCOPE_LABEL,
  scopeDeletesCloud,
  wipePinConflict,
} from '@/auth/wipePin';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { Field } from '@/components/Field';
import { ListRow } from '@/components/ListRow';
import { Paragraph, Screen, SectionLabel } from '@/components/Screen';

export interface WipePinScreenProps {
  onBack?: () => void;
}

/** What the user answers before a scope is even selected in the picker. */
function scopeChangeMessage(scope: WipeScope): string {
  return (
    `${WIPE_SCOPE_DETAIL[scope]}\n\n` +
    (scopeDeletesCloud(scope) ? `${WIPE_SCOPE_CLOUD_WARNING}\n\n` : '') +
    'Nothing is armed yet -- this only chooses what the PIN below would destroy.'
  );
}

/** The last thing between the user and an armed wipe PIN. It names the scope in full. */
function armMessage(scope: WipeScope): string {
  return (
    `Scope: ${WIPE_SCOPE_LABEL[scope]}\n\n` +
    `${WIPE_SCOPE_DETAIL[scope]}\n\n` +
    (scopeDeletesCloud(scope) ? `${WIPE_SCOPE_CLOUD_WARNING}\n\n` : '') +
    'From now on, calculating this number and pressing = asks once and then destroys that. Make ' +
    'sure it is not a number you would ever calculate by accident.'
  );
}

export function WipePinScreen({ onBack }: WipePinScreenProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const services = useServices();

  /** The stored record. The ONLY source for anything this page says is currently armed. */
  const [armed, setArmed] = useState<WipePinRecord | null>(null);
  /**
   * The scope being chosen for a new PIN.
   *
   * Null means "the user has not chosen", and it stays null until they do -- including when a PIN
   * is already armed, where seeding it from the record would put a tick on screen that the user
   * did not place and cannot distinguish from one they did.
   */
  const [draft, setDraft] = useState<WipeScope | null>(null);
  /** A scope the user has tapped but not yet confirmed. */
  const [pendingScope, setPendingScope] = useState<WipeScope | null>(null);
  const [pin, setPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async (): Promise<void> => {
    const record = await services.auth.wipePin();
    if (!mounted.current) return;
    setArmed(record);
  }, [services]);

  // The initial read is inlined here rather than calling `reload`, because a setState reached
  // straight out of an effect body is a cascading render and the lint rule that says so is right.
  // The action handlers below re-read through `reload`, where there is no effect involved.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const record = await services.auth.wipePin();
      if (cancelled) return;
      setArmed(record);
    })();
    return () => {
      cancelled = true;
    };
  }, [services]);

  /**
   * Tapping a scope row proposes it; the dialog is what actually selects it.
   *
   * A list row is a one-tap control, and one stray tap is how a device-only wipe PIN became a
   * both-scopes wipe PIN. Asking costs a tap and removes that entire class of accident.
   */
  const chooseScope = useCallback(
    (option: WipeScope): void => {
      if (option === draft) return;
      setNotice(null);
      setPendingScope(option);
    },
    [draft],
  );

  const applyScope = useCallback((): void => {
    setDraft(pendingScope);
    setPendingScope(null);
    setError(null);
  }, [pendingScope]);

  /** Everything that can be checked without writing anything, checked before the dialog. */
  const review = useCallback((): void => {
    setNotice(null);
    if (draft === null) {
      // Refused rather than defaulted. A wipe PIN whose scope the app picked is the bug.
      setError('Choose what this wipe PIN destroys first.');
      return;
    }
    const problem = validatePin(pin);
    if (problem !== null) {
      setError(describePinError(problem));
      return;
    }
    if (pin !== confirmPin) {
      setError('Those PINs do not match.');
      return;
    }
    void (async () => {
      const credentials = await services.auth.loadCredentials();
      const conflict = wipePinConflict(pin, credentials?.pin ?? null);
      if (!mounted.current) return;
      if (conflict !== null) {
        setError(describePinError(conflict));
        return;
      }
      setError(null);
      setConfirming(true);
    })();
  }, [confirmPin, draft, pin, services]);

  const arm = useCallback((): void => {
    const scope = draft;
    if (scope === null) return;
    setConfirming(false);
    setBusy(true);
    void (async () => {
      try {
        await services.auth.setWipePin(pin, scope);
        if (!mounted.current) return;
        setPin('');
        setConfirmPin('');
        // Back to nothing chosen, so the picker cannot be mistaken for a report of what is armed.
        setDraft(null);
        setError(null);
        setNotice(`Wipe PIN set. It destroys: ${WIPE_SCOPE_LABEL[scope]}.`);
        await reload();
      } catch (cause) {
        if (mounted.current) {
          setError(cause instanceof Error ? cause.message : 'That PIN cannot be used.');
        }
      } finally {
        if (mounted.current) setBusy(false);
      }
    })();
  }, [draft, pin, reload, services]);

  const disarm = useCallback((): void => {
    setBusy(true);
    void (async () => {
      try {
        await services.auth.clearWipePin();
        if (!mounted.current) return;
        setError(null);
        setNotice('Wipe PIN turned off. Nothing on the calculator wipes anything now.');
        await reload();
      } finally {
        if (mounted.current) setBusy(false);
      }
    })();
  }, [reload, services]);

  return (
    <Screen
      title="Wipe PIN"
      scroll
      testID="wipe_pin_screen"
      {...(onBack === undefined ? {} : { onBack })}
    >
      <Paragraph>
        A second PIN that destroys instead of opening. Type it on the calculator and it asks once,
        in a plain box; answer it and what you chose is destroyed in the background while the screen
        goes back to being a calculator - no notice, no navigation, nothing to undo.
      </Paragraph>
      <Paragraph>
        It also works while the vault is locked out after wrong attempts, so it cannot be disarmed
        by someone guessing at your real PIN first.
      </Paragraph>

      <Text testID="wipe_pin_status" style={styles.status}>
        {armed === null ? 'No wipe PIN is set.' : 'A wipe PIN is set.'}
      </Text>

      {/* The armed scope, read from the record and printed in full. This line is the answer to
          "what happens if that number is typed", and it is deliberately not the picker below. */}
      {armed === null ? null : (
        <Text testID="wipe_pin_active_scope" style={styles.active}>
          {`Wipe PIN active: ${WIPE_SCOPE_LABEL[armed.scope]}`}
        </Text>
      )}

      {/* Turning it off sits here, beside the line that says it is on, and not at the bottom of
          the form for replacing it. Someone who wants it gone -- because they forgot which number
          it was, or armed one by accident -- should not have to scroll past the thing that arms a
          new one to find it. It takes no confirmation either: this direction only ever makes the
          device safer. */}
      {armed === null ? null : (
        <Button
          testID="wipe_pin_clear"
          label="Turn off wipe PIN"
          variant="secondary"
          disabled={busy}
          onPress={disarm}
        />
      )}

      {error === null ? null : (
        <Text testID="wipe_pin_error" style={styles.error}>
          {error}
        </Text>
      )}
      {notice === null ? null : (
        <Text testID="wipe_pin_notice" style={styles.notice}>
          {notice}
        </Text>
      )}

      <SectionLabel>{armed === null ? 'What it destroys' : 'Replace it'}</SectionLabel>
      {armed === null ? null : (
        <Paragraph>
          Setting a PIN below replaces the one above, scope included. Nothing here is selected
          yet - what is armed right now is the line above, not this list.
        </Paragraph>
      )}
      <Text testID="wipe_pin_draft_scope" style={styles.draft}>
        {draft === null
          ? 'Nothing chosen yet.'
          : `The new wipe PIN will destroy: ${WIPE_SCOPE_LABEL[draft]}`}
      </Text>
      {WIPE_SCOPES.map((option) => (
        <ListRow
          key={option}
          testID={`wipe_scope_${option}`}
          label={WIPE_SCOPE_LABEL[option]}
          detail={WIPE_SCOPE_DETAIL[option]}
          destructive={scopeDeletesCloud(option)}
          onPress={() => {
            chooseScope(option);
          }}
          trailing={
            option === draft ? (
              <Text testID={`wipe_scope_${option}_selected`} style={styles.tick}>
                {'✓'}
              </Text>
            ) : null
          }
        />
      ))}
      <Text style={styles.caveat}>
        Deleting the cloud copy needs this device to still be signed in to your backup account. If
        it has been signed out, only the copy on this device can be destroyed.
      </Text>

      <SectionLabel>The PIN</SectionLabel>
      <Paragraph>{WIPE_PIN_RULE}</Paragraph>
      <Field
        testID="wipe_pin_input"
        label={armed === null ? 'Wipe PIN' : 'New wipe PIN'}
        value={pin}
        onChangeText={setPin}
        secure
        keyboardType="number-pad"
      />
      <Field
        testID="wipe_pin_confirm_input"
        label="Confirm"
        value={confirmPin}
        onChangeText={setConfirmPin}
        secure
        keyboardType="number-pad"
      />
      <View style={styles.actions}>
        <Button
          testID="wipe_pin_save"
          label={armed === null ? 'Set wipe PIN' : 'Replace wipe PIN'}
          variant="danger"
          busy={busy}
          onPress={review}
        />
      </View>

      <ConfirmDialog
        testID="wipe_scope_dialog"
        visible={pendingScope !== null}
        title={pendingScope === null ? '' : `Destroy ${WIPE_SCOPE_LABEL[pendingScope]}?`}
        message={pendingScope === null ? '' : scopeChangeMessage(pendingScope)}
        confirmLabel={pendingScope === null ? 'Choose' : `Choose ${WIPE_SCOPE_LABEL[pendingScope]}`}
        cancelLabel="Cancel"
        destructive={pendingScope !== null && scopeDeletesCloud(pendingScope)}
        onConfirm={applyScope}
        onCancel={() => {
          setPendingScope(null);
        }}
      />

      <ConfirmDialog
        testID="wipe_pin_arm_dialog"
        visible={confirming && draft !== null}
        title="Arm this wipe PIN?"
        message={draft === null ? '' : armMessage(draft)}
        confirmLabel="Arm it"
        cancelLabel="Cancel"
        destructive
        onConfirm={arm}
        onCancel={() => {
          setConfirming(false);
        }}
      />
    </Screen>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    status: { ...typography.label, color: colors.text },
    active: { ...typography.title, color: colors.danger },
    draft: { ...typography.label, color: colors.textMuted },
    error: { ...typography.label, color: colors.danger },
    notice: { ...typography.label, color: colors.accent },
    caveat: { ...typography.caption, color: colors.textMuted, lineHeight: 17 },
    tick: { ...typography.title, color: colors.accent },
    actions: { gap: spacing.sm, paddingTop: spacing.sm },
  });
