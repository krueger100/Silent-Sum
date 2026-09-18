/**
 * The numeric keypad used by PIN setup and PIN change, plus the masked indicator above it.
 *
 * The PIN is never rendered: the indicator only shows how many digits have been typed, so a
 * shoulder surfer or a screenshot taken before screen protection engages learns the length at
 * most. The keypad deliberately mirrors the calculator's own key shapes, because the PIN is
 * ultimately typed there.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { radius, spacing, type Palette, typography, useStyles } from '@/app/theme';
import { PIN_POLICY } from '@/auth/types';

export interface PinKeypadProps {
  onDigit: (digit: string) => void;
  onBackspace: () => void;
  /** Keys stop responding while a key derivation is in flight. */
  disabled?: boolean;
}

const ROWS: readonly (readonly (string | null)[])[] = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  [null, '0', 'backspace'],
];

export function PinKeypad({
  onDigit,
  onBackspace,
  disabled = false,
}: PinKeypadProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.pad} accessibilityLabel="PIN keypad">
      {ROWS.map((row, rowIndex) => (
        <View key={`row-${String(rowIndex)}`} style={styles.row}>
          {row.map((label, keyIndex) => {
            if (label === null) {
              return (
                <View key={`gap-${String(rowIndex)}-${String(keyIndex)}`} style={styles.key} />
              );
            }
            const isBackspace = label === 'backspace';
            return (
              <Pressable
                key={label}
                testID={isBackspace ? 'pin_backspace' : `pin_key_${label}`}
                accessibilityRole="button"
                accessibilityLabel={isBackspace ? 'Delete last digit' : label}
                accessibilityState={{ disabled }}
                disabled={disabled}
                onPress={() => {
                  if (isBackspace) onBackspace();
                  else onDigit(label);
                }}
                style={({ pressed }) => [
                  styles.key,
                  styles.keySurface,
                  pressed && !disabled ? styles.keyPressed : null,
                  disabled ? styles.keyDisabled : null,
                ]}
              >
                <Text style={styles.keyLabel}>{isBackspace ? '⌫' : label}</Text>
              </Pressable>
            );
          })}
        </View>
      ))}
    </View>
  );
}

export interface PinDotsProps {
  count: number;
  max?: number;
}

/** Filled/empty dots: how many digits are typed, never which ones. */
export function PinDots({ count, max = PIN_POLICY.maxLength }: PinDotsProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const slots = Array.from({ length: max }, (_, index) => index);
  return (
    <View
      testID="pin_dots"
      style={styles.dots}
      accessibilityLabel={`${String(count)} of ${String(max)} digits entered`}
    >
      {slots.map((index) => (
        <View
          key={`dot-${String(index)}`}
          style={[styles.dot, index < count ? styles.dotFilled : null]}
        />
      ))}
    </View>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    pad: { gap: spacing.sm, alignSelf: 'center' },
    row: { flexDirection: 'row', gap: spacing.sm, justifyContent: 'center' },
    key: { width: 84, height: 60 },
    keySurface: {
      backgroundColor: colors.surfaceAlt,
      borderRadius: radius.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    keyPressed: { opacity: 0.7 },
    keyDisabled: { opacity: 0.4 },
    keyLabel: { ...typography.title, color: colors.text, fontSize: 26 },
    dots: {
      flexDirection: 'row',
      gap: spacing.sm + 2,
      justifyContent: 'center',
      alignItems: 'center',
      minHeight: 20,
    },
    dot: {
      width: 12,
      height: 12,
      borderRadius: radius.pill,
      backgroundColor: colors.border,
    },
    dotFilled: { backgroundColor: colors.accent, width: 14, height: 14 },
  });
