/**
 * First-run explanation, shown over the calculator.
 *
 * It says the awkward parts out loud before anything is created: what this app really is, that the
 * PIN is the only key, that there is no recovery, and how the vault is opened. A user who only
 * learns the "no recovery" part after losing photos has been failed by the product, not by the
 * crypto.
 *
 * Rendered as an in-tree overlay rather than a `Modal` so the navigator can place it above the
 * calculator without a second native window, and so it stays testable.
 */
import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { radius, spacing, type Palette, typography, useStyles } from '@/app/theme';
import { Button } from '@/components/Button';

export interface WelcomeSheetProps {
  /** The user chose to create a vault now. */
  onSetup: () => void;
  /** The user dismissed the sheet. Setup stays reachable from the menu. */
  onLater: () => void;
}

const POINTS: readonly string[] = [
  'This is a working calculator. It also holds a private photo vault that nothing on the home screen advertises.',
  'Photos you put in the vault are encrypted on this device. They are not in your photo library and they are not readable by other apps.',
  'Your PIN is the key. It is held in the phone’s secure hardware store, is never sent anywhere, and the vault opens with no network at all.',
  'There is no recovery. If you forget the PIN, the photos cannot be recovered by anyone, including us. The only way forward is to erase the vault and start over.',
];

export function WelcomeSheet({ onSetup, onLater }: WelcomeSheetProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  return (
    <View style={styles.backdrop} testID="welcome_sheet">
      <View style={[styles.sheet, { paddingBottom: spacing.md + insets.bottom }]}>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          testID="welcome_scroll"
        >
          <Text style={styles.title}>A calculator with a private vault</Text>
          {POINTS.map((point) => (
            <View key={point} style={styles.point}>
              <Text style={styles.bullet}>{'•'}</Text>
              <Text style={styles.pointText}>{point}</Text>
            </View>
          ))}
          <View style={styles.howto}>
            <Text style={styles.howtoTitle}>Opening the vault</Text>
            <Text style={styles.howtoLine}>
              Work out a sum whose answer is a part of your PIN and press =. You are told how many
              digits are still missing. Keep going: the vault opens as soon as the parts add up to
              the whole PIN. Anything else stays a calculator.
            </Text>
          </View>
        </ScrollView>
        <View style={styles.actions}>
          <Button testID="welcome_setup" label="Set up the vault" onPress={onSetup} />
          <Button testID="welcome_later" label="Not now" variant="ghost" onPress={onLater} />
        </View>
      </View>
    </View>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    backdrop: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0,0,0,0.65)',
      justifyContent: 'flex-end',
    },
    sheet: {
      maxHeight: '90%',
      backgroundColor: colors.surface,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.lg,
      gap: spacing.md,
    },
    content: { gap: spacing.md, paddingBottom: spacing.md },
    title: { ...typography.title, color: colors.text },
    point: { flexDirection: 'row', gap: spacing.sm },
    bullet: { ...typography.body, color: colors.accent },
    pointText: { ...typography.body, color: colors.textMuted, flex: 1, lineHeight: 22 },
    howto: {
      backgroundColor: colors.surfaceAlt,
      borderRadius: radius.md,
      padding: spacing.md,
      gap: spacing.xs,
    },
    howtoTitle: { ...typography.label, color: colors.text, fontSize: 16 },
    howtoLine: { ...typography.body, color: colors.textMuted, lineHeight: 22 },
    actions: { gap: spacing.sm },
  });
