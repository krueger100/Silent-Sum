/**
 * One photo or video in a thread.
 *
 * Previews are not free here. The thumbnail is a Storage object rather than a Firestore field —
 * which is what lets the 30-day lifecycle rule expire a preview along with the media it previews —
 * so every bubble costs one fetch and one decrypt. The screen caches decrypted previews by
 * `thumbObject`, so scrolling a thread fetches each one once per session; without that cache an
 * inverted FlatList re-fetches on every pass.
 *
 * Four states, and the distinction between the last two is the one that matters:
 *
 *   loading  a placeholder at the bubble's size, so the list does not jump as previews land
 *   ready    the decrypted preview
 *   expired  dimmed, "This photo has expired", and NO preview -- the point of expiring both
 *   failed   the same placeholder with a retry, worded so it is not mistaken for expiry
 *
 * `fetchThumb` returning null means the object is gone and no retry will ever help; a thrown
 * error means the network failed and a retry may. Showing "expired" for a dropped connection
 * would tell someone their photo had been destroyed when it had not.
 */
import React from 'react';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { radius, spacing, typography, useStyles, type Palette } from '@/app/theme';
import { base64Encode } from '@/utils/base64';
import type { Bytes } from '@/utils/bytes';

export type MediaBubbleState =
  | 'loading'
  | 'ready'
  | 'expired'
  | 'failed'
  /** Picked and on its way: the preview is local and the item has no message yet. */
  | 'uploading'
  /** The send failed. The preview is still local, and the source is still held for a retry. */
  | 'retry';

export interface MediaBubbleProps {
  readonly messageId: string;
  readonly kind: 'photo' | 'video' | 'unknown';
  readonly mine: boolean;
  readonly state: MediaBubbleState;
  /** Decrypted JPEG bytes, present only in the `ready` state. */
  readonly preview: Bytes | null;
  readonly onOpen: () => void;
  readonly onRetry: () => void;
  /**
   * Whether tapping this one again could change anything. Defaults to true, so a bubble that is
   * not an outgoing item -- every `failed` incoming preview -- keeps the retry it always had.
   */
  readonly retryable?: boolean;
  readonly onSaveToVault?: () => void;
  /**
   * Opens the message actions sheet, the same one a text bubble opens.
   *
   * It has to be handed to every pressable in here rather than left to the row outside. React
   * Native gives the gesture to the innermost pressable, so a bubble state that takes a tap and
   * does not also take a hold swallows it, and the only way left to delete a photo is to hold the
   * sliver of margin beside it.
   */
  readonly onLongPress?: (() => void) | undefined;
}

function label(kind: MediaBubbleProps['kind']): string {
  return kind === 'video' ? 'video' : 'photo';
}

