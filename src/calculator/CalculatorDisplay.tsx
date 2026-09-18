/** The calculator's readout: pending expression above, current value below. */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { spacing, type Palette, typography, useStyles } from '@/app/theme';
import { displayText, expressionLine } from '@/calculator/calculatorEngine';
import type { CalculatorState } from '@/calculator/types';

export function CalculatorDisplay({ state }: { state: CalculatorState }): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const value = displayText(state);
  const expression = expressionLine(state);
  return (
    <View style={styles.root} testID="calc_display">
      <Text style={styles.expression} numberOfLines={1} testID="calc_expression">
        {expression}
      </Text>
      <Text
        style={styles.value}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.4}
        testID="calc_value"
        // The readout can hold a PIN mid-entry, so it is never announced automatically.
        accessibilityLiveRegion="none"
      >
        {value}
      </Text>
    </View>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    root: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      justifyContent: 'flex-end',
      alignItems: 'flex-end',
      minHeight: 120,
    },
    expression: { ...typography.body, color: colors.textMuted, minHeight: 22 },
    value: { ...typography.display, color: colors.text, textAlign: 'right' },
  });
