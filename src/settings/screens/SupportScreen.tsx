/**
 * Customer service.
 *
 * This is the only screen in the app that sends anything anywhere on purpose, so it is written to
 * be boring and explicit: you can see the whole message, you can see the app details attached to
 * it, and nothing goes anywhere until you press Send. There is no ticket queue, no retry in the
 * background and no draft kept after a send - what you typed is gone from memory with the screen.
 *
 * What is typed is scrubbed before it is sent (see `supportMessage.ts`), because the single worst
 * thing a support inbox could receive from this app is somebody's PIN.
 */
import React, { useMemo, useState } from 'react';
import { Platform, StyleSheet, Text, TextInput, View } from 'react-native';

import { useServices, useSettings } from '@/app/ServicesProvider';
import { radius, spacing, type Palette, typography, useStyles, useTheme } from '@/app/theme';
import { Button } from '@/components/Button';
import { ListRow, SwitchRow } from '@/components/ListRow';
import { Paragraph, Screen, SectionLabel } from '@/components/Screen';
import { DEFAULT_APP_VERSION } from '@/settings/screens/AboutScreen';
import { buildDiagnostics } from '@/support/diagnostics';
import {
  isPlausibleEmail,
  subjectFor,
  SUPPORT_BODY_MAX,
  SUPPORT_FAILURE_COPY,
} from '@/support/supportMessage';
import {
  SUPPORT_TOPIC_LABEL,
  SUPPORT_TOPICS,
  type SupportMessage,
  type SupportTopic,
} from '@/support/types';

export interface SupportScreenProps {
  onBack?: () => void;
  /** Defaults to the version in app.config.ts, matching the About screen. */
  version?: string;
}

export function SupportScreen({
  onBack,
  version = DEFAULT_APP_VERSION,
}: SupportScreenProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const services = useServices();

  if (services.support === null) {
    return (
      <Screen
        title="Customer service"
        scroll
        testID="support_screen"
        {...(onBack === undefined ? {} : { onBack })}
      >
        <View style={styles.card} testID="support_unavailable">
          <Text style={styles.cardTitle}>Support messages are not set up in this build</Text>
          <Text style={styles.cardLine}>
            This copy of the app was built without a support address, so there is nowhere for a
            message to go and nothing on this screen would reach anybody.
          </Text>
          <Text style={styles.cardLine}>
            Everything else is unaffected: the vault is local, encrypted and unlocked entirely
            offline, exactly as it would be otherwise.
          </Text>
        </View>
        <Paragraph>
          If you got this app from someone, they are the ones who can add a support address to it.
          The version you are running is on the About screen.
        </Paragraph>
      </Screen>
    );
  }

  return <SupportForm version={version} {...(onBack === undefined ? {} : { onBack })} />;
}

