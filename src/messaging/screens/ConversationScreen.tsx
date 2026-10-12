/**
 * One conversation: the history, and a composer.
 *
 * Every body on this screen was decrypted here, on this device, moments ago. A message that will
 * not open is shown as such rather than hidden -- a silent gap would be the one failure mode a
 * user could not tell from "they never wrote".
 *
 * The layout is the ordinary one for a chat and it is ordinary on purpose: an inverted list, so
 * the newest message is where the eye already is and the keyboard pushes the thread up rather
 * than away; bubbles that lean the way of whoever sent them; a composer docked at the bottom
 * instead of a form at the end of a page. The one thing that is not ordinary is the notice above
 * the thread, which stays put rather than scrolling off: what it says about the PIN is the
 * sentence this app most needs a user to have read.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { useServices } from '@/app/ServicesProvider';
import { radius, spacing, typography, useStyles, useTheme, type Palette } from '@/app/theme';
import { Button } from '@/components/Button';
import { KeyboardAvoider } from '@/components/keyboardAvoidance';
import { Screen } from '@/components/Screen';
import {
  DELETED_MESSAGE_TEXT,
  MAX_MESSAGE_LENGTH,
  type DecryptedMessage,
} from '@/messaging/messaging';
import { describeSendFailure } from '@/messaging/sendFailure';
import { MessageActionsSheet } from '@/messaging/screens/MessageActionsSheet';
import {
  MessagingError,
  describeMessagingError,
  describeSendBlock,
  type ConversationState,
  type MediaSource,
} from '@/messaging/messagingService';
import { Avatar } from '@/messaging/screens/Avatar';
import { AttachSheet, type AttachSource } from '@/messaging/screens/AttachSheet';
import { MediaBubble } from '@/messaging/screens/MediaBubble';
import { MediaViewer, type ViewerItem } from '@/messaging/screens/MediaViewer';
import { RecoverMessagingPanel } from '@/messaging/screens/RecoverMessagingPanel';
import { VaultPickerSheet } from '@/messaging/screens/VaultPickerSheet';
import { VaultSendNotice } from '@/messaging/vaultSendNotice';
import { CameraSheet, type CameraCapture } from '@/camera/CameraSheet';
import { openRepository } from '@/gallery/vaultAccess';
import { isVideo } from '@/vault/mediaKind';
import type { PhotoEntry } from '@/vault/types';
import * as ImagePicker from 'expo-image-picker';
import { useChatMedia, type ChatMedia } from '@/messaging/screens/useChatMedia';
import { useOutgoingMedia } from '@/messaging/screens/useOutgoingMedia';
import { buildChatItems, type ChatItem, type MessageItem } from '@/messaging/screens/chatItems';
import { clockLabel, daySeparatorLabel } from '@/messaging/screens/chatTime';

/** The counter is noise until it is nearly news. */
const COUNTER_FROM = MAX_MESSAGE_LENGTH - 200;

export interface ConversationScreenProps {
  readonly conversationId: string;
  onBack?: () => void;
  onPlans?: () => void;
}

function describeSendError(error: unknown): string {
  return describeSendFailure(error).message;
}

/** Its own describer: the send fallback says "could not be sent", which is untrue of a deletion. */
function describeDeleteError(error: unknown): string {
  if (error instanceof MessagingError) return describeMessagingError(error.code);
  return 'That message could not be deleted. Try again.';
}

