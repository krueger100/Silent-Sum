/**
 * What can be done to one message, reached by holding it.
 *
 * Two deletions that are genuinely different things, so they are worded as what they do rather
 * than as a severity ladder:
 *
 *   Delete for me            hides it on this phone. Nobody is told. Offered for every message,
 *                            including the other person's and one already withdrawn, because it
 *                            is a decision about what you want to look at.
 *   Delete for everyone      withdraws it from the conversation. Only your own messages, only
 *                            while they still have content, and the server checks both again.
 *
 * The destructive row is last and the cancel row is separated, because the two deletions sit next
 * to each other and the irreversible one must not be the one a thumb lands on by default.
 */
import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { radius, spacing, typography, useStyles, useTheme, type Palette } from '@/app/theme';

export interface MessageActionsSheetProps {
  visible: boolean;
  /** True only when withdrawing it for both sides is actually permitted. */
  canDeleteForEveryone: boolean;
  onDeleteForMe: () => void;
  onDeleteForEveryone: () => void;
  onClose: () => void;
}

export function MessageActionsSheet({
  visible,
  canDeleteForEveryone,
  onDeleteForMe,
  onDeleteForEveryone,
  onClose,
}: MessageActionsSheetProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const colors = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} testID="message_actions_backdrop">
        {/* Swallows the tap so pressing the sheet itself does not dismiss it. */}
        <Pressable
          style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}
          testID="message_actions_sheet"
        >
          <View style={styles.grabber} />
          <Pressable
            testID="message_delete_for_me"
            accessibilityRole="button"
            accessibilityLabel="Delete for me"
            onPress={onDeleteForMe}
            style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
          >
            <Text style={styles.rowLabel}>Delete for me</Text>
            <Text style={styles.rowHint}>Removes it from this phone only</Text>
          </Pressable>

          {canDeleteForEveryone ? (
            <Pressable
              testID="message_delete_for_everyone"
              accessibilityRole="button"
              accessibilityLabel="Delete for everyone"
              onPress={onDeleteForEveryone}
              style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
            >
              <Text style={[styles.rowLabel, styles.destructive]}>Delete for everyone</Text>
              <Text style={styles.rowHint}>Removes it for both of you. This cannot be undone.</Text>
            </Pressable>
          ) : null}

          <View style={styles.separator} />
          <Pressable
            testID="message_actions_cancel"
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            onPress={onClose}
            style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
          >
            <Text style={[styles.rowLabel, { color: colors.textMuted }]}>Cancel</Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'flex-end',
    },
    grabber: {
      alignSelf: 'center',
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.border,
      marginBottom: spacing.sm,
    },
    sheet: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      paddingVertical: spacing.sm,
    },
    row: {
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.lg,
    },
    separator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
      marginVertical: spacing.xs,
    },
    pressed: { opacity: 0.6 },
    rowLabel: { ...typography.body, color: colors.text },
    destructive: { color: colors.danger },
    rowHint: { ...typography.caption, color: colors.textMuted, marginTop: 2 },
  });
