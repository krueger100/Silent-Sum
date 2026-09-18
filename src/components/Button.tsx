/** Shared button styles so every screen looks like one app. */
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { radius, spacing, type Palette, typography, useStyles, useTheme } from '@/app/theme';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

export interface ButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  busy?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  disabled = false,
  busy = false,
  testID,
  style,
}: ButtonProps): React.JSX.Element {
  const colors = useTheme();
  const styles = useStyles(makeStyles);
  const inactive = disabled || busy;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.base,
        styles[variant],
        pressed && !inactive ? styles.pressed : null,
        inactive ? styles.disabled : null,
        style,
      ]}
    >
      <View style={styles.content}>
        {busy ? <ActivityIndicator size="small" color={colors.accentText} /> : null}
        <Text
          style={[
            styles.label,
            variant === 'secondary' || variant === 'ghost' ? styles.labelDark : null,
          ]}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    base: {
      borderRadius: radius.md,
      paddingVertical: spacing.md - 2,
      paddingHorizontal: spacing.lg,
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 48,
    },
    content: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexShrink: 1 },
    primary: { backgroundColor: colors.accent },
    secondary: { backgroundColor: colors.surfaceAlt },
    danger: { backgroundColor: colors.danger },
    ghost: { backgroundColor: 'transparent' },
    pressed: { opacity: 0.8 },
    disabled: { opacity: 0.45 },
    // `textAlign` matters only in the last resort where a label still has to wrap: without it
    // the block is centred but its lines are not, which reads as a misaligned button.
    label: {
      ...typography.label,
      color: colors.accentText,
      fontSize: 16,
      textAlign: 'center',
      flexShrink: 1,
    },
    labelDark: { color: colors.text },
  });