export function ConversationScreen({
  conversationId,
  onBack,
  onPlans,
}: ConversationScreenProps): React.ReactElement {
  const services = useServices();
  const messaging = services.messaging;
  const styles = useStyles(createStyles);
  const theme = useTheme();
  const [state, setState] = useState<ConversationState | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const marked = useRef(false);

  // Recovering the account's identity writes nothing to the server, so no snapshot arrives to
  // re-emit this thread. `MessagingService` notifies its open watchers instead -- re-deriving
  // this conversation's keys and emitting again -- which is why there is no counter here and no
  // re-subscribe. One mechanism, and it serves the conversation LIST equally, which a counter
  // living in this file never could.
  useEffect(() => {
    const stop = messaging.watchConversation(conversationId, setState);
    return stop;
  }, [conversationId, messaging]);

  // One mark-as-read per visit, once the history has arrived.
  useEffect(() => {
    if (state === null || !state.loaded || marked.current) return;
    marked.current = true;
    void messaging.markRead(conversationId);
  }, [conversationId, messaging, state]);

  const send = useCallback(async () => {
    setError(null);
    setSending(true);
    try {
      await messaging.send(conversationId, draft);
      setDraft('');
    } catch (caught) {
      setError(describeSendError(caught));
    } finally {
      setSending(false);
    }
  }, [conversationId, draft, messaging]);

  const media = useChatMedia(conversationId, state?.messages ?? []);
  const [attaching, setAttaching] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [pickingVault, setPickingVault] = useState(false);
  const [noticeSeen, setNoticeSeen] = useState(false);
  const [viewing, setViewing] = useState<ViewerItem | null>(null);
  /** The message whose action sheet is open, or null. */
  const [actionsFor, setActionsFor] = useState<DecryptedMessage | null>(null);
  /** The scratch file behind an open video, so closing can release it. */
  const viewerScratch = useRef<string | null>(null);
  const notice = useMemo(() => new VaultSendNotice(services.secureStore), [services]);

  useEffect(() => {
    let cancelled = false;
    void notice.hasSeen(conversationId).then((seen) => {
      if (!cancelled) setNoticeSeen(seen);
    });
    return () => {
      cancelled = true;
    };
  }, [conversationId, notice]);

  /**
   * The three sources converge here: each one's only job is to produce a local file and a kind.
   *
   * The photo library is opened with video allowed, which differs from the vault's own import
   * picker -- that one stays images-only. The difference is deliberate and lives at the call
   * site: it is a decision about what the vault accepts, not about what a message may carry.
   */
  /**
   * Hands one item to the service, with auto-lock suspended for the whole round trip.
   *
   * It deliberately does NOT set the banner error or the `sending` flag: the outgoing tray owns
   * both now. A failure there leaves a bubble the user can retry, which is more useful than a
   * line of red text above a thread that looks like nothing happened.
   */
  const deliverMedia = useCallback(
    async (source: MediaSource): Promise<void> => {
      const suspension = services.autoLockSuspension;
      suspension.suspend();
      try {
        await messaging.sendMedia(conversationId, source);
      } finally {
        suspension.resume();
      }
    },
    [conversationId, messaging, services],
  );

  const outgoing = useOutgoingMedia(deliverMedia);

  const sendMedia = useCallback(
    async (source: MediaSource): Promise<void> => {
      setError(null);
      await outgoing.send(source);
    },
    [outgoing],
  );

  const onAttach = useCallback(
    async (source: AttachSource): Promise<void> => {
      if (source === 'vault') {
        setPickingVault(true);
        return;
      }
      if (source === 'camera') {
        setCapturing(true);
        return;
      }
      const suspension = services.autoLockSuspension;
      suspension.suspend();
      try {
        const launch = services.launchImageLibrary ?? ImagePicker.launchImageLibraryAsync;
        const picked = await launch({
          mediaTypes: ['images', 'videos'],
          selectionLimit: 1,
          quality: 1,
        });
        if (picked.canceled) return;
        const asset = picked.assets[0];
        if (asset === undefined) return;
        await sendMedia({
          uri: asset.uri,
          kind: asset.type === 'video' ? 'video' : 'photo',
        });
      } catch {
        setError('That could not be attached.');
      } finally {
        suspension.resume();
      }
    },
    [sendMedia, services],
  );

  /**
   * A capture from the in-chat camera, handed to the same tray the picker and the vault feed.
   * Nothing about the send differs by source past this line: one `MediaSource`, one `sendMedia`,
   * one cipher, one upload, one message.
   *
   * What does differ is who owns the plaintext, and for a video that matters. The recording is a
   * plaintext file in the cache, and the duty to delete it arrives with the URI: it is overwritten
   * and unlinked once the attempt settles, whether the attempt succeeded or failed. That is the
   * same bargain a vault video's scratch file makes here, and it has the same consequence -- a
   * retry after the file has gone reports "choose it again" instead of re-reading nothing -- and
   * it is the right way round: a send that can be retried for ever is not worth a plaintext
   * recording left on the disk for ever.
   *
   * A photo needs none of that. `expo-camera`'s own temp JPEG was securely deleted inside the
   * capture, so the bytes are all there is, and the tray holds them for a retry exactly as it
   * holds a vault photo's. The pseudo-URI names the source the way `vault://` does; nothing
   * dereferences it, because the bytes are already in hand.
   */
  const sendCapture = useCallback(
    (capture: CameraCapture): void => {
      // Suspended across the whole send, as the picker and the vault are: an upload easily outlasts
      // the idle timeout, and a lock mid-upload would unmount this screen and lose it. The
      // suspension is a counter, so nesting inside `deliverMedia`'s own is harmless.
      const suspension = services.autoLockSuspension;
      suspension.suspend();
      void (async () => {
        try {
          if (capture.kind === 'photo') {
            await sendMedia({ uri: 'camera://photo', kind: 'photo', bytes: capture.bytes });
            return;
          }
          try {
            await sendMedia({ uri: capture.uri, kind: 'video' });
          } finally {
            await services.secureDelete.file(capture.uri);
          }
        } finally {
          suspension.resume();
        }
      })();
    },
    [sendMedia, services],
  );

  /**
   * Sending anything hands the user to a picker or the camera, and then to an upload that can
   * easily outlast the idle timeout -- so auto-lock is suspended across the whole sequence, not
   * just the picker. Locking mid-upload would unmount this screen and lose the send.
   */
  /**
   * A vault item, decrypted under the master key and re-sealed under the conversation key.
   *
   * The preview is regenerated at the chat size rather than reused: the vault's own thumbnails
   * are 512px and over the 32 KB the Storage rules allow, so reusing one would pass every local
   * check and be refused on the device. `sendMedia` does that regeneration; this only has to
   * hand it the plaintext.
   */
  const sendVaultItem = useCallback(
    async (entry: PhotoEntry): Promise<void> => {
      const repository = openRepository(services);
      if (repository === null) {
        setError('The vault is locked.');
        return;
      }
      const suspension = services.autoLockSuspension;
      suspension.suspend();
      try {
        if (isVideo(entry)) {
          const scratch = await services.playbackScratch.allocate('mp4');
          try {
            await repository.readVideoToFile(entry.id, scratch);
            await sendMedia({ uri: scratch, kind: 'video' });
          } finally {
            await services.playbackScratch.release(scratch);
          }
          return;
        }
        const bytes = await repository.readFullImage(entry.id);
        await sendMedia({ uri: `vault://${entry.id}`, kind: 'photo', bytes });
      } catch (caught) {
        setError(describeSendError(caught));
      } finally {
        suspension.resume();
      }
    },
    [sendMedia, services],
  );

  /**
   * Opens one item full screen.
   *
   * A photo is fetched as bytes and never written to disk; a video needs a file a player can
   * seek, so it goes through `PlaybackScratch` and that file is released when the viewer closes.
   * The viewer opens immediately in its `loading` state rather than after the fetch, so a tap on
   * a 100 MB video does not look like it did nothing.
   */
  const openMedia = useCallback(
    (message: DecryptedMessage) => {
      setError(null);
      setViewing({ kind: 'loading' });
      void (async () => {
        try {
          if (message.kind === 'video') {
            const uri = await messaging.fetchMedia(conversationId, message, (state) => {
              // Only while it is still the thing being waited on: a progress event that arrives
              // after the viewer was closed, or after it failed, must not put the spinner back.
              setViewing((current) =>
                current !== null && current.kind === 'loading' ? { kind: 'loading', ...state } : current,
              );
            });
            viewerScratch.current = uri;
            setViewing({ kind: 'video', uri });
            return;
          }
          const bytes = await messaging.fetchMediaBytes(conversationId, message, (state) => {
            setViewing((current) =>
              current !== null && current.kind === 'loading' ? { kind: 'loading', ...state } : current,
            );
          });
          setViewing({ kind: 'photo', bytes });
        } catch (caught) {
          // Shown inside the viewer rather than as a banner behind it: the user is looking at
          // the black screen they just opened, and expiry is the commonest reason to land here.
          // Expiry gets its own state so it never reads as something a retry would fix.
          const expired = caught instanceof MessagingError && caught.code === 'expired';
          setViewing({
            kind: expired ? 'expired' : 'failed',
            message: describeSendError(caught),
          });
        }
      })();
    },
    [conversationId, messaging],
  );

  const closeViewer = useCallback(() => {
    setViewing(null);
    const uri = viewerScratch.current;
    viewerScratch.current = null;
    if (uri === null) return;
    // A decrypted video must not outlive the viewer that showed it. `PlaybackScratch` also purges
    // on background, so a crash here costs one file until the app next goes away.
    void services.playbackScratch.release(uri);
  }, [services]);

  const saveToVault = useCallback(
    (message: DecryptedMessage) => {
      void (async () => {
        setError(null);
        const repository = openRepository(services);
        if (repository === null) {
          setError('The vault is locked.');
          return;
        }
        try {
          await messaging.saveToVault(conversationId, message, repository);
          setError(null);
        } catch (caught) {
          setError(describeSendError(caught));
        }
      })();
    },
    [conversationId, messaging, services],
  );

  // Newest first, because the list is inverted. The builder works in reading order; this is the
  // only place that order is turned around.
  const items = useMemo(() => buildChatItems(state?.messages ?? []).reverse(), [state?.messages]);

  const title = state?.label ?? 'Conversation';
  const now = services.clock.now();
  const trimmed = draft.trim();
  // Two guards, deliberately not one flag.
  //
  // A text send already in flight is a genuine double-submit risk, so the composer waits for it.
  // An attachment uploading is not: a text message is its own document under its own random id,
  // so it cannot collide with an upload or be reordered by one. Folding both into a single `busy`
  // held the keyboard shut for as long as a video took to go out -- a minute of an app that looks
  // broken, and the complaint this answers.
  //
  // The ordering rule the single flag was protecting is narrower than where it was applied.
  // `useOutgoingMedia` states it as two ATTACHMENTS racing: "two photos racing to the same
  // conversation would arrive in whichever order the network settled on". That is still enforced,
  // by the attach button below, which stays shut while an upload is in flight.
  const uploading = outgoing.busy;
  const canSubmit = !sending && trimmed !== '';

  return (
    <Screen
      title={title}
      onBack={onBack}
      testID="conversation_screen"
      actions={
        state === null ? null : <Avatar seed={state.peerUid} name={title} size={32} />
      }
    >
      <KeyboardAvoider testID="conversation_keyboard_avoider" style={styles.flex}>
        {state === null || state.problem === null ? null : (
          <View style={styles.banner} testID="conversation_problem">
            <Text style={styles.bannerText}>{describeMessagingError(state.problem)}</Text>
            {state.problem === 'pro-required' && onPlans !== undefined ? (
              <Button
                testID="conversation_plans"
                label="See plans"
                variant="secondary"
                onPress={onPlans}
              />
            ) : null}
          </View>
        )}

        <Text style={styles.chip}>
          Messages are encrypted on this device. Never send your PIN or recovery passphrase, to
          anyone.
        </Text>

        {items.length === 0 ? (
          <View style={styles.empty} testID="conversation_empty">
            <Text style={styles.emptyTitle}>No messages yet</Text>
            <Text style={styles.emptyText}>
              Anything you send here is sealed before it leaves this device.
            </Text>
          </View>
        ) : (
          <FlatList
            testID="conversation_messages"
            data={items}
            inverted
            keyExtractor={(item) => item.key}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.listContent}
            renderItem={({ item }) => (
              <ChatRow
                item={item}
                now={now}
                peerName={state?.label ?? null}
                media={media}
                onOpenMedia={openMedia}
                onSaveToVault={saveToVault}
                onLongPress={setActionsFor}
              />
            )}
          />
        )}

        {/*
          Items on their way out, shown below the thread -- which is where the newest message
          appears, the list being inverted. They sit outside the list rather than inside it
          because they are not messages yet: they have no id the server knows and no place in
          the day grouping the list builds.
        */}
        {outgoing.items.length === 0 ? null : (
          <View style={styles.outgoing} testID="conversation_outgoing">
            {outgoing.items.map((item) => (
              <View key={item.id} style={styles.outgoingItem}>
                <MediaBubble
                  messageId={item.id}
                  kind={item.kind}
                  mine
                  state={item.failed ? 'retry' : 'uploading'}
                  preview={item.preview}
                  retryable={item.retryable}
                  onOpen={() => undefined}
                  onRetry={() => {
                    void outgoing.retry(item.id);
                  }}
                />
                {item.failed ? (
                  <>
                    {/*
                      Why it failed, in the one place with room for a sentence. Without this the
                      bubble said "Tap to retry" whatever the cause, so a send the server will
                      never accept looked exactly like a dropped connection.
                    */}
                    {item.problem === null ? null : (
                      <Text
                        testID={`conversation_outgoing_problem_${item.id}`}
                        style={styles.outgoingProblem}
                      >
                        {item.problem}
                      </Text>
                    )}
                    <Pressable
                      testID={`conversation_outgoing_discard_${item.id}`}
                      accessibilityRole="button"
                      accessibilityLabel="Discard"
                      onPress={() => {
                        outgoing.dismiss(item.id);
                      }}
                    >
                      <Text style={styles.discard}>Discard</Text>
                    </Pressable>
                  </>
                ) : null}
              </View>
            ))}
          </View>
        )}

        {error === null ? null : (
          <Text testID="conversation_error" style={styles.error}>
            {error}
          </Text>
        )}

        {state?.canSend === true ? (
          <View style={styles.composer}>
            {draft.length < COUNTER_FROM ? null : (
              <Text style={styles.counter} testID="conversation_counter">
                {String(trimmed.length) + ' / ' + String(MAX_MESSAGE_LENGTH)}
              </Text>
            )}
            <View style={styles.composerRow}>
              {/*
                Rendered under the same condition as the composer itself, so Pro gating needs no
                new logic: if you can type here, you can attach here.
              */}
              <Pressable
                testID="conversation_attach"
                accessibilityRole="button"
                accessibilityLabel="Attach"
                disabled={uploading}
                accessibilityState={{ disabled: uploading, busy: uploading }}
                onPress={() => {
                  setAttaching(true);
                }}
                style={({ pressed }) => [
                  styles.attach,
                  uploading ? styles.attachDisabled : null,
                  pressed && !uploading ? styles.pressed : null,
                ]}
              >
                <Text style={styles.attachGlyph}>+</Text>
              </Pressable>
              <TextInput
                testID="conversation_input"
                style={styles.input}
                value={draft}
                onChangeText={setDraft}
                multiline
                maxLength={MAX_MESSAGE_LENGTH}
                editable={!sending}
                placeholder="Message"
                placeholderTextColor={theme.textMuted}
              />
              <Pressable
                testID="conversation_send"
                accessibilityRole="button"
                accessibilityLabel="Send"
                accessibilityState={{ disabled: !canSubmit, busy: sending }}
                disabled={!canSubmit}
                onPress={() => {
                  void send();
                }}
                style={({ pressed }) => [
                  styles.send,
                  canSubmit ? null : styles.sendDisabled,
                  pressed && canSubmit ? styles.pressed : null,
                ]}
              >
                <Text style={styles.sendGlyph}>↑</Text>
              </Pressable>
            </View>
          </View>
        ) : state === null ||
          state.sendBlocked === null ||
          state.sendBlocked === 'preparing' ? null : (
          /*
           * Why, specifically. The old copy named Pro and the lock whatever the cause, which sent
           * people to the plans screen over a problem a purchase could not fix.
           */
          <View style={styles.cannotSend} testID="conversation_cannot_send">
            <Text style={styles.bannerText}>{describeSendBlock(state.sendBlocked)}</Text>
            {state.sendBlocked === 'pro-required' && onPlans !== undefined ? (
              <Button
                testID="conversation_cannot_send_plans"
                label="See plans"
                variant="secondary"
                onPress={onPlans}
              />
            ) : null}
            {state.sendBlocked === 'foreign-vault' ? (
              <RecoverMessagingPanel
                onRecovered={() => {
                  // The service re-derives this thread's keys and re-emits on its own now, so
                  // this only has to let the read marker run again against messages that have
                  // become readable.
                  marked.current = false;
                }}
              />
            ) : null}
          </View>
        )}
      </KeyboardAvoider>
      <MediaViewer item={viewing} onClose={closeViewer} />
      {/* The capture callback is what makes this the CHAT camera rather than the vault one. */}
      <CameraSheet
        visible={capturing}
        onClose={() => {
          setCapturing(false);
        }}
        onCapture={sendCapture}
      />
      <VaultPickerSheet
        visible={pickingVault}
        noticeSeen={noticeSeen}
        onCancel={() => {
          // Cancelling remembers nothing, so a mis-tap never silently disables the explanation.
          setPickingVault(false);
        }}
        onSend={(entry) => {
          setPickingVault(false);
          void (async () => {
            await notice.markSeen(conversationId);
            setNoticeSeen(true);
            await sendVaultItem(entry);
          })();
        }}
      />
      <AttachSheet
        visible={attaching}
        onClose={() => {
          setAttaching(false);
        }}
        onPick={(source) => {
          setAttaching(false);
          void onAttach(source);
        }}
      />
      <MessageActionsSheet
        visible={actionsFor !== null}
        // Your own message, and only while it still has something in it. The server checks both
        // again; this only decides whether the row is worth offering.
        canDeleteForEveryone={actionsFor !== null && actionsFor.mine && !actionsFor.deleted}
        onClose={() => {
          setActionsFor(null);
        }}
        onDeleteForMe={() => {
          const target = actionsFor;
          setActionsFor(null);
          if (target === null) return;
          void (async () => {
            try {
              await messaging.deleteForMe(conversationId, target.id);
            } catch (caught) {
              setError(describeDeleteError(caught));
            }
          })();
        }}
        onDeleteForEveryone={() => {
          const target = actionsFor;
          setActionsFor(null);
          if (target === null) return;
          void (async () => {
            try {
              await messaging.deleteForEveryone(conversationId, target);
            } catch (caught) {
              setError(describeDeleteError(caught));
            }
          })();
        }}
      />
    </Screen>
  );
}

