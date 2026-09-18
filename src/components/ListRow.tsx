/** A settings-style row: label, optional detail, optional trailing control. */
import React, { type ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';

import { radius, spacing, type Palette, typography, useStyles, useTheme } from '@/app/theme';

export interface ListRowProps {
  label: string;
  detail?: string;
  value?: string;
  onPress?: () => void;
  trailing?: ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  testID?: string;
}

export function ListRow({
  label,
  detail,
  value,
  onPress,
  trailing,
  destructive = false,
  disabled = false,
  testID,
}: ListRowProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const content = (
    <View style={[styles.row, disabled ? styles.disabled : null]}>
      <View style={styles.text}>
        <Text style={[styles.label, destructive ? styles.destructive : null]}>{label}</Text>
        {detail === undefined ? null : <Text style={styles.detail}>{detail}</Text>}
      </View>
      {value === undefined ? null : <Text style={styles.value}>{value}</Text>}
      {trailing}
    </View>
  );

  if (onPress === undefined) return content;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => (pressed ? styles.pressed : null)}
    >
      {content}
    </Pressable>
  );
}

export function SwitchRow({
  label,
  detail,
  value,
  onValueChange,
  disabled = false,
  testID,
}: {
  label: string;
  detail?: string;
  value: boolean;
  onValueChange: (next: boolean) => void;
  disabled?: boolean;
  testID?: string;
}): React.JSX.Element {
  const colors = useTheme();
  return (
    <ListRow
      label={label}
      {...(detail === undefined ? {} : { detail })}
      disabled={disabled}
      trailing={
        <Switch
          testID={testID}
          accessibilityLabel={label}
          value={value}
          onValueChange={onValueChange}
          disabled={disabled}
          trackColor={{ true: colors.accent, false: colors.border }}
        />
      }
    />
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md - 2,
      minHeight: 56,
    },
    pressed: { opacity: 0.75 },
    disabled: { opacity: 0.5 },
    text: { flex: 1, gap: 2 },
    label: { ...typography.body, color: colors.text },
    detail: { ...typography.caption, color: colors.textMuted, lineHeight: 17 },
    value: { ...typography.body, color: colors.textMuted },
    destructive: { color: colors.danger },
  });