function SupportForm({ onBack, version }: { onBack?: () => void; version: string }): React.JSX.Element {
  const colors = useTheme();
  const styles = useStyles(makeStyles);
  const services = useServices();
  const settings = useSettings();

  const [topic, setTopic] = useState<SupportTopic>('unlock');
  const [body, setBody] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<{ reference: string | null } | null>(null);

  const diagnostics = useMemo(
    () =>
      buildDiagnostics({
        appVersion: version,
        platform: Platform.OS,
        osVersion: String(Platform.Version),
        cloudConfigured: services.firebase.available && services.backup !== null,
        backupEnabled: settings.backupEnabled,
      }),
    [version, services.firebase.available, services.backup, settings.backupEnabled],
  );

  const trimmed = body.trim();
  const replyTrimmed = replyTo.trim();
  const replyBad = replyTrimmed !== '' && !isPlausibleEmail(replyTrimmed);
  const canSend = trimmed.length > 0 && !replyBad && !busy;

  const send = (): void => {
    const support = services.support;
    if (support === null || !canSend) return;
    const message: SupportMessage = {
      topic,
      body: trimmed,
      replyTo: replyTrimmed === '' ? null : replyTrimmed,
      diagnostics: includeDiagnostics ? diagnostics : null,
    };
    setBusy(true);
    setError(null);
    void (async () => {
      const result = await support.send(message);
      setBusy(false);
      if (result.kind === 'sent') {
        // The draft is dropped rather than kept: there is no reason for it to outlive the send.
        setBody('');
        setSent({ reference: result.reference });
        return;
      }
      setError(SUPPORT_FAILURE_COPY[result.reason]);
    })();
  };

  if (sent !== null) {
    return (
      <Screen
        title="Customer service"
        scroll
        testID="support_screen"
        {...(onBack === undefined ? {} : { onBack })}
      >
        <View style={styles.card} testID="support_sent">
          <Text style={styles.cardTitle}>Message sent</Text>
          <Text style={styles.cardLine}>
            {replyTrimmed === ''
              ? 'You did not leave a reply address, so nobody can write back. If you need an answer, send another message with an address.'
              : `Any reply goes to ${replyTrimmed}. It will be headed "Calculator support", not the name of this app.`}
          </Text>
          {sent.reference === null ? null : (
            <Text testID="support_reference" style={styles.muted}>
              {`Reference: ${sent.reference}`}
            </Text>
          )}
        </View>
        <Button
          testID="support_write_another"
          label="Write another message"
          variant="secondary"
          onPress={() => {
            setSent(null);
          }}
        />
      </Screen>
    );
  }

  return (
    <Screen
      title="Customer service"
      scroll
      testID="support_screen"
      {...(onBack === undefined ? {} : { onBack })}
    >
      <Paragraph>
        Nothing is sent until you press Send, and only what is on this screen is sent. No photo, no
        file name and no key ever leaves the device - not even to support.
      </Paragraph>

      <SectionLabel>What is this about</SectionLabel>
      {SUPPORT_TOPICS.map((option) => (
        <ListRow
          key={option}
          testID={`support_topic_${option}`}
          label={SUPPORT_TOPIC_LABEL[option]}
          onPress={() => {
            setTopic(option);
          }}
          trailing={
            option === topic ? (
              <Text testID={`support_topic_${option}_selected`} style={styles.tick}>
                {'✓'}
              </Text>
            ) : null
          }
        />
      ))}

      <SectionLabel>Your message</SectionLabel>
      <TextInput
        testID="support_body"
        accessibilityLabel="Your message"
        value={body}
        onChangeText={setBody}
        multiline
        maxLength={SUPPORT_BODY_MAX}
        editable={!busy}
        placeholder="What happened, and what you expected instead."
        placeholderTextColor={colors.textMuted}
        style={[styles.input, styles.multiline]}
      />
      <Text style={styles.muted}>
        {`${String(trimmed.length)} of ${String(SUPPORT_BODY_MAX)} characters. Runs of 4 to 8 digits are removed before sending, so a PIN can never reach us by accident.`}
      </Text>

      <SectionLabel>Where to reply</SectionLabel>
      <TextInput
        testID="support_reply_to"
        accessibilityLabel="Reply address"
        value={replyTo}
        onChangeText={setReplyTo}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        editable={!busy}
        placeholder="you@example.com (optional)"
        placeholderTextColor={colors.textMuted}
        style={styles.input}
      />
      <Text style={replyBad ? styles.error : styles.muted}>
        {replyBad
          ? 'That does not look like an email address.'
          : 'Optional. Without it the message can still be read, but nobody can answer it.'}
      </Text>

      <SectionLabel>App details</SectionLabel>
      <SwitchRow
        testID="support_include_diagnostics"
        label="Attach app details"
        detail="Only what is shown below. No device id, no account, nothing about your photos."
        value={includeDiagnostics}
        disabled={busy}
        onValueChange={setIncludeDiagnostics}
      />
      {includeDiagnostics ? (
        <View style={styles.card}>
          <Text testID="support_diagnostics_preview" style={styles.mono}>
            {diagnostics}
          </Text>
        </View>
      ) : null}

      <SectionLabel>Sent as</SectionLabel>
      <Text testID="support_subject_preview" style={styles.muted}>
        {subjectFor({ topic, body: '', replyTo: null, diagnostics: null })}
      </Text>

      {error === null ? null : (
        <Text testID="support_error" style={styles.error}>
          {error}
        </Text>
      )}

      <Button
        testID="support_send"
        label={busy ? 'Sending' : 'Send message'}
        onPress={send}
        disabled={!canSend}
        busy={busy}
      />
    </Screen>
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
    cardTitle: { ...typography.label, color: colors.text, fontSize: 16 },
    cardLine: { ...typography.body, color: colors.textMuted, lineHeight: 22 },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.sm,
      color: colors.text,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      minHeight: 48,
    },
    multiline: { minHeight: 132, textAlignVertical: 'top' },
    muted: { ...typography.caption, color: colors.textMuted, lineHeight: 17 },
    mono: { ...typography.caption, color: colors.textMuted, lineHeight: 19 },
    error: { ...typography.label, color: colors.danger },
    tick: { ...typography.title, color: colors.accent },
  });