interface ChatRowProps {
  readonly item: ChatItem;
  readonly now: number;
  readonly peerName: string | null;
  readonly media: ChatMedia;
  readonly onOpenMedia: (message: DecryptedMessage) => void;
  readonly onSaveToVault: (message: DecryptedMessage) => void;
  readonly onLongPress: (message: DecryptedMessage) => void;
}

function ChatRow({
  item,
  now,
  peerName,
  media,
  onOpenMedia,
  onSaveToVault,
  onLongPress,
}: ChatRowProps): React.JSX.Element {
  const styles = useStyles(createStyles);
  if (item.kind === 'day') {
    return (
      <View style={styles.dayRow}>
        <Text style={styles.day}>{daySeparatorLabel(item.at, now)}</Text>
      </View>
    );
  }
  return (
    <Bubble
      item={item}
      peerName={peerName}
      media={media}
      onOpenMedia={onOpenMedia}
      onSaveToVault={onSaveToVault}
      onLongPress={onLongPress}
    />
  );
}

function Bubble({
  item,
  peerName,
  media,
  onOpenMedia,
  onSaveToVault,
  onLongPress,
}: {
  readonly item: MessageItem;
  readonly peerName: string | null;
  readonly media: ChatMedia;
  readonly onOpenMedia: (message: DecryptedMessage) => void;
  readonly onSaveToVault: (message: DecryptedMessage) => void;
  readonly onLongPress: (message: DecryptedMessage) => void;
}): React.JSX.Element {
  const styles = useStyles(createStyles);
  const { message, firstOfGroup, lastOfGroup } = item;
  const mine = message.mine;

  // Media gets its own frame rather than a text bubble: it is sized by the image, not by the
  // words, and the group tails that make a run of texts read as one are wrong for a photo.
  if (message.kind !== null) {
    return (
      <Pressable
        testID={'conversation_message_' + message.id}
        accessibilityLabel={`${mine ? 'You' : (peerName ?? 'Them')}: ${
          message.kind === 'video' ? 'video' : 'photo'
        }`}
        onLongPress={() => {
          onLongPress(message);
        }}
        delayLongPress={350}
        style={[styles.mediaRow, mine ? styles.mediaMine : styles.mediaTheirs]}
      >
        <MediaBubble
          messageId={message.id}
          kind={message.kind}
          mine={mine}
          state={media.stateFor(message)}
          preview={media.previewFor(message)}
          onOpen={() => {
            onOpenMedia(message);
          }}
          onRetry={() => {
            media.retry(message);
          }}
          onSaveToVault={() => {
            onSaveToVault(message);
          }}
          // The row around this is a Pressable with the same handler, but React Native hands the
          // gesture to the innermost pressable -- so without this, holding the picture does
          // nothing and only the margin beside it opens the sheet.
          onLongPress={() => {
            onLongPress(message);
          }}
        />
        <Text style={[styles.time, mine ? styles.mineTime : null]}>
          {clockLabel(message.createdAt)}
        </Text>
      </Pressable>
    );
  }

  return (
    <Pressable
      testID={'conversation_message_' + message.id}
      accessibilityLabel={
        (mine ? 'You' : (peerName ?? 'Them')) +
        ': ' +
        (message.deleted ? DELETED_MESSAGE_TEXT : (message.body ?? 'Could not be opened'))
      }
      // Hold, not tap: a bubble has no tap action, and a tap that opened a destructive menu would
      // be reachable by a mis-scroll.
      onLongPress={() => {
        onLongPress(message);
      }}
      delayLongPress={350}
      style={[
        styles.bubble,
        mine ? styles.mine : styles.theirs,
        firstOfGroup ? styles.groupStart : styles.groupRun,
        lastOfGroup ? (mine ? styles.mineTail : styles.theirsTail) : null,
      ]}
    >
      {message.deleted ? (
        // Distinct from "could not be opened": that one means this device lacks the key and the
        // message still exists, this one means there is nothing left anywhere to read.
        <Text
          style={[styles.deleted, mine ? styles.mineText : null]}
          testID={'conversation_deleted_' + message.id}
        >
          {DELETED_MESSAGE_TEXT}
        </Text>
      ) : message.body === null ? (
        <Text
          style={[styles.unreadable, mine ? styles.mineText : null]}
          testID={'conversation_sealed_' + message.id}
        >
          This message could not be opened on this device.
        </Text>
      ) : (
        <Text style={[styles.body, mine ? styles.mineText : null]}>{message.body}</Text>
      )}
      {lastOfGroup ? (
        <Text style={[styles.time, mine ? styles.mineTime : null]}>
          {clockLabel(message.createdAt)}
        </Text>
      ) : null}
    </Pressable>
  );
}

