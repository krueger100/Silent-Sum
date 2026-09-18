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
 *    list, no app details, no identifier -- the diagnostics block the full support screen offers
 *    would say "Cloud backup: on", which is precisely what this page must not say. The body is
 *    scrubbed on the way out, as it is everywhere else.
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
 */
import React, { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { useServices } from '@/app/ServicesProvider';
import { radius, spacing, type Palette, typography, useStyles, useTheme } from '@/app/theme';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Screen, SectionLabel } from '@/components/Screen';
import {
  isPlausibleEmail,
  SUPPORT_BODY_MAX,
  SUPPORT_FAILURE_COPY,
} from '@/support/supportMessage';
import type { SupportMessage } from '@/support/types';

export const DEFAULT_APP_NAME = 'SilentSum';
export const DEFAULT_APP_VERSION = '0.1.0';

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
}: AboutScreenProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { firebase, backup } = useServices();
  const cloudPossible = firebase.available && backup !== null;

  return (
    <Screen title="About" scroll testID="about_screen" {...(onBack === undefined ? {} : { onBack })}>
      <View style={styles.card}>
        <Text testID="about_app_name" style={styles.appName}>
          {appName}
        </Text>
        <Text testID="about_version" style={styles.version}>{`Version ${version}`}</Text>
      </View>

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
      <CustomerService disguised={disguised} />
    </Screen>
  );
}

/**
 * Write to us, from here.
 *
 * Deliberately smaller than the full support screen: an address, a message, somewhere to reply to,
 * and Send. No topic list and no app details, because both of those name the vault and this has to
 * be safe to render on the disguised page.
 */
function CustomerService({ disguised }: { disguised: boolean }): React.JSX.Element {
  const colors = useTheme();
  const styles = useStyles(makeStyles);
  const { support } = useServices();

  const [replyTo, setReplyTo] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** `undefined` while composing; the address it was sent from, or null, once it has gone. */
  const [sentTo, setSentTo] = useState<string | null | undefined>(undefined);

  const contact = support?.contact ?? null;
  const trimmedBody = body.trim();
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
        value={body}
        onChangeText={setBody}
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
    muted: { ...typography.caption, color: colors.textMuted, lineHeight: 17 },
    error: { ...typography.label, color: colors.danger },
  });