export function MediaBubble({
  messageId,
  kind,
  mine,
  state,
  preview,
  onOpen,
  onRetry,
  retryable = true,
  onSaveToVault,
  onLongPress,
}: MediaBubbleProps): React.JSX.Element {
  const styles = useStyles(makeStyles);

  if (kind === 'unknown') {
    return (
      <View style={[styles.frame, styles.placeholder]} testID={`conversation_media_unknown_${messageId}`}>
        <Text style={styles.note}>This message needs a newer version of SilentSum.</Text>
      </View>
    );
  }

  if (state === 'expired') {
    return (
      <View
        style={[styles.frame, styles.placeholder]}
        testID={`conversation_media_expired_${messageId}`}
      >
        <Text style={styles.note}>{`This ${label(kind)} has expired.`}</Text>
        <Text style={styles.sub}>Media is kept for 30 days.</Text>
      </View>
    );
  }

  if (state === 'failed') {
    return (
      <Pressable
        style={[styles.frame, styles.placeholder]}
        testID={`conversation_media_failed_${messageId}`}
        accessibilityRole="button"
        onPress={onRetry}
        onLongPress={onLongPress}
      >
        <Text style={styles.note}>{`Could not load this ${label(kind)}.`}</Text>
        <Text style={styles.sub}>Tap to try again.</Text>
      </Pressable>
    );
  }

  if (state === 'loading' || (preview === null && state !== 'uploading' && state !== 'retry')) {
    return (
      <View
        style={[styles.frame, styles.placeholder]}
        testID={`conversation_media_loading_${messageId}`}
      >
        <ActivityIndicator />
      </View>
    );
  }

  // In flight, or failed and waiting to be retried. The preview is local in both cases, so the
  // bubble shows the real thing from the first frame rather than a grey box that later becomes
  // a photo -- which is what makes the thread feel like it responded to the tap.
  if (state === 'uploading' || state === 'retry') {
    const failed = state === 'retry';
    // A failure a retry cannot fix is still shown here -- the preview is local and the user picked
    // it -- but it is not a button. The reason sits beside the bubble, where there is room for it.
    const canRetry = failed && retryable;
    return (
      <Pressable
        testID={`conversation_media_${failed ? 'retry' : 'uploading'}_${messageId}`}
        accessibilityRole={canRetry ? 'button' : 'image'}
        accessibilityLabel={
          failed
            ? canRetry
              ? `Retry sending ${label(kind)}`
              : `${label(kind)} not sent`
            : `Sending ${label(kind)}`
        }
        accessibilityState={{ busy: !failed }}
        disabled={!canRetry}
        onPress={onRetry}
        onLongPress={onLongPress}
        style={styles.frame}
      >
        {preview === null ? (
          <View style={[styles.frame, styles.placeholder]} />
        ) : (
          <Image
            source={{ uri: `data:image/jpeg;base64,${base64Encode(preview)}` }}
            style={[styles.image, styles.sendingImage]}
            resizeMode="cover"
          />
        )}
        <View style={styles.overlay}>
          {failed ? (
            <>
              <Text style={styles.overlayGlyph}>{canRetry ? '↻' : '!'}</Text>
              <Text style={styles.overlayLabel}>{canRetry ? 'Tap to retry' : 'Not sent'}</Text>
            </>
          ) : (
            <>
              <ActivityIndicator color="#FFFFFF" />
              <Text style={styles.overlayLabel}>Sending…</Text>
            </>
          )}
        </View>
      </Pressable>
    );
  }

  return (
    <View>
      <Pressable
        testID={`conversation_media_${messageId}`}
        accessibilityRole="imagebutton"
        accessibilityLabel={`Open ${label(kind)}`}
        onPress={onOpen}
        onLongPress={onLongPress}
        style={({ pressed }) => [styles.frame, pressed ? styles.pressed : null]}
      >
        {preview === null ? (
          // A video whose poster could not be generated: still openable, just not previewable.
          <View style={[styles.frame, styles.placeholder]} />
        ) : (
          <Image
            source={{ uri: `data:image/jpeg;base64,${base64Encode(preview)}` }}
            style={styles.image}
            resizeMode="cover"
          />
        )}
        {kind === 'video' ? (
          <View style={styles.playBadge} testID={`conversation_media_play_${messageId}`}>
            <Text style={styles.playGlyph}>▶</Text>
          </View>
        ) : null}
      </Pressable>
      {onSaveToVault === undefined || mine ? null : (
        <Pressable
          testID={`media_save_to_vault_${messageId}`}
          accessibilityRole="button"
          accessibilityLabel="Save to vault"
          onPress={onSaveToVault}
          onLongPress={onLongPress}
          style={({ pressed }) => [styles.save, pressed ? styles.pressed : null]}
        >
          <Text style={styles.saveLabel}>Save to vault</Text>
        </Pressable>
      )}
    </View>
  );
}

const BUBBLE_SIZE = 220;

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    frame: {
      width: BUBBLE_SIZE,
      height: BUBBLE_SIZE,
      borderRadius: radius.md,
      overflow: 'hidden',
      backgroundColor: colors.surfaceAlt,
    },
    placeholder: {
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.md,
    },
    image: { width: '100%', height: '100%' },
    // Dimmed while in flight so the spinner over it stays legible on a bright photo.
    sendingImage: { opacity: 0.45 },
    overlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: 'center',
      justifyContent: 'center',
      gap: spacing.xs,
    },
    overlayGlyph: { color: '#FFFFFF', fontSize: 26 },
    overlayLabel: { ...typography.caption, color: '#FFFFFF' },
    pressed: { opacity: 0.85 },
    note: { ...typography.body, color: colors.text, textAlign: 'center' },
    sub: { ...typography.caption, color: colors.textMuted, marginTop: spacing.xs, textAlign: 'center' },
    playBadge: {
      position: 'absolute',
      top: '50%',
      left: '50%',
      marginTop: -20,
      marginLeft: -20,
      width: 40,
      height: 40,
      borderRadius: 20,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(0,0,0,0.55)',
    },
    playGlyph: { color: '#FFFFFF', fontSize: 16 },
    save: { paddingVertical: spacing.xs, alignSelf: 'flex-start' },
    saveLabel: { ...typography.caption, color: colors.accent },
  });
