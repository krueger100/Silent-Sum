/**
 * An opaque cover drawn over everything while the app is not in the foreground.
 *
 * It deliberately shows nothing but the app's calculator identity: the point is that the
 * app-switcher thumbnail, and any screenshot the OS takes during a transition, contain no vault
 * content and no hint that a vault exists.
 */
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { type Palette, useStyles } from '@/app/theme';

export function PrivacyCurtain(): React.JSX.Element {
  const styles = useStyles(makeStyles);
  return (
    <View
      style={styles.curtain}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      testID="privacy-curtain"
    >
      <Text style={styles.glyph}>=</Text>
    </View>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    curtain: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: colors.curtain,
      alignItems: 'center',
      justifyContent: 'center',
    },
    glyph: {
      color: colors.textMuted,
      fontSize: 48,
      fontWeight: '300',
    },
  });
