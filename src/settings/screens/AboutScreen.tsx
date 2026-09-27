/**
 * About the vault -- or, in super secure mode, about a calculator.
 *
 * The version string and app name are props rather than reads of the Expo config, so the navigator
 * decides what this build calls itself.
 *
 * This screen is reachable from BOTH sides: the vault's settings, and the calculator's menu while
 * the vault is locked. With super secure on it is the ONLY thing that menu offers, which decides
 * two things about it:
 *
 *  - `disguised` strips every section that would give the app away. No "what protects your
 *    photos", no "what leaves this device", and no word anywhere on the page about a vault, a PIN,
 *    a backup or a passphrase. What is left reads like the About page of a calculator, because
 *    that is what someone holding the phone is supposed to find.
 *  - Customer service lives here, as a form rather than an address, because a locked-out user
 *    cannot reach the one inside the vault. It sends what is typed and nothing else: no topic
 *    list, no app details, no diagnostics -- that block would say "Cloud backup: on", which is
 *    precisely what this page must not say. The body is scrubbed on the way out, as it is
 *    everywhere else.
 *
 *    Where a recovery code could be issued, the installation reference is written INTO the
 *    draft. That is not a quiet exception to the rule above: it is visible text the user can
 *    edit or delete, and it names ten random bytes rather than anything the app does. It is
 *    there because asking a locked-out user to send a second email is its own kind of cruelty.
 *
 * What `disguised` changes about the form is only what it SAYS, never what it does. The warnings
 * the honest page carries -- do not send your PIN, digit runs are stripped before sending -- are
 * themselves the giveaway: a calculator has no reason to mention either, and a page that does is
 * a page worth a second look. So the disguised copy is the flattest thing a support form can say,
 * and the scrubbing it no longer advertises still happens on every send.
 *
 * It is a way to reach a person, never a way in: support cannot unlock a vault, reset or look up a
 * PIN, or decrypt a backup, and the page says so wherever saying so does not itself give the app
 * away.
 *
 * The name card carries the one thing on this page that is not for the user: eight quick taps on
 * it reveal a portrait of the author, who made this and how to reach them. {@link IdentityCard}
 * has the reasoning, and the short of it is that a card sitting on the disguised page may not
 * react to being touched.
 *
 * The reveal also carries the way out of a forgotten PIN. Super secure hides the calculator menu
 * item that normally opens {@link ForgotPinDialog}, which leaves a locked-out user with no way to
 * erase and start again -- the one thing that makes a cloud backup worth having. Putting it here
 * restores it without putting the words "forgot your PIN" on a calculator. It is not a way in:
 * it destroys this device and can no more open the vault than a factory reset can. What it is
 * careful NOT to do is touch the cloud copy, which is the whole reason erasing is survivable.
 */
import { Image } from 'expo-image';
import React, { useEffect, useRef, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useServices } from '@/app/ServicesProvider';
import { radius, spacing, type Palette, typography, useStyles, useTheme } from '@/app/theme';
import { ForgotPinDialog } from '@/auth/screens/ForgotPinDialog';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Screen, SectionLabel } from '@/components/Screen';
import {
  isPlausibleEmail,
  SUPPORT_BODY_MAX,
  SUPPORT_FAILURE_COPY,
} from '@/support/supportMessage';
import type { SupportMessage } from '@/support/types';
import type { RecoveryRedemption } from '@/support/recoveryAccess';

import PORTRAIT_SOURCE from '../../../assets/about-portrait.png';

export const DEFAULT_APP_NAME = 'SilentSum';
export const DEFAULT_APP_VERSION = '0.1.0';

/**
 * Who made this, shown only behind the easter egg.
 *
 * Hardcoded rather than read from the support configuration. They happen to be the same address
 * today, but they answer different questions -- one is where a user writes for help, the other is
 * a signature -- and a build that pointed support elsewhere should not silently re-sign the app.
 */
