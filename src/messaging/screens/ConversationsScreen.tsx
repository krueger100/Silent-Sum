/**
 * The conversation list, and the only place a new one is started.
 *
 * Reading the list needs nothing but a signed-in account: who you have talked to, when, and how
 * many unread messages are waiting is all held in the shared conversation document, unencrypted,
 * because it names nobody -- only account ids the app already has. The names shown come from this
 * account's own encrypted contacts, so a locked vault shows ids instead of addresses.
 *
 * The screen is a list and nothing else. Starting a conversation is a button that opens a sheet
 * rather than a form parked under the rows, because the form is used once per contact and the
 * list is used every time; and there is deliberately no message preview on a row -- the bodies
 * are encrypted and the list document has never seen one. What a row can honestly show is who,
 * when, and how many are waiting, so that is what it shows.
 */
import React, { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useServices } from '@/app/ServicesProvider';
import { radius, spacing, typography, useStyles, useTheme, type Palette } from '@/app/theme';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { KeyboardAvoider } from '@/components/keyboardAvoidance';
import { Paragraph, Screen } from '@/components/Screen';
import { looksLikeEmail } from '@/messaging/messaging';
import {
  EMPTY_MESSAGING_STATE,
  MessagingError,
  describeMessagingError,
  type ConversationView,
  type MessagingState,
} from '@/messaging/messagingService';
import { Avatar } from '@/messaging/screens/Avatar';
import { listTimeLabel } from '@/messaging/screens/chatTime';

const AVATAR_SIZE = 46;

export interface ConversationsScreenProps {
  onBack?: () => void;
  /** Opens one conversation. */
  onOpen?: (conversationId: string) => void;
  /** Opens the plans screen for an account without Pro. */
  onPlans?: () => void;
}

/** An address is what the user recognises; a raw id is the honest fallback. */
function nameFor(conversation: ConversationView): string {
  return conversation.label ?? conversation.peerUid;
}

function describeError(error: unknown): string {
  return error instanceof MessagingError
    ? describeMessagingError(error.code)
    : 'That did not work. Try again.';
}

export function ConversationsScreen({
  onBack,
  onOpen,
  onPlans,
}: ConversationsScreenProps): React.ReactElement {
  const services = useServices();
  const messaging = services.messaging;
  const styles = useStyles(createStyles);
  const [state, setState] = useState<MessagingState>(EMPTY_MESSAGING_STATE);
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The conversation awaiting a delete confirmation, or null. */
  const [deleting, setDeleting] = useState<ConversationView | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    const stop = messaging.watch(setState, () => {
      setError('Conversations could not be loaded.');
    });
    return stop;
  }, [messaging]);

  const open = useCallback(
    (conversationId: string) => {
      onOpen?.(conversationId);
    },
    [onOpen],
  );

  const started = useCallback(
    (conversationId: string) => {
      setComposing(false);
      onOpen?.(conversationId);
    },
    [onOpen],
  );

  if (!messaging.available) {
    return (
      <Screen title="Messages" onBack={onBack} scroll testID="messages_screen">
        <View style={styles.notice} testID="messages_unavailable">
          <Paragraph>Messaging is not available in this build.</Paragraph>
        </View>
      </Screen>
    );
  }

  if (!state.signedIn) {
    return (
      <Screen title="Messages" onBack={onBack} scroll testID="messages_screen">
        <View style={styles.notice} testID="messages_signed_out">
          <Paragraph>Sign in to your backup account to message other SilentSum users.</Paragraph>
        </View>
      </Screen>
    );
  }

  const now = services.clock.now();
  const empty = state.conversations.length === 0;

  return (
    <Screen title="Messages" onBack={onBack} testID="messages_screen">
      <View style={styles.body}>
        {state.unlocked ? null : (
          <View style={styles.banner} testID="messages_locked">
            <Text style={styles.bannerText}>
              Unlock the vault to read and send messages. Conversations are encrypted with a key
              derived from it, so a locked vault cannot open them.
            </Text>
          </View>
        )}

        {state.canMessage ? null : (
          <View style={styles.banner} testID="messages_pro_required">
            <Text style={styles.bannerText}>
              Messaging is a SilentSum Pro feature. You can still read anything already sent to
              you.
            </Text>
            {onPlans === undefined ? null : (
              <Button
                testID="messages_plans"
                label="See plans"
                variant="secondary"
                onPress={onPlans}
              />
            )}
          </View>
        )}

        {empty ? (
          <View style={styles.empty} testID="messages_empty">
            <Text style={styles.emptyTitle}>No conversations yet</Text>
            <Text style={styles.emptyText}>
              {state.canMessage
                ? 'Start one with the e-mail address of another SilentSum account. Everything you ' +
                  'send is encrypted on this device.'
                : 'Anyone with Pro can start a conversation with you, and you can read it here.'}
            </Text>
          </View>
        ) : (
          <FlatList
            testID="messages_list"
            data={state.conversations}
            keyExtractor={(conversation) => conversation.id}
            contentContainerStyle={styles.listContent}
            ItemSeparatorComponent={Separator}
            renderItem={({ item }) => (
              <ConversationRow
                conversation={item}
                now={now}
                onOpen={open}
                onLongPress={setDeleting}
              />
            )}
          />
        )}

        {error === null ? null : (
          <Text testID="messages_error" style={styles.error}>
            {error}
          </Text>
        )}

        {state.canMessage ? (
          <Pressable
            testID="messages_new"
            accessibilityRole="button"
            accessibilityLabel="New conversation"
            onPress={() => {
              setComposing(true);
            }}
            style={({ pressed }) => [styles.fab, pressed ? styles.pressed : null]}
          >
            <Text style={styles.fabGlyph}>+</Text>
          </Pressable>
        ) : null}
      </View>

      <NewConversationSheet
        visible={composing}
        onClose={() => {
          setComposing(false);
        }}
        onStarted={started}
      />
      {/*
        A confirmation, not a menu row. This is the one action in messaging that destroys the
        other person's copy as well, and unlike a withdrawn message it leaves them no placeholder
        to explain where the thread went -- so it is worth one deliberate tap.
      */}
      <ConfirmDialog
        testID="messages_delete_confirm"
        visible={deleting !== null}
        destructive
        busy={deleteBusy}
        title="Delete this conversation?"
        message={
          deleting === null
            ? ''
            : `Every message with ${nameFor(deleting)}, and anything sent in it, is deleted for ` +
              'both of you. This cannot be undone, and they are not told.'
        }
        confirmLabel="Delete for both"
        onCancel={() => {
          setDeleting(null);
        }}
        onConfirm={() => {
          const target = deleting;
          if (target === null) return;
          setDeleteBusy(true);
          void (async () => {
            try {
              await messaging.deleteConversation(target.id);
              setDeleting(null);
            } catch (caught) {
              setError(describeError(caught));
              setDeleting(null);
            } finally {
              setDeleteBusy(false);
            }
          })();
        }}
      />
    </Screen>
  );
}

