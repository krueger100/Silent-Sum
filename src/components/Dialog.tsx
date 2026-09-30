/**
 * Modal dialogs.
 *
 * `ConfirmDialog` is for ordinary yes/no. `TypedConfirmDialog` requires the user to type an exact
 * phrase and is reserved for irreversible destruction, where an accidental tap must not be enough.
 */
import React, { useState, type ReactNode } from 'react';
import {
  Modal,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { radius, spacing, type Palette, typography, useStyles, useTheme } from '@/app/theme';
import { Button } from '@/components/Button';
import { KeyboardAvoider } from '@/components/keyboardAvoidance';

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  /**
   * Drops the cancel button. Only for a dialog that reports something already done, where there
   * is nothing left to decline; a dialog that asks for anything always keeps its way out.
   */
  hideCancel?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children?: ReactNode;
  testID?: string;
}

export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  busy = false,
  hideCancel = false,
  onConfirm,
  onCancel,
  children,
  testID,
}: ConfirmDialogProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <KeyboardAvoider style={styles.backdrop}>
        <View style={styles.card} testID={testID}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.message}>{message}</Text>
          {children}
          <View style={styles.actions}>
            {hideCancel ? null : (
              <Button
                testID={testID === undefined ? undefined : `${testID}-cancel`}
                label={cancelLabel}
                variant="secondary"
                onPress={onCancel}
                style={styles.action}
              />
            )}
            <Button
              testID={testID === undefined ? undefined : `${testID}-confirm`}
              label={confirmLabel}
              variant={destructive ? 'danger' : 'primary'}
              busy={busy}
              onPress={onConfirm}
              style={styles.action}
            />
          </View>
        </View>
      </KeyboardAvoider>
    </Modal>
  );
}

export function TypedConfirmDialog({
  phrase,
  onConfirm,
  ...props
}: Omit<ConfirmDialogProps, 'onConfirm' | 'children'> & {
  phrase: string;
  onConfirm: () => void;
}): React.JSX.Element {
  // Remounting on every open is what clears the field, without an effect that writes state during
  // a render pass. A half-typed destruction phrase must never survive a close and reopen.
  return props.visible ? (
    <TypedConfirmBody key="open" phrase={phrase} onConfirm={onConfirm} {...props} />
  ) : (
    <TypedConfirmBody key="closed" phrase={phrase} onConfirm={onConfirm} {...props} />
  );
}

function TypedConfirmBody({
  phrase,
  onConfirm,
  ...props
}: Omit<ConfirmDialogProps, 'onConfirm' | 'children'> & {
  phrase: string;
  onConfirm: () => void;
}): React.JSX.Element {
  const colors = useTheme();
  const styles = useStyles(makeStyles);
  const [typed, setTyped] = useState('');

  const matches = typed.trim() === phrase;
  return (
    <ConfirmDialog
      {...props}
      onConfirm={() => {
        if (matches) onConfirm();
      }}
    >
      <Text style={styles.prompt}>
        Type <Text style={styles.phrase}>{phrase}</Text> to confirm.
      </Text>
      <TextInput
        testID="typed-confirm-input"
        accessibilityLabel={`Type ${phrase} to confirm`}
        value={typed}
        onChangeText={setTyped}
        autoCapitalize="characters"
        autoCorrect={false}
        style={styles.input}
        placeholder={phrase}
        placeholderTextColor={colors.textMuted}
      />
    </ConfirmDialog>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.6)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.lg,
    },
    card: {
      width: '100%',
      maxWidth: 420,
      backgroundColor: colors.surface,
      borderRadius: radius.lg,
      padding: spacing.lg,
      gap: spacing.sm,
    },
    title: { ...typography.title, color: colors.text },
    message: { ...typography.body, color: colors.textMuted, lineHeight: 22 },
    prompt: { ...typography.body, color: colors.textMuted, marginTop: spacing.sm },
    phrase: { color: colors.text, fontWeight: '700' },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: radius.sm,
      color: colors.text,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      minHeight: 48,
    },
    // Content-driven rather than a fixed half each. Two labels of similar length still come out
    // as equal halves, a longer one simply takes the room it needs, and a pair that genuinely
    // cannot share a line wraps so each gets a full-width row of its own. Breaking a label
    // across two lines inside a cramped button is never the answer: these are the words the
    // user is answering with, so they have to read as one phrase.
    actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.md },
    action: { flexGrow: 1, flexBasis: 'auto' },
  });
