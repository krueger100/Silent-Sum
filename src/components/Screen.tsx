/** Page chrome: safe area, background, an optional title row with a back affordance. */
import React, { type ReactNode } from 'react';
import { KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { spacing, type Palette, typography, useStyles } from '@/app/theme';
import { KEYBOARD_BEHAVIOR } from '@/components/keyboardAvoidance';

export interface ScreenProps {
  title?: string;
  onBack?: () => void;
  /** Rendered at the trailing edge of the title row. */
  actions?: ReactNode;
  scroll?: boolean;
  children: ReactNode;
  testID?: string;
}

export function Screen({
  title,
  onBack,
  actions,
  scroll = false,
  children,
  testID,
}: ScreenProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  /**
   * Scrolling pages get out of the keyboard's way themselves.
   *
   * `android:windowSoftInputMode="adjustResize"` is set, and it used to be enough. It is not any
   * more: with edge-to-edge on (`edgeToEdgeEnabled=true`, the default since Android 15) the window
   * no longer shrinks when the IME opens -- the app keeps the whole screen and simply draws behind
   * it. A PIN field near the bottom of a form is then covered by the keyboard that is meant to be
   * typing into it, and no amount of scrolling reaches it because the content has nowhere to go.
   *
   * So the inset is applied here instead, from the keyboard events, on both platforms. `padding`
   * rather than `height` because the child is a ScrollView: shrinking its box leaves the content
   * scrollable and lets the focused input be scrolled into view, where changing its height would
   * reflow the whole page.
   */
  const body = scroll ? (
    <KeyboardAvoidingView
      testID="screen-keyboard-avoider"
      behavior={KEYBOARD_BEHAVIOR}
      style={styles.flex}
    >
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardShouldPersistTaps="handled"
        style={styles.flex}
      >
        {children}
      </ScrollView>
    </KeyboardAvoidingView>
  ) : (
    <View style={styles.flex}>{children}</View>
  );

  /**
   * All four edges, not just the vertical pair.
   *
   * Under edge-to-edge the window covers the system bars on every side, and in landscape the side
   * the navigation bar moves to is a horizontal one. With only top and bottom applied, a phone
   * rotated into landscape with three-button navigation drew its trailing content -- the
   * calculator's last keypad column, a row's chevron -- underneath that bar. Gesture navigation
   * hides the bug, because its horizontal insets are nearly zero, which is why it survived.
   *
   * In portrait `left` and `right` are 0 on effectively every device, so this changes nothing
   * there.
   */
  return (
    <View
      testID={testID}
      style={[
        styles.root,
        {
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
          paddingLeft: insets.left,
          paddingRight: insets.right,
        },
      ]}
    >
      {title === undefined && onBack === undefined && actions === undefined ? null : (
        <View style={styles.header}>
          {onBack === undefined ? (
            <View style={styles.headerSlot} />
          ) : (
            <Pressable
              testID="screen-back"
              accessibilityRole="button"
              accessibilityLabel="Back"
              onPress={onBack}
              style={styles.headerSlot}
              hitSlop={12}
            >
              <Text style={styles.backGlyph}>‹</Text>
            </Pressable>
          )}
          <Text style={styles.title} numberOfLines={1}>
            {title ?? ''}
          </Text>
          <View style={styles.headerActions}>{actions}</View>
        </View>
      )}
      {body}
    </View>
  );
}

export function SectionLabel({ children }: { children: ReactNode }): React.JSX.Element {
  const styles = useStyles(makeStyles);
  return <Text style={styles.sectionLabel}>{children}</Text>;
}

export function Paragraph({ children }: { children: ReactNode }): React.JSX.Element {
  const styles = useStyles(makeStyles);
  return <Text style={styles.paragraph}>{children}</Text>;
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    flex: { flex: 1 },
    scrollContent: { padding: spacing.md, paddingBottom: spacing.xl, gap: spacing.md },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.sm,
      gap: spacing.sm,
    },
    headerSlot: { width: 40, alignItems: 'center', justifyContent: 'center', minHeight: 40 },
    headerActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      minWidth: 40,
      justifyContent: 'flex-end',
    },
    backGlyph: { color: colors.text, fontSize: 34, lineHeight: 38 },
    title: { ...typography.title, color: colors.text, flex: 1 },
    sectionLabel: {
      ...typography.caption,
      color: colors.textMuted,
      textTransform: 'uppercase',
      letterSpacing: 1,
      marginTop: spacing.md,
    },
    paragraph: { ...typography.body, color: colors.textMuted, lineHeight: 22 },
  });
