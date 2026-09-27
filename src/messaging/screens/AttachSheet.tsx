/**
 * Where a photo or a video comes from: the camera, the photo library, or the vault.
 *
 * Three rows rather than two because the vault is where a user's photos already are, and a
 * messenger that could not send them would be strange. It is listed last, and its row says what
 * it is, because it is the only one of the three that moves something out of the vault.
 */
import React from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { radius, spacing, typography, useStyles, useTheme, type Palette } from '@/app/theme';

export type AttachSource = 'camera' | 'library' | 'vault';

export interface AttachSheetProps {
  visible: boolean;
  onPick: (source: AttachSource) => void;
  onClose: () => void;
}

const ROWS: readonly { source: AttachSource; label: string; hint: string }[] = [
  { source: 'camera', label: 'Camera', hint: 'Take a photo or record a video' },
  { source: 'library', label: 'Photo library', hint: 'Choose from this phone' },
  { source: 'vault', label: 'From the vault', hint: 'Send a copy of something you keep here' },
];

export function AttachSheet({ visible, onPick, onClose }: AttachSheetProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const colors = useTheme();
  // Gesture-navigation bars overlap the last row on a tall Android phone without this.
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} testID="attach_backdrop">
        <Pressable
          style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}
          testID="attach_sheet"
        >
          <View style={styles.grabber} />
          {ROWS.map((row) => (
            <Pressable
              key={row.source}
              testID={`attach_${row.source}`}
              accessibilityRole="button"
              accessibilityLabel={row.label}
              onPress={() => {
                onPick(row.source);
              }}
              style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
            >
              <Text style={styles.rowLabel}>{row.label}</Text>
              <Text style={styles.rowHint}>{row.hint}</Text>
            </Pressable>
          ))}
          <Pressable
            testID="attach_cancel"
            accessibilityRole="button"
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
    pressed: { opacity: 0.6 },
    rowLabel: { ...typography.body, color: colors.text },
    rowHint: { ...typography.caption, color: colors.textMuted, marginTop: 2 },
  });