function createStyles(palette: Palette) {
  return StyleSheet.create({
    attach: {
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: palette.surfaceAlt,
      marginRight: 8,
    },
    attachGlyph: { color: palette.text, fontSize: 22, lineHeight: 24 },
    attachDisabled: { opacity: 0.4 },
    outgoing: {
      paddingHorizontal: 16,
      paddingBottom: 8,
      alignItems: 'flex-end',
      gap: 4,
    },
    outgoingItem: { alignItems: 'flex-end', gap: 2 },
    // Capped at the bubble's own width so a sentence wraps above the Discard row rather than
    // stretching the tray across the thread.
    outgoingProblem: { fontSize: 12, color: palette.textMuted, maxWidth: 220, textAlign: 'right' },
    discard: { fontSize: 12, fontWeight: '400', color: palette.textMuted },
    // Media sits in its own row rather than a text bubble: it is sized by the image, and the
    // group tails that make a run of texts read as one are wrong for a photo.
    mediaRow: { marginHorizontal: 16, marginVertical: 4, maxWidth: '80%' },
    mediaMine: { alignSelf: 'flex-end', alignItems: 'flex-end' },
    mediaTheirs: { alignSelf: 'flex-start', alignItems: 'flex-start' },
    flex: { flex: 1 },

    banner: {
      backgroundColor: palette.surface,
      borderLeftWidth: 3,
      borderLeftColor: palette.accent,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      marginHorizontal: spacing.md,
      marginBottom: spacing.sm,
      borderRadius: radius.sm,
      gap: spacing.sm,
    },
    bannerText: { ...typography.caption, color: palette.textMuted, lineHeight: 18 },
    chip: {
      ...typography.caption,
      color: palette.textMuted,
      textAlign: 'center',
      lineHeight: 17,
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.sm,
    },

    listContent: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
    dayRow: { alignItems: 'center', marginVertical: spacing.md },
    day: {
      ...typography.caption,
      color: palette.textMuted,
      backgroundColor: palette.surface,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      overflow: 'hidden',
    },

    bubble: {
      maxWidth: '80%',
      borderRadius: 18,
      paddingHorizontal: spacing.md - 2,
      paddingVertical: spacing.sm + 1,
    },
    groupStart: { marginTop: spacing.sm + 2 },
    groupRun: { marginTop: 2 },
    mine: { alignSelf: 'flex-end', backgroundColor: palette.accent },
    theirs: { alignSelf: 'flex-start', backgroundColor: palette.surface },
    mineTail: { borderBottomRightRadius: 5 },
    theirsTail: { borderBottomLeftRadius: 5 },
    body: { ...typography.body, color: palette.text, lineHeight: 21 },
    mineText: { color: palette.accentText },
    unreadable: {
      ...typography.body,
      color: palette.textMuted,
      fontStyle: 'italic',
      lineHeight: 21,
    },
    /** Same italic muted treatment as an unopenable message: both say "there is nothing here". */
    deleted: {
      ...typography.body,
      color: palette.textMuted,
      fontStyle: 'italic',
      lineHeight: 21,
    },
    time: {
      ...typography.caption,
      fontSize: 11,
      color: palette.textMuted,
      alignSelf: 'flex-end',
      marginTop: 2,
    },
    // Not `textMuted`: on the accent fill a grey is unreadable, so it is the bubble's own text
    // colour, held back with opacity instead.
    mineTime: { color: palette.accentText, opacity: 0.75 },

    empty: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.xl,
      gap: spacing.sm,
    },
    emptyTitle: { ...typography.title, color: palette.text, textAlign: 'center' },
    emptyText: {
      ...typography.body,
      color: palette.textMuted,
      textAlign: 'center',
      lineHeight: 22,
    },

    composer: {
      paddingHorizontal: spacing.sm + 2,
      paddingTop: spacing.sm,
      paddingBottom: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
    },
    composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm },
    input: {
      ...typography.body,
      flex: 1,
      color: palette.text,
      backgroundColor: palette.surface,
      borderRadius: radius.lg,
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm + 2,
      paddingBottom: spacing.sm + 2,
      minHeight: 44,
      maxHeight: 132,
    },
    send: {
      width: 44,
      height: 44,
      borderRadius: radius.pill,
      backgroundColor: palette.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    sendDisabled: { opacity: 0.4 },
    pressed: { opacity: 0.8 },
    sendGlyph: {
      color: palette.accentText,
      fontSize: 22,
      lineHeight: 26,
      fontWeight: '700',
    },
    counter: {
      ...typography.caption,
      color: palette.textMuted,
      textAlign: 'right',
      paddingRight: spacing.sm,
      paddingBottom: spacing.xs,
    },

    cannotSend: {
      backgroundColor: palette.surface,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      gap: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: palette.border,
    },
    error: {
      ...typography.caption,
      color: palette.danger,
      paddingHorizontal: spacing.md,
      paddingBottom: spacing.sm,
    },
  });
}
