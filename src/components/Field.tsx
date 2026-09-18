/**
 * A labelled text input, with a Show/Hide control on the ones that hide what you type.
 *
 * A recovery passphrase is long, typed twice, and can never be reset if it is mistyped - the
 * backup it protects becomes unreadable by everyone, permanently. Making the user prove a 12+
 * character secret against a row of dots twice, with no way to look, is how that happens. The
 * toggle is off to begin with and is only ever turned on deliberately; while the vault is open
 * the window carries FLAG_SECURE, so a revealed secret still cannot be screenshotted or recorded
 * on Android.
 *
 * Revealing is per field and lives only as long as the field is mounted: every screen here clears
 * and unmounts its inputs once the secret has been used, so nothing comes back revealed.
 */
import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { radius, spacing, type Palette, typography, useStyles, useTheme } from '@/app/theme';

export interface FieldProps {
  testID: string;
  label: string;
  value: string;
  onChangeText: (next: string) => void;
  /** Hides the text and adds the Show/Hide control. */
  secure?: boolean;
  keyboardType?: 'email-address' | 'number-pad';
}

export function Field({
  testID,
  label,
  value,
  onChangeText,
  secure = false,
  keyboardType,
}: FieldProps): React.JSX.Element {
  const colors = useTheme();
  const styles = useStyles(makeStyles);
  const [revealed, setRevealed] = useState(false);

  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.inputRow}>
        <TextInput
          testID={testID}
          accessibilityLabel={label}
          value={value}
          onChangeText={onChangeText}
          secureTextEntry={secure && !revealed}
          autoCapitalize="none"
          autoCorrect={false}
          {...(keyboardType === undefined ? {} : { keyboardType })}
          style={styles.input}
          placeholderTextColor={colors.textMuted}
        />
        {secure ? (
          <Pressable
            testID={`${testID}_reveal`}
            accessibilityRole="button"
            accessibilityLabel={`${revealed ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
            accessibilityState={{ selected: revealed }}
            hitSlop={8}
            onPress={() => {
              setRevealed((was) => !was);
            }}
            style={({ pressed }) => [styles.toggle, pressed ? styles.pressed : null]}
          >
            <Text style={styles.toggleText}>{revealed ? 'Hide' : 'Show'}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    field: { gap: spacing.xs },
    fieldLabel: { ...typography.caption, color: colors.textMuted },
    // The border lives on the row so the toggle sits inside the field rather than beside it.
    inputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.sm,
    },
    input: {
      flex: 1,
      color: colors.text,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      minHeight: 48,
    },
    toggle: { paddingHorizontal: spacing.md, minHeight: 48, justifyContent: 'center' },
    pressed: { opacity: 0.6 },
    toggleText: { ...typography.label, color: colors.accent },
  });