export const AUTHOR_NAME = 'Krueger Co Labs';
export const AUTHOR_EMAIL = 'kruegercolabs@gmail.com';

export interface AboutScreenProps {
  onBack?: () => void;
  /** Defaults to the product name; pass the disguised name for the calculator's own About page. */
  appName?: string;
  /** Defaults to the version in app.config.ts at the time of writing. */
  version?: string;
  /**
   * Super secure is on: say nothing about a vault. The page keeps its name, its version and its
   * way of reaching support, and drops everything else.
   */
  disguised?: boolean;
  /**
   * Called once a support-issued recovery code has verified, which is the only thing that
   * opens the way back to the backup account. Omit it and the entry point is not rendered at
   * all -- there is nothing to reach.
   */
  onRecoveryVerified?: () => void;
  /**
   * Offers the way out of a forgotten PIN from behind the easter egg, and is called once the
   * device has been erased. Omit it and no such button is rendered -- there is nothing to press.
   *
   * Wired on the LOCKED About page only. Unlocked, the user has the gallery and settings, and a
   * hidden second door to the same destruction would be clutter rather than a rescue.
   */
  onErased?: () => void;
  /** Opens the restore flow after an erase, when this device had a cloud backup to go back to. */
  onRestore?: () => void;
}

const SUMMARY: readonly string[] = [
  'Everything in the vault is encrypted on this device before it is written to storage. A file copied off the phone is opaque bytes.',
  'The key to those bytes is wrapped with your PIN. The PIN is never stored, so the vault cannot be opened without you typing it.',
  'Because of that, a forgotten PIN is final. There is no reset, no backdoor and no recovery code.',
  'Unlocking never touches the network, and the app works with no connection at all.',
];

export function AboutScreen({
  onBack,
  appName = DEFAULT_APP_NAME,
  version = DEFAULT_APP_VERSION,
  disguised = false,
  onRecoveryVerified,
  onErased,
  onRestore,
}: AboutScreenProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { firebase, backup } = useServices();
  const cloudPossible = firebase.available && backup !== null;
  const [erasing, setErasing] = useState(false);

  return (
    <Screen title="About" scroll testID="about_screen" {...(onBack === undefined ? {} : { onBack })}>
      <IdentityCard
        appName={appName}
        version={version}
        {...(onErased === undefined
          ? {}
          : {
              onReset: () => {
                setErasing(true);
              },
            })}
      />

      {disguised ? null : (
        <>
          <SectionLabel>What protects your photos</SectionLabel>
          <View style={styles.card} testID="about_security_summary">
            {SUMMARY.map((line) => (
              <View key={line} style={styles.point}>
                <Text style={styles.bullet}>{'•'}</Text>
                <Text style={styles.pointText}>{line}</Text>
              </View>
            ))}
          </View>

          <SectionLabel>What leaves this device</SectionLabel>
          <Text testID="about_data_statement" style={styles.paragraph}>
            No vault data leaves this device unless you explicitly switch on cloud backup. There is
            no account, no sync and no telemetry about your photos. If you do switch backup on, what
            is uploaded is the same ciphertext that sits here, plus your vault key sealed inside an
            envelope that only your recovery passphrase opens.
            {cloudPossible
              ? ''
              : ' This build has no cloud configuration at all, so backup cannot even be offered.'}
          </Text>
        </>
      )}

      <SectionLabel>Customer service</SectionLabel>
      {disguised ? null : (
        <View style={styles.card}>
          <Text testID="about_support_limits" style={styles.pointText}>
            What support cannot do: unlock your vault, reset or look up your PIN, decrypt a backup,
            or verify your identity into your own photos. None of that is withheld as policy -- the
            key is derived from secrets only you hold, so there is nothing on our side to send you.
          </Text>
          <Text testID="about_support_recovery" style={styles.pointText}>
            {cloudPossible
              ? 'If you switched cloud backup on, the way back into your photos is your backup ' +
                'account sign-in together with the recovery passphrase you chose. Both are needed. ' +
                'The account password on its own locates the encrypted files and cannot decrypt ' +
                'them, and the passphrase on its own has nothing to fetch.'
              : 'With no cloud backup in this build, the PIN is the only way in. Keep it somewhere ' +
                'you trust: a forgotten PIN cannot be recovered by anyone.'}
          </Text>
        </View>
      )}
      <CustomerService
        disguised={disguised}
        quoteReference={disguised && onRecoveryVerified !== undefined}
      />
      {/* Below the form on purpose: the code arrives as a REPLY to a message sent from it. */}
      {disguised && onRecoveryVerified !== undefined ? (
        <RecoveryCodeEntry onVerified={onRecoveryVerified} />
      ) : null}
      {/* Rendered here rather than inside the reveal: two modals must not overlap. */}
      {onErased === undefined ? null : (
        <ForgotPinDialog
          visible={erasing}
          disguised={disguised}
          onDismiss={() => {
            setErasing(false);
          }}
          onErased={() => {
            setErasing(false);
            onErased();
          }}
          {...(onRestore === undefined ? {} : { onRestore })}
        />
      )}
    </Screen>
  );
}