function Separator(): React.JSX.Element {
  const styles = useStyles(createStyles);
  return <View style={styles.separator} />;
}

interface ConversationRowProps {
  readonly conversation: ConversationView;
  readonly now: number;
  readonly onOpen: (conversationId: string) => void;
  readonly onLongPress: (conversation: ConversationView) => void;
}

function ConversationRow({
  conversation,
  now,
  onOpen,
  onLongPress,
}: ConversationRowProps): React.JSX.Element {
  const styles = useStyles(createStyles);
  const name = nameFor(conversation);
  const unread = conversation.unread > 0;
  return (
    <Pressable
      testID={'messages_row_' + conversation.id}
      accessibilityRole="button"
      accessibilityLabel={
        unread
          ? `${name}, ${String(conversation.unread)} unread`
          : name
      }
      onPress={() => {
        onOpen(conversation.id);
      }}
      // Hold to reach the destructive action; a tap opens the thread, as it always did.
      onLongPress={() => {
        onLongPress(conversation);
      }}
      delayLongPress={350}
      style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
    >
      <Avatar seed={conversation.peerUid} name={name} size={AVATAR_SIZE} />
      <View style={styles.rowText}>
        <Text style={[styles.name, unread ? styles.nameUnread : null]} numberOfLines={1}>
          {name}
        </Text>
        {conversation.lastMessageAt > 0 ? null : (
          <Text style={styles.subtitle} numberOfLines={1}>
            No messages yet
          </Text>
        )}
      </View>
      <View style={styles.rowMeta}>
        <Text style={[styles.when, unread ? styles.whenUnread : null]}>
          {listTimeLabel(conversation.lastMessageAt, now)}
        </Text>
        {unread ? (
          <Text style={styles.badge} testID={'messages_unread_' + conversation.id}>
            {String(conversation.unread)}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

interface NewConversationSheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly onStarted: (conversationId: string) => void;
}

/**
 * Asking for an address is its own step, so the failures have somewhere to be said.
 *
 * It stays open when the lookup fails: "nobody here uses that address" is almost always a typo,
 * and closing the sheet would throw away the thing that needs correcting.
 */
function NewConversationSheet({
  visible,
  onClose,
  onStarted,
}: NewConversationSheetProps): React.JSX.Element {
  const services = useServices();
  const messaging = services.messaging;
  const styles = useStyles(createStyles);
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = useCallback(() => {
    setEmail('');
    setError(null);
    onClose();
  }, [onClose]);

  const start = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const conversationId = await messaging.startConversation(email);
      setEmail('');
      onStarted(conversationId);
    } catch (caught) {
      setError(describeError(caught));
    } finally {
      setBusy(false);
    }
  }, [email, messaging, onStarted]);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={close}>
      {/* The sheet is docked to the bottom and its only field autoFocuses, so the keyboard opens
          directly over the thing being typed into. The backdrop above it is the flexing child, so
          the padding this adds is surrendered by the backdrop and the sheet rises by exactly the
          keyboard's height. */}
      <KeyboardAvoider testID="messages_sheet_keyboard_avoider" style={styles.avoider}>
        <Pressable style={styles.backdrop} accessibilityLabel="Close" onPress={close} />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + spacing.lg }]}>
          <View style={styles.grabber} />
          <Text style={styles.sheetTitle}>New conversation</Text>
          <TextInput
            testID="messages_email"
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            keyboardType="email-address"
            editable={!busy}
            placeholder="their@email.address"
            placeholderTextColor={theme.textMuted}
            onSubmitEditing={() => {
              if (!busy && looksLikeEmail(email)) void start();
            }}
          />
          <Paragraph>
            They need a SilentSum account with the same address, and must have opened Messages once
            so their key is published.
          </Paragraph>
          {error === null ? null : (
            <Text testID="messages_error" style={styles.error}>
              {error}
            </Text>
          )}
          <Button
            testID="messages_start"
            label="Start conversation"
            onPress={() => {
              void start();
            }}
            busy={busy}
            disabled={busy || !looksLikeEmail(email)}
          />
          <Button testID="messages_cancel" label="Cancel" variant="ghost" onPress={close} />
        </View>
      </KeyboardAvoider>
    </Modal>
  );
}

