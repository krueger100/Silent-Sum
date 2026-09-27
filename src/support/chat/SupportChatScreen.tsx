/**
 * The support conversation.
 *
 * Deliberately plain: the whole history, a composer, and one Send. Reading is never blocked, so an
 * account whose Cloud term has lapsed can still read what support said and still reach its own
 * vault; only sending a new message needs an active term. Nothing on this screen can reach the
 * vault, the PIN or any key, and the composer refuses text that looks like any of them.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { useServices } from '@/app/ServicesProvider';
import { radius, spacing, typography, useStyles, useTheme, type Palette } from '@/app/theme';
import { Button } from '@/components/Button';
import { Paragraph, Screen, SectionLabel } from '@/components/Screen';
import {
  MAX_MESSAGE_LENGTH,
  describeMessageProblem,
  type SupportMessage as ChatMessage,
} from '@/support/chat/supportChat';
import {
  EMPTY_CHAT_STATE,
  SupportChatError,
  type SupportChatState,
} from '@/support/chat/supportChatService';

export interface SupportChatScreenProps {
  onBack?: () => void;
  /** Opens the plans screen when the Cloud term has lapsed. */
  onPlans?: () => void;
}

function timeLabel(millis: number): string {
  const date = new Date(millis);
  const day = date.toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return day + ' ' + time;
}

function describeSendError(error: unknown): string {
  if (error instanceof SupportChatError) {
    switch (error.code) {
      case 'rejected':
        return error.problem === undefined
          ? 'That message could not be sent.'
          : describeMessageProblem(error.problem);
      case 'cloud-required':
        return 'SilentSum Cloud is needed to send a new message.';
      case 'unauthenticated':
        return 'Sign in to your backup account first.';
      case 'unavailable':
        return 'Support chat is not available in this build.';
    }
  }
  return 'That message could not be sent. Try again.';
}

export function SupportChatScreen({ onBack, onPlans }: SupportChatScreenProps): React.ReactElement {
  const services = useServices();
  const chat = services.supportChat;
  const styles = useStyles(createStyles);
  const theme = useTheme();
  const [state, setState] = useState<SupportChatState>(EMPTY_CHAT_STATE);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const marked = useRef(false);

  useEffect(() => {
    const stop = chat.watch(setState, () => {
      setError('The conversation could not be loaded.');
    });
    return stop;
  }, [chat]);

  // One mark-as-read per visit, once the history has actually arrived.
  useEffect(() => {
    if (!state.loaded || marked.current || state.unread === 0) return;
    marked.current = true;
    void chat.markRead();
  }, [chat, state.loaded, state.unread]);

  const send = useCallback(async () => {
    setError(null);
    setSending(true);
    try {
      await chat.send(draft);
      setDraft('');
    } catch (caught) {
      setError(describeSendError(caught));
    } finally {
      setSending(false);
    }
  }, [chat, draft]);

  const blocked = useMemo(() => {
    if (!chat.available) {
      return (
        <View style={styles.card} testID="support_chat_unavailable">
          <Paragraph>Support chat is not available in this build.</Paragraph>
        </View>
      );
    }
    if (!state.signedIn) {
      return (
        <View style={styles.card} testID="support_chat_signed_out">
          <Paragraph>
            Sign in to your backup account to start a conversation with support.
          </Paragraph>
        </View>
      );
    }
    return null;
  }, [chat.available, state.signedIn, styles.card]);

  const counter = String(draft.trim().length) + ' / ' + String(MAX_MESSAGE_LENGTH);

  return (
    <Screen title="Support chat" onBack={onBack} scroll testID="support_chat_screen">
      {blocked}
      {blocked === null ? (
        <>
          <SectionLabel>Conversation</SectionLabel>
          {state.messages.length === 0 ? (
            <View style={styles.card} testID="support_chat_empty">
              <Paragraph>
                No messages yet. Describe the problem and support will answer here.
              </Paragraph>
            </View>
          ) : (
            <View testID="support_chat_messages">
              {state.messages.map((message: ChatMessage) => (
                <View
                  key={message.id}
                  testID={'support_chat_message_' + message.id}
                  style={[
                    styles.bubble,
                    message.sender === 'user' ? styles.fromUser : styles.fromSupport,
                  ]}
                >
                  <Text style={styles.author}>
                    {message.sender === 'user' ? 'You' : 'SilentSum support'}
                  </Text>
                  <Text style={styles.body}>{message.body}</Text>
                  <Text style={styles.time}>{timeLabel(message.createdAt)}</Text>
                </View>
              ))}
            </View>
          )}

          {state.canSend ? (
            <>
              <SectionLabel>New message</SectionLabel>
              <TextInput
                testID="support_chat_input"
                style={styles.input}
                value={draft}
                onChangeText={setDraft}
                multiline
                maxLength={MAX_MESSAGE_LENGTH}
                editable={!sending}
                placeholder="What went wrong?"
                placeholderTextColor={theme.textMuted}
              />
              <Text style={styles.muted} testID="support_chat_counter">
                {counter}
              </Text>
              <Paragraph>
                Never send your PIN, recovery passphrase or any vault file. Support never asks for
                them.
              </Paragraph>
              <Button
                testID="support_chat_send"
                label="Send"
                onPress={() => {
                  void send();
                }}
                busy={sending}
                disabled={sending || draft.trim() === ''}
              />
            </>
          ) : (
            <View style={styles.card} testID="support_chat_cloud_required">
              <Paragraph>
                SilentSum Cloud is needed to send a new message. Your vault and everything already
                in it are unaffected, and you can still read this conversation.
              </Paragraph>
              {onPlans === undefined ? null : (
                <Button testID="support_chat_plans" label="See plans" onPress={onPlans} />
              )}
            </View>
          )}

          {error === null ? null : (
            <Text testID="support_chat_error" style={styles.error}>
              {error}
            </Text>
          )}
        </>
      ) : null}
    </Screen>
  );
}

function createStyles(palette: Palette) {
  return StyleSheet.create({
    card: {
      backgroundColor: palette.surface,
      borderRadius: radius.md,
      padding: spacing.md,
      gap: spacing.sm,
      marginBottom: spacing.md,
    },
    bubble: {
      borderRadius: radius.md,
      padding: spacing.md,
      marginBottom: spacing.sm,
      gap: spacing.xs,
    },
    fromUser: { backgroundColor: palette.surfaceAlt },
    fromSupport: { backgroundColor: palette.surface },
    author: { ...typography.caption, color: palette.textMuted },
    body: { ...typography.body, color: palette.text },
    time: { ...typography.caption, color: palette.textMuted },
    input: {
      ...typography.body,
      color: palette.text,
      backgroundColor: palette.surface,
      borderRadius: radius.md,
      padding: spacing.md,
      minHeight: 120,
      textAlignVertical: 'top',
    },
    muted: { ...typography.caption, color: palette.textMuted, marginTop: spacing.xs },
    error: { ...typography.body, color: palette.danger, marginTop: spacing.sm },
  });
}