/** Taps on the name card that reveal the portrait. */
const PORTRAIT_TAPS = 8;
/** Taps further apart than this start the count over. */
const PORTRAIT_TAP_WINDOW_MS = 2000;

/**
 * The name and version, and behind them the one flourish on this page.
 *
 * Eight quick taps reveal a portrait of the person who wrote the app. It is built to cost the
 * page nothing, because this card is usually sitting on the DISGUISED About page where anything
 * out of the ordinary is a tell:
 *
 *  - No press feedback. A card that dims when you touch it is a card that invites a second
 *    touch, and a calculator whose version number is secretly a button is worth a closer look.
 *    `Pressable` adds no feedback of its own on Android, so this is a matter of not adding any.
 *  - `accessible={false}` leaves the two lines reading exactly as they did before -- a name and
 *    a version, not an unlabelled button. The cost is that the reveal cannot be reached through
 *    TalkBack, which for a joke is the right way round.
 *  - Nothing it shows names the app or anything the app does. The disguised page is checked
 *    word by word in the tests, and the reveal is checked with it rather than around it.
 *
 * The count starts over when taps are more than {@link PORTRAIT_TAP_WINDOW_MS} apart, so seven
 * stray touches spread over a session never leave the card one tap from firing.
 */
function IdentityCard({
  appName,
  version,
  onReset,
}: {
  appName: string;
  version: string;
  onReset?: () => void;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const [revealed, setRevealed] = useState(false);
  // Refs, not state: a tap that is not the eighth must not re-render the page it sits on.
  const taps = useRef(0);
  const lastTapAt = useRef(0);

  const tap = (): void => {
    const now = Date.now();
    taps.current = now - lastTapAt.current > PORTRAIT_TAP_WINDOW_MS ? 1 : taps.current + 1;
    lastTapAt.current = now;
    if (taps.current < PORTRAIT_TAPS) return;
    taps.current = 0;
    setRevealed(true);
  };

  const hide = (): void => {
    setRevealed(false);
  };

  return (
    <>
      <Pressable style={styles.card} onPress={tap} accessible={false} testID="about_identity">
        <Text testID="about_app_name" style={styles.appName}>
          {appName}
        </Text>
        <Text testID="about_version" style={styles.version}>{`Version ${version}`}</Text>
      </Pressable>
      <Modal visible={revealed} transparent animationType="fade" onRequestClose={hide}>
        <Pressable style={styles.portraitBackdrop} onPress={hide} testID="about_portrait">
          <View style={styles.portraitFrame}>
            <Image
              source={PORTRAIT_SOURCE}
              style={styles.portrait}
              contentFit="contain"
              accessibilityLabel={AUTHOR_NAME}
            />
          </View>
          <Text testID="about_author_name" style={styles.authorName}>
            {AUTHOR_NAME}
          </Text>
          <Text testID="about_author_email" style={styles.authorEmail}>
            {AUTHOR_EMAIL}
          </Text>
          {onReset === undefined ? null : (
            <View style={styles.portraitAction}>
              <Button
                testID="about_reset_device"
                label="Reset this device"
                variant="danger"
                onPress={() => {
                  // Closed first: the erase dialog is a modal of its own, and two overlapping
                  // modals is a coin toss on Android.
                  hide();
                  onReset();
                }}
              />
            </View>
          )}
          <Text style={styles.portraitHint}>Tap anywhere to close.</Text>
        </Pressable>
      </Modal>
    </>
  );
}

/**
 * Write to us, from here.
 *
 * Deliberately smaller than the full support screen: an address, a message, somewhere to reply to,
 * and Send. No topic list and no app details, because both of those name the vault and this has to
 * be safe to render on the disguised page.
 */
function CustomerService({
  disguised,
  quoteReference,
}: {
  disguised: boolean;
  quoteReference: boolean;
}): React.JSX.Element {
  const colors = useTheme();
  const styles = useStyles(makeStyles);
  const { support, recovery } = useServices();

  const [replyTo, setReplyTo] = useState('');
  const [body, setBody] = useState('');
  /** Stops the draft being overwritten once the user has started writing. */
  const [bodyEdited, setBodyEdited] = useState(false);
  const [reference, setReference] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** `undefined` while composing; the address it was sent from, or null, once it has gone. */
  const [sentTo, setSentTo] = useState<string | null | undefined>(undefined);

  /**
   * The reference is put IN the draft rather than attached to the message.
   *
   * Nothing is added to a support message behind the user -- this page attaches no topic, no
   * app details and no diagnostics, because that block would announce the vault. A reference is
   * different in kind: ten random bytes that describe nothing about what the app does. But the
   * rule that nothing leaves unseen is worth more than the convenience, so it goes in as text
   * the user can read, edit and delete before pressing Send.
   *
   * Without it every request costs two round trips: they write in, we ask which phone, they
   * write again -- and a locked-out user is not in the mood for a correspondence.
   */
  const canQuote = quoteReference && recovery.available;
  useEffect(() => {
    if (!canQuote) return;
    let live = true;
    void (async () => {
      const shown = await recovery.displayRef();
      if (live) setReference(shown);
    })();
    return () => {
      live = false;
    };
  }, [canQuote, recovery]);

  const contact = support?.contact ?? null;
  /**
   * What the field shows: the reference line until the user touches it, their text afterwards.
   *
   * Derived rather than written into state, so there is exactly one moment the draft changes
   * hands -- the first keystroke -- and no render where the two disagree.
   */
  const draft = !bodyEdited && reference !== null ? referenceLine(reference) : body;
  const trimmedBody = draft.trim();
  const trimmedReply = replyTo.trim();
  const replyBad = trimmedReply !== '' && !isPlausibleEmail(trimmedReply);
  const canSend = support !== null && trimmedBody.length > 0 && !replyBad && !busy;

  const send = (): void => {
    if (support === null || !canSend) return;
    const message: SupportMessage = {
      // "Something else" keeps the subject line free of anything that names the app's real job.
      topic: 'other',
      body: trimmedBody,
      replyTo: trimmedReply === '' ? null : trimmedReply,
      // Never attached from here: that block says whether cloud backup is on.
      diagnostics: null,
    };
    setBusy(true);
    setError(null);
    void (async () => {
      const result = await support.send(message);
      setBusy(false);
      if (result.kind === 'sent') {
        // The draft is dropped rather than kept: there is no reason for it to outlive the send.
        setBody('');
        setBodyEdited(false);
        setReplyTo('');
        setSentTo(trimmedReply === '' ? null : trimmedReply);
        return;
      }
      setError(SUPPORT_FAILURE_COPY[result.reason]);
    })();
  };

  if (support === null) {
    return (
      <View style={styles.card} testID="about_customer_service">
        <Text testID="about_support_contact" style={styles.pointText}>
          This build has no support address compiled into it, so there is nobody to write to from
          here.
        </Text>
      </View>
    );
  }

  if (sentTo !== undefined) {
    return (
      <View style={styles.card} testID="about_customer_service">
        <Text testID="about_support_sent" style={styles.pointText}>
          {sentTo === null
            ? 'Message sent. You did not leave an email address, so nobody can write back. Send another with one if you need an answer.'
            : `Message sent. Any reply goes to ${sentTo}, headed "Calculator support".`}
        </Text>
        <Button
          testID="about_support_write_another"
          label="Write another message"
          variant="secondary"
          onPress={() => {
            setSentTo(undefined);
          }}
        />
      </View>
    );
  }

  return (
    <View style={styles.card} testID="about_customer_service">
      <Text testID="about_support_contact" style={styles.pointText}>
        {disguised
          ? `Questions or feedback? Write to ${contact ?? 'us'}, or send a message from here.`
          : `Write to ${contact ?? 'us'}, or send a message from here. Say what you were doing and ` +
            'what you saw. Never include your PIN or your recovery passphrase: neither is any use ' +
            'to us, and an inbox is the wrong place for either.'}
      </Text>

      <Field
        testID="about_support_reply_to"
        label="Your email"
        value={replyTo}
        onChangeText={setReplyTo}
        keyboardType="email-address"
      />
      <Text style={replyBad ? styles.error : styles.muted}>
        {replyBad
          ? 'That does not look like an email address.'
          : 'Optional, but without it nobody can answer you.'}
      </Text>

      <TextInput
        testID="about_support_body"
        accessibilityLabel="Your message"
        value={draft}
        onChangeText={(next) => {
          setBody(next);
          setBodyEdited(true);
        }}
        multiline
        maxLength={SUPPORT_BODY_MAX}
        editable={!busy}
        placeholder="What can we help with?"
        placeholderTextColor={colors.textMuted}
        style={styles.input}
      />
      <Text style={styles.muted}>
        {disguised
          ? `${String(trimmedBody.length)} of ${String(SUPPORT_BODY_MAX)} characters.`
          : `${String(trimmedBody.length)} of ${String(SUPPORT_BODY_MAX)} characters. Runs of 4 to 8 digits are removed before sending, so a PIN can never reach us by accident.`}
      </Text>

      {canQuote ? (
        <Text testID="about_support_reference_note" style={styles.muted}>
          The reference line tells support which device this is. Delete it if you would rather
          not send it.
        </Text>
      ) : null}

      {error === null ? null : (
        <Text testID="about_support_error" style={styles.error}>
          {error}
        </Text>
      )}

      <Button
        testID="about_support_send"
        label={busy ? 'Sending' : 'Send message'}
        onPress={send}
        disabled={!canSend}
        busy={busy}
      />
    </View>
  );
}

/** The first line of a fresh draft, when there is a reference worth quoting. */
function referenceLine(reference: string): string {
  return `Reference ${reference}\n\n`;
}

/**
 * Entering a code support sent back.
 *
 * Everything visible here has to read like part of an ordinary support flow, because on the
 * disguised page that is all it is allowed to be. A reference number and a field for a code
 * support gave you are unremarkable in any app; a sign-in form would not be, which is why the
 * account is not mentioned, hinted at or rendered until a code has actually verified.
 *
 * The failures are told apart for the user where that helps them do something differently --
 * an expired or spent code means "ask for another", a short one means "check you copied it
 * all" -- and deliberately not told apart where it would help someone else: a code signed by
 * the wrong key and a code meant for another phone give the same flat answer.
 */
function RecoveryCodeEntry({ onVerified }: { onVerified: () => void }): React.JSX.Element | null {
  const styles = useStyles(makeStyles);
  const { recovery } = useServices();
  const [reference, setReference] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const available = recovery.available;
  useEffect(() => {
    if (!available) return;
    let live = true;
    void (async () => {
      const shown = await recovery.displayRef();
      if (live) setReference(shown);
    })();
    return () => {
      live = false;
    };
  }, [available, recovery]);

  // A build with no signing key could never accept a code, so it does not offer the field.
  if (!available) return null;

  const submit = (): void => {
    if (busy || code.trim() === "") return;
    setBusy(true);
    setError(null);
    void (async () => {
      const result = await recovery.redeem(code);
      setBusy(false);
      if (result.ok) {
        setCode("");
        onVerified();
        return;
      }
      setError(REDEMPTION_COPY[result.reason]);
    })();
  };

  return (
    <View style={styles.card} testID="about_recovery_code">
      <Text testID="about_recovery_explainer" style={styles.pointText}>
        If support has sent you a code, enter it below. The reference identifies this device; it
        is already in the message above.
      </Text>
      <Text testID="about_recovery_reference" style={styles.reference}>
        {reference === null ? "Reference \u2014" : `Reference ${reference}`}
      </Text>
      <Field
        testID="about_recovery_input"
        label="Code"
        value={code}
        onChangeText={(next) => {
          setCode(next);
          setError(null);
        }}
      />
      {error === null ? null : (
        <Text testID="about_recovery_error" style={styles.error}>
          {error}
        </Text>
      )}
      <Button
        testID="about_recovery_submit"
        label={busy ? "Checking" : "Continue"}
        variant="secondary"
        onPress={submit}
        disabled={busy || code.trim() === ""}
        busy={busy}
      />
    </View>
  );
}

const REDEMPTION_COPY: Readonly<Record<RecoveryRedemption, string>> = {
  malformed: "That code is not complete. Check you have copied all of it, including every group.",
  // Wrong key and wrong device answer identically: which one it was is nobody else\u2019s business.
  rejected: "That code was not accepted.",
  expired: "That code has expired. Ask for a new one.",
  used: "That code has already been used. Ask for a new one.",
  unavailable: "This build cannot accept codes.",
};
const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      padding: spacing.md,
      gap: spacing.sm,
    },
    appName: { ...typography.title, color: colors.text },
    version: { ...typography.body, color: colors.textMuted },
    point: { flexDirection: 'row', gap: spacing.sm },
    bullet: { ...typography.body, color: colors.accent },
    pointText: { ...typography.body, color: colors.textMuted, flex: 1, lineHeight: 22 },
    paragraph: { ...typography.body, color: colors.textMuted, lineHeight: 22 },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.sm,
      color: colors.text,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      minHeight: 120,
      textAlignVertical: 'top',
    },
    reference: { ...typography.label, color: colors.text, letterSpacing: 1 },
    portraitBackdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.85)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.lg,
      gap: spacing.md,
    },
    // The frame does the clamping and the image does the shape, on two nodes rather than one.
    // A percentage width, a maxWidth and an aspectRatio together give Yoga a height worked out
    // from the width BEFORE the clamp: 432dp of content width over a 450:536 portrait came to a
    // 514dp-tall box holding a 429dp-tall picture. Splitting them leaves the image a width that
    // is already final, so the ratio is the only thing left to honour.
    portraitFrame: { width: '100%', maxWidth: 360 },
    portrait: { width: '100%', aspectRatio: 450 / 536, borderRadius: radius.lg },
    authorName: { ...typography.title, color: colors.text },
    authorEmail: { ...typography.body, color: colors.textMuted },
    portraitAction: { width: '100%', maxWidth: 360 },
    portraitHint: { ...typography.caption, color: colors.textMuted },
    muted: { ...typography.caption, color: colors.textMuted, lineHeight: 17 },
    error: { ...typography.label, color: colors.danger },
  });
