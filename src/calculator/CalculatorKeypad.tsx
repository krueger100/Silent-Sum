/**
 * A conventional four-column calculator keypad.
 *
 * There is no vault affordance here at all: the keypad is exactly what it appears to be, and the
 * only thing that distinguishes an unlock from arithmetic is which digits the user happens to
 * type before pressing `=`.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { radius, spacing, type Palette, useStyles } from '@/app/theme';
import { CALC_OP_SYMBOL, type CalcKey } from '@/calculator/types';

type KeyTone = 'digit' | 'function' | 'operator';

interface KeySpec {
  key: CalcKey;
  label: string;
  tone: KeyTone;
  accessibilityLabel?: string;
}

const ROWS: readonly (readonly KeySpec[])[] = [
  [
    { key: 'clear', label: 'C', tone: 'function', accessibilityLabel: 'Clear' },
    { key: 'negate', label: '+/−', tone: 'function', accessibilityLabel: 'Toggle sign' },
    { key: 'percent', label: '%', tone: 'function', accessibilityLabel: 'Percent' },
    { key: 'divide', label: CALC_OP_SYMBOL.divide, tone: 'operator', accessibilityLabel: 'Divide' },
  ],
  [
    { key: 'digit7', label: '7', tone: 'digit' },
    { key: 'digit8', label: '8', tone: 'digit' },
    { key: 'digit9', label: '9', tone: 'digit' },
    {
      key: 'multiply',
      label: CALC_OP_SYMBOL.multiply,
      tone: 'operator',
      accessibilityLabel: 'Multiply',
    },
  ],
  [
    { key: 'digit4', label: '4', tone: 'digit' },
    { key: 'digit5', label: '5', tone: 'digit' },
    { key: 'digit6', label: '6', tone: 'digit' },
    {
      key: 'subtract',
      label: CALC_OP_SYMBOL.subtract,
      tone: 'operator',
      accessibilityLabel: 'Subtract',
    },
  ],
  [
    { key: 'digit1', label: '1', tone: 'digit' },
    { key: 'digit2', label: '2', tone: 'digit' },
    { key: 'digit3', label: '3', tone: 'digit' },
    { key: 'add', label: CALC_OP_SYMBOL.add, tone: 'operator', accessibilityLabel: 'Add' },
  ],
  [
    { key: 'digit0', label: '0', tone: 'digit' },
    { key: 'point', label: '.', tone: 'digit', accessibilityLabel: 'Decimal point' },
    { key: 'backspace', label: '⌫', tone: 'function', accessibilityLabel: 'Backspace' },
    { key: 'equals', label: '=', tone: 'operator', accessibilityLabel: 'Equals' },
  ],
];

export function CalculatorKeypad({
  onPress,
}: {
  onPress: (key: CalcKey) => void;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.pad}>
      {ROWS.map((row, rowIndex) => (
        <View style={styles.row} key={`row-${String(rowIndex)}`}>
          {row.map((spec) => (
            <Pressable
              key={spec.key}
              testID={`calc_key_${spec.key}`}
              accessibilityRole="button"
              accessibilityLabel={spec.accessibilityLabel ?? spec.label}
              onPress={() => {
                onPress(spec.key);
              }}
              style={({ pressed }) => [
                styles.key,
                styles[spec.tone],
                pressed ? styles.pressed : null,
              ]}
            >
              <Text
                style={[styles.keyLabel, spec.tone === 'operator' ? styles.operatorLabel : null]}
              >
                {spec.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ))}
    </View>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    pad: { flex: 1, padding: spacing.sm, gap: spacing.sm, justifyContent: 'flex-end' },
    row: { flexDirection: 'row', gap: spacing.sm, flex: 1 },
    key: {
      flex: 1,
      borderRadius: radius.lg,
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 56,
    },
    digit: { backgroundColor: colors.surfaceAlt },
    function: { backgroundColor: colors.surface },
    operator: { backgroundColor: colors.accent },
    pressed: { opacity: 0.7 },
    keyLabel: { color: colors.text, fontSize: 26, fontWeight: '500' },
    operatorLabel: { color: colors.accentText },
  });
