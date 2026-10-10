/**
 * A horizontal progress line, determinate where the work can be counted.
 *
 * It replaces a spinner on the long cloud operations, and the difference is not decoration. A
 * circle says "something is happening"; it says exactly that whether three photos are left or
 * three hundred, and it says it identically to a run that has quietly stalled. A filled line with
 * "12 of 73" under it answers the only question someone waiting actually has, which is how much
 * longer -- and it makes a stall visible, because the number stops moving.
 *
 * `value` omitted means indeterminate: work has started but nothing countable is known yet, which
 * is the real state while an envelope is unwrapped or an index is fetched. That phase animates a
 * travelling segment rather than pretending to a percentage it does not have.
 */
import React, { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import { radius, spacing, type Palette, typography, useStyles } from '@/app/theme';

export interface ProgressBarProps {
  /**
   * 0..1 when the total is known. Omitted means indeterminate.
   *
   * Out-of-range values are clamped rather than rejected: a progress bar is the last thing that
   * should throw, and a caller that is one item out should show a full bar, not crash a screen
   * in the middle of a restore.
   */
  value?: number;
  /** The sentence under the line, e.g. "Uploading 12 of 73". */
  label?: string;
  testID?: string;
}

const TRACK_HEIGHT = 6;
/** How much of the track the travelling segment covers while indeterminate. */
const SEGMENT_RATIO = 0.4;

export function ProgressBar({ value, label, testID }: ProgressBarProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const determinate = value !== undefined;
  const fraction = determinate ? Math.max(0, Math.min(1, value)) : 0;
  const percent = Math.round(fraction * 100);

  const [trackWidth, setTrackWidth] = useState(0);
  // A lazy useState rather than a ref: the value must be created once and never replaced, but
  // reading ref.current during render is exactly what the React Compiler rule forbids.
  const [slide] = useState(() => new Animated.Value(0));

  useEffect(() => {
    // Nothing to animate once there is a real number to show, and nothing to animate before the
    // track has been measured -- translating by an unknown width would park the segment at zero.
    if (determinate || trackWidth === 0) return undefined;
    slide.setValue(0);
    const animation = Animated.loop(
      Animated.timing(slide, {
        toValue: 1,
        duration: 1100,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }),
    );
    animation.start();
    return () => {
      animation.stop();
    };
  }, [determinate, slide, trackWidth]);

  const segmentWidth = Math.max(trackWidth * SEGMENT_RATIO, 1);
  const travel = slide.interpolate({
    inputRange: [0, 1],
    outputRange: [-segmentWidth, trackWidth],
  });

  return (
    <View
      testID={testID}
      accessibilityRole="progressbar"
      // Screen readers get the count, not just "busy". Indeterminate deliberately reports no
      // `now`, because announcing 0% for "unknown" is worse than announcing nothing.
      {...(determinate ? { accessibilityValue: { min: 0, max: 100, now: percent } } : {})}
      {...(label === undefined ? {} : { accessibilityLabel: label })}
      style={styles.wrap}
    >
      <View
        testID={testID === undefined ? undefined : `${testID}-track`}
        style={styles.track}
        onLayout={(event) => {
          setTrackWidth(event.nativeEvent.layout.width);
        }}
      >
        {determinate ? (
          <View
            testID={testID === undefined ? undefined : `${testID}-fill`}
            // Measured pixels rather than a percentage string. The percentage form has to be
            // built with String(percent) to satisfy the template-expression lint rule, and that
            // widens its type to a plain string, which RN's DimensionValue rejects. The track is
            // measured already for the indeterminate branch, so this costs nothing and keeps both
            // branches in the same unit.
            style={[styles.fill, { width: trackWidth * fraction }]}
          />
        ) : (
          <Animated.View
            style={[
              styles.fill,
              { width: segmentWidth, transform: [{ translateX: travel }] },
            ]}
          />
        )}
      </View>
      {label === undefined ? null : (
        <Text
          testID={testID === undefined ? undefined : `${testID}-label`}
          style={styles.label}
        >
          {label}
        </Text>
      )}
    </View>
  );
}

function makeStyles(colors: Palette): ReturnType<typeof StyleSheet.create> {
  return StyleSheet.create({
    wrap: {
      gap: spacing.xs,
      marginBottom: spacing.sm,
      // A bar has no intrinsic width, so inside a centre-aligned column (the restore screen's
      // busy block is one) it would measure zero and never draw. Stretching is a no-op in the
      // ordinary stretch-aligned column.
      alignSelf: 'stretch',
    },
    track: {
      height: TRACK_HEIGHT,
      borderRadius: radius.pill,
      backgroundColor: colors.surfaceAlt,
      // Keeps the travelling segment inside the rounded ends instead of sliding past them.
      overflow: 'hidden',
      justifyContent: 'center',
    },
    fill: {
      height: TRACK_HEIGHT,
      borderRadius: radius.pill,
      backgroundColor: colors.accent,
    },
    label: {
      ...typography.caption,
      color: colors.textMuted,
    },
  });
}
