/**
 * The way out of a foreign vault, offered where the user actually meets the problem.
 *
 * Mostly a fallback now. A restore carries the identity across on its own (see
 * `identityRecovery.ts`, called from both restore flows), so reaching this panel means either
 * that the account was opened on this vault without restoring anything, or that the automatic
 * attempt was refused and the user is trying a different passphrase.
 *
 * The account's messaging key belongs to the vault that set it up, and `publishKey` will not
 * replace it -- doing that strands whoever holds the real one, which is how ten production
 * accounts were quietly broken. So this goes the other way: the recovery passphrase for THIS
 * account's backup yields its master key, the master key yields the identity the account
 * published, and this device simply uses it. Nothing is uploaded and nothing is rotated.
 *
 * The passphrase is never stored. It buys an identity that lives in memory until the vault
 * locks, and is asked for again afterwards -- the deliberate price of never writing down a key
 * that opens an account this device does not own.
 *
 * AND WHEN THAT CANNOT WORK. Sometimes the vault that set the account up is simply gone: no
 * copy here, no escrow written before it went, nothing in `previous`. Then no passphrase on
 * earth produces the published key, and this panel used to say so and stop -- leaving the
 * account locked out of messaging entirely, not merely out of its old threads, with nothing
 * offered and no way forward. So a mismatch now also offers `startFreshIdentity`: the one write
 * `publishKey` refuses, made deliberately instead of silently. It is shown only after the
 * passphrase has actually been tried and failed, it states what it costs before it is armed,
 * and it takes a second, separate press -- because what it costs is permanent.
 */
import React, { useCallback, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useServices } from '@/app/ServicesProvider';
import { radius, spacing, typography, useStyles, type Palette } from '@/app/theme';
import { describeCloudError } from '@/backup/screens/cloudErrors';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { zeroBytes, type Bytes } from '@/utils/bytes';

export interface RecoverMessagingPanelProps {
  /** Called once the account's own identity is in place, so the thread can read itself again. */
  onRecovered: () => void;
}

/**
 * The passphrase opened the backup, but the key under it is not the one this account messages
 * with. A third vault set that up, and only recovering THAT one can read these conversations.
 */
const MISMATCH =
  'That passphrase opened this account’s backup, but the key it produces is not the one this ' +
  'account uses for messaging. A different vault set that up, and only that vault’s recovery ' +
  'passphrase can read these messages. Nothing was changed.';

const UNREACHABLE =
  'Could not check this account’s messaging key — the server did not answer. ' +
  'Check your connection and try again. Nothing was changed.';

/**
 * Not a failure of this panel at all: there is no key to unlock. Said plainly, because the old
 * copy sent the user to check a connection that was working perfectly well.
 */
const NOTHING_PUBLISHED =
  'This account has not set messaging up yet, so there is no messaging key to unlock. Open ' +
  'Messages to start. Nothing was changed.';

/**
 * Shown only after a mismatch, and worded to be refused as easily as accepted. It says what is
 * already lost before what is gained, because the honest reading is that the old messages went
 * when the vault did -- this only decides whether the account goes with them.
 */
const FRESH_OFFER =
  'If that vault is gone for good, this account can start again on this one. The messages ' +
  'already in these conversations stay unreadable either way — they were sealed with the old ' +
  'key, and nothing brings it back. What changes is that the account gets a working messaging ' +
  'identity again, so new conversations and new messages work from here on.';

const FRESH_CONFIRM =
  'This retires the old messaging key for good. If that vault ever does turn up, it will still ' +
  'open the old conversations, but it will no longer be able to send as this account. Nothing ' +
  'has been changed yet.';

/** The vault locked, or this build has no cloud. Neither is something a second press fixes. */
const FRESH_UNAVAILABLE =
  'Messaging is not available right now — the vault may have locked. Unlock it and try again. ' +
  'Nothing was changed.';

/** Hitting the cap refuses the rotation rather than dropping a key, which is the safe failure. */
const FRESH_HISTORY_FULL =
  'This account has changed its messaging key as many times as is allowed, so it cannot be ' +
  'changed again. Nothing was changed. Please get in touch through Customer service.';

const FRESH_RACED =
  'Something else changed this account’s messaging key while this was open, so nothing was ' +
  'written. Close this and try again.';