function createStyles(palette: Palette) {
  return StyleSheet.create({
    body: { flex: 1 },
    notice: {
      backgroundColor: palette.surface,
      borderRadius: radius.md,
      padding: spacing.md,
      gap: spacing.sm,
    },
    banner: {
      backgroundColor: palette.surface,
      borderLeftWidth: 3,
      borderLeftColor: palette.accent,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      marginHorizontal: spacing.md,
      marginTop: spacing.sm,
      borderRadius: radius.sm,
      gap: spacing.sm,
    },
    bannerText: { ...typography.caption, color: palette.textMuted, lineHeight: 18 },

    listContent: { paddingVertical: spacing.sm },
    separator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: palette.border,
      marginLeft: spacing.md + AVATAR_SIZE + spacing.md,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
      minHeight: 72,
    },
    pressed: { opacity: 0.7 },
    rowText: { flex: 1, gap: 2 },
    name: { ...typography.body, color: palette.text },
    nameUnread: { fontWeight: '700' },
    subtitle: { ...typography.caption, color: palette.textMuted },
    rowMeta: { alignItems: 'flex-end', gap: spacing.xs, minWidth: 48 },
    when: { ...typography.caption, color: palette.textMuted },
    whenUnread: { color: palette.accent, fontWeight: '600' },
    badge: {
      ...typography.caption,
      fontWeight: '700',
      color: palette.accentText,
      backgroundColor: palette.accent,
      borderRadius: radius.pill,
      minWidth: 22,
      textAlign: 'center',
      paddingHorizontal: 6,
      paddingVertical: 2,
      overflow: 'hidden',
    },

    empty: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.xl,
      gap: spacing.md,
    },
    emptyTitle: { ...typography.title, color: palette.text, textAlign: 'center' },
    emptyText: {
      ...typography.body,
      color: palette.textMuted,
      textAlign: 'center',
      lineHeight: 22,
    },

    fab: {
      position: 'absolute',
      right: spacing.md,
      bottom: spacing.md,
      width: 56,
      height: 56,
      borderRadius: radius.pill,
      backgroundColor: palette.accent,
      alignItems: 'center',
      justifyContent: 'center',
      elevation: 4,
    },
    fabGlyph: {
      color: palette.accentText,
      fontSize: 30,
      lineHeight: 34,
      fontWeight: '300',
    },

    /** Fills the modal so the backdrop below has somewhere to give height back from. */
    avoider: { flex: 1 },
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)' },
    sheet: {
      backgroundColor: palette.surface,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      padding: spacing.lg,
      gap: spacing.sm,
    },
    grabber: {
      alignSelf: 'center',
      width: 40,
      height: 4,
      borderRadius: radius.pill,
      backgroundColor: palette.border,
      marginBottom: spacing.sm,
    },
    sheetTitle: { ...typography.title, color: palette.text },
    input: {
      ...typography.body,
      color: palette.text,
      backgroundColor: palette.background,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 4,
      minHeight: 48,
    },
    error: { ...typography.body, color: palette.danger, marginTop: spacing.sm },
  });
}
