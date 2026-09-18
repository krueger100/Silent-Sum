/**
 * Security and privacy toggles, plus a plain statement of what the encryption actually is.
 *
 * None of these switches change how the vault is protected: the crypto is not configurable, on
 * purpose. What they change is what the OS is allowed to capture and what diagnostics may leave
 * the device. Crash reports default ON because they are scrubbed and they are how a decryption bug
 * ever gets found; analytics default OFF because nothing about a private vault needs measuring.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useServices, useSettings } from '@/app/ServicesProvider';
import { radius, spacing, type Palette, typography, useStyles } from '@/app/theme';
import { SwitchRow } from '@/components/ListRow';
import { Paragraph, Screen, SectionLabel } from '@/components/Screen';

export interface SecurityScreenProps {
  onBack?: () => void;
}

const ENCRYPTION_FACTS: readonly string[] = [
  'Your PIN is stretched with Argon2id, and only the key that comes out of it can unwrap the vault key.',
  'The PIN itself is kept in the platform secure store, because the calculator has to recognise parts of it. Nothing else on the device holds it and it never leaves.',
  'That derived key only unwraps a random 32-byte vault key held in the platform secure store (Android Keystore / iOS Keychain).',
  'Photos, thumbnails and the index are each encrypted with XChaCha20-Poly1305 under separate sub-keys, in app-private storage.',
  'Unlocking is entirely offline. No server is contacted, and none can be.',
  'Failed PIN attempts are throttled with escalating delays. Nothing is ever wiped automatically.',
];

export function SecurityScreen({ onBack }: SecurityScreenProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const services = useServices();
  const settings = useSettings();
  const firebaseAvailable = services.firebase.available;

  const setScreenProtection = (next: boolean): void => {
    void services.settings.update({ screenProtection: next });
    void services.screenProtection.setSecure(next);
  };

  const setCrashReports = (next: boolean): void => {
    void services.settings.update({ crashReportsEnabled: next });
    void services.firebase.crash.setEnabled(next);
  };

  const setAnalytics = (next: boolean): void => {
    void services.settings.update({ analyticsEnabled: next });
    void services.firebase.analytics.setEnabled(next);
  };

  const diagnosticsDetail = (active: string): string =>
    firebaseAvailable ? active : 'Inactive in this build: it has no Firebase configuration.';

  return (
    <Screen
      title="Security and privacy"
      scroll
      testID="security_screen"
      {...(onBack === undefined ? {} : { onBack })}
    >
      <SectionLabel>Screen</SectionLabel>
      <SwitchRow
        testID="security_screen_protection"
        label="Screen protection"
        detail={
          'Blocks screenshots, screen recording and the app-switcher preview while the vault is ' +
          'open (Android enforces all of this). On iOS the platform only supports the privacy ' +
          'curtain in the app switcher, so screenshots cannot be fully prevented there.'
        }
        value={settings.screenProtection}
        onValueChange={setScreenProtection}
      />

      <SectionLabel>Diagnostics</SectionLabel>
      <SwitchRow
        testID="security_crash_reports"
        label="Send crash reports"
        detail={diagnosticsDetail(
          'On by default. Reports are scrubbed before they leave the device: digit runs that could ' +
            'be a PIN, file paths, photo ids and anything passphrase-shaped are removed. No photo, ' +
            'key or file name is ever included.',
        )}
        value={settings.crashReportsEnabled}
        onValueChange={setCrashReports}
      />
      <SwitchRow
        testID="security_analytics"
        label="Share usage statistics"
        detail={diagnosticsDetail(
          'Off by default; opt in only if you want to. Limited to coarse events such as "vault ' +
            'unlocked", with no content, no identifiers and no advertising ID.',
        )}
        value={settings.analyticsEnabled}
        onValueChange={setAnalytics}
      />

      <SectionLabel>Encryption in use</SectionLabel>
      <View style={styles.card} testID="security_encryption_summary">
        {ENCRYPTION_FACTS.map((fact) => (
          <View key={fact} style={styles.fact}>
            <Text style={styles.bullet}>{'•'}</Text>
            <Text style={styles.factText}>{fact}</Text>
          </View>
        ))}
      </View>
      <Paragraph>
        These settings are read-only facts about the build. They cannot be turned off, and turning
        anything above off does not weaken them.
      </Paragraph>
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
    fact: { flexDirection: 'row', gap: spacing.sm },
    bullet: { ...typography.body, color: colors.accent },
    factText: { ...typography.body, color: colors.textMuted, flex: 1, lineHeight: 22 },
  });