export function RecoverMessagingPanel({
  onRecovered,
}: RecoverMessagingPanelProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const services = useServices();
  const [open, setOpen] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The way out when no passphrase can work. Starts hidden and is only ever armed by an actual
   * mismatch, so the destructive option is never on screen before the safe one has been tried
   * -- and `confirming` is a separate step so it cannot be reached by one press.
   */
  const [fresh, setFresh] = useState<'hidden' | 'offered' | 'confirming'>('hidden');

  const submit = useCallback(() => {
    const backup = services.backup;
    if (backup === null) {
      setError('Cloud backup is not available in this build.');
      return;
    }
    if (passphrase === '') {
      setError('Enter the recovery passphrase for this account.');
      return;
    }
    setBusy(true);
    setError(null);
    void (async () => {
      let master: Bytes | null = null;
      try {
        // The escrow where the account has one, the backup envelope where it does not. Throws
        // WrongPassphraseError before any of the rest, so a typo costs one Argon2id and touches
        // nothing.
        master = await backup.recoverMessagingKey(passphrase);
        const outcome = await services.messaging.useRecoveredMasterKey(master);
        // A historical key is adopted exactly as the current one is -- the threads it can open
        // are open from this moment. What differs is what the service will then allow, and the
        // list's banner says so; closing here rather than reporting an error is the honest
        // reading, because nothing failed.
        if (outcome === 'ok' || outcome === 'historical') {
          // Everything needed is in hand exactly here and nowhere else: the passphrase, the key,
          // and the public-key check having just proved it is the account's own. Persisting it
          // now is what stops the NEXT device having to find a working envelope -- including
          // after a rebind, which replaces the envelope and used to end recovery for good.
          // Only for the current key. The escrow exists so a future device can recover the
          // account's real identity, and `protectMessagingKey` would refuse an older one anyway.
          if (outcome === 'ok') await backup.protectMessagingKey(master, passphrase);
          // Dropped the moment it has been used. The identity derived from it is what the
          // session keeps, and even that goes when the vault locks.
          setPassphrase('');
          setOpen(false);
          onRecovered();
          return;
        }
        // Only a mismatch means "no passphrase can help". `unreachable` is a server that did not
        // answer and `unavailable` is an account with no key at all; offering to retire a key on
        // either would be offering to destroy something over a failed lookup.
        setFresh(outcome === 'mismatch' ? 'offered' : 'hidden');
        setError(
          outcome === 'mismatch'
            ? MISMATCH
            : outcome === 'unreachable'
              ? UNREACHABLE
              : NOTHING_PUBLISHED,
        );
      } catch (cause) {
        setError(describeCloudError(cause));
      } finally {
        if (master !== null) zeroBytes(master);
        setBusy(false);
      }
    })();
  }, [onRecovered, passphrase, services]);

  /**
   * Retires the unreachable key and publishes this vault's. Reached only from `confirming`, so
   * by here the user has read what it costs twice and pressed twice.
   */
  const startFresh = useCallback(() => {
    setBusy(true);
    setError(null);
    void (async () => {
      try {
        const outcome = await services.messaging.startFreshIdentity();
        if (outcome === 'ok' || outcome === 'not-needed') {
          // `not-needed` lands here too: the account's key is this vault's either way, which is
          // the state the user was trying to reach. Saying "nothing was retired" while closing
          // is kinder than an error over an outcome that is fine.
          setFresh('hidden');
          setPassphrase('');
          setOpen(false);
          onRecovered();
          return;
        }
        setFresh('offered');
        setError(
          outcome === 'history-full'
            ? FRESH_HISTORY_FULL
            : outcome === 'raced'
              ? FRESH_RACED
              : outcome === 'unreachable'
                ? UNREACHABLE
                : FRESH_UNAVAILABLE,
        );
      } catch (cause) {
        setFresh('offered');
        setError(describeCloudError(cause));
      } finally {
        setBusy(false);
      }
    })();
  }, [onRecovered, services]);

  if (!open) {
    return (
      <Button
        testID="conversation_recover_messaging"
        label="Unlock messaging"
        variant="secondary"
        onPress={() => {
          setOpen(true);
        }}
      />
    );
  }

  return (
    <View testID="conversation_recover_panel" style={styles.panel}>
      <Text style={styles.hint}>
        Enter the recovery passphrase for this account&apos;s backup. It stays on this device, is
        never uploaded, and is asked for again after the vault locks.
      </Text>
      <Field
        testID="conversation_recover_passphrase"
        label="Recovery passphrase"
        value={passphrase}
        onChangeText={(next) => {
          setPassphrase(next);
          // Typing is an attempt to fix whatever the last message complained about, so the
          // complaint goes rather than sitting there while the field is corrected. The way out
          // goes with it: someone trying another passphrase is still trying the safe route, and
          // the destructive one should not be sitting under their thumb while they do.
          setError(null);
          setFresh('hidden');
        }}
        secure
      />
      {error === null ? null : (
        <Text testID="conversation_recover_error" style={styles.error}>
          {error}
        </Text>
      )}
      <Button
        testID="conversation_recover_submit"
        label="Unlock messaging"
        busy={busy}
        onPress={submit}
      />
      {fresh === 'hidden' ? null : (
        <View testID="conversation_recover_fresh" style={styles.fresh}>
          <Text style={styles.hint}>{fresh === 'offered' ? FRESH_OFFER : FRESH_CONFIRM}</Text>
          {fresh === 'offered' ? (
            // Secondary here and `danger` only on the step that actually writes, so the colour
            // means "this is the irreversible one" rather than decorating the whole section.
            <Button
              testID="conversation_recover_fresh_offer"
              label="Start fresh on this vault"
              variant="secondary"
              onPress={() => {
                setError(null);
                setFresh('confirming');
              }}
            />
          ) : (
            <>
              <Button
                testID="conversation_recover_fresh_confirm"
                label="Retire the old key and start fresh"
                variant="danger"
                busy={busy}
                onPress={startFresh}
              />
              <Button
                testID="conversation_recover_fresh_back"
                label="Keep trying the passphrase"
                variant="ghost"
                onPress={() => {
                  setFresh('offered');
                }}
              />
            </>
          )}
        </View>
      )}
      <Button
        testID="conversation_recover_cancel"
        label="Cancel"
        variant="secondary"
        onPress={() => {
          setOpen(false);
          setPassphrase('');
          setError(null);
          setFresh('hidden');
        }}
      />
    </View>
  );
}

function makeStyles(colors: Palette): ReturnType<typeof StyleSheet.create> {
  return StyleSheet.create({
    panel: {
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radius.md,
      backgroundColor: colors.surface,
    },
    hint: {
      ...typography.caption,
      color: colors.textMuted,
    },
    error: {
      ...typography.caption,
      color: colors.danger,
    },
    // Set apart from the passphrase controls above it, so the irreversible option does not read
    // as one more way of pressing "Unlock messaging".
    fresh: {
      gap: spacing.sm,
      paddingTop: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
  });
}
