/**
 * One chat photo or video, full screen.
 *
 * Not `PhotoViewerScreen`: that one pages through the vault's own list by entry id, and a chat
 * item is not a vault entry. It is the same treatment though — `expo-image` with
 * `contentFit="contain"`, and `VideoSurface` for video, which is the component the vault already
 * plays through.
 *
 * The two kinds are handled differently on purpose:
 *
 *  - A **photo** arrives as bytes and is shown from a `data:` URI. Plaintext images never touch
 *    disk, which is the rule the vault's viewer keeps and a chat photo is no less sensitive.
 *  - A **video** needs a file a player can seek, so it comes from `PlaybackScratch`. The caller
 *    releases that file when this closes; the scratch directory is purged on background anyway,
 *    so a crash cannot leave one behind for long.
 */
import { Image } from 'expo-image';
import React from 'react';
import { ActivityIndicator, Modal, Pressable, StyleSheet, Text, View } from 'react-native';

import { spacing, typography, useStyles, type Palette } from '@/app/theme';
import { VideoSurface } from '@/gallery/VideoSurface';
import { base64Encode } from '@/utils/base64';
import type { Bytes } from '@/utils/bytes';

/** What the screen is currently showing, or trying to. */
export type ViewerItem =
  | { readonly kind: 'photo'; readonly bytes: Bytes }
  | { readonly kind: 'video'; readonly uri: string }
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed'; readonly message: string }
  /** Gone for good, after 30 days. Kept apart from 'failed' so it never offers a retry. */
  | { readonly kind: 'expired'; readonly message: string };

export interface MediaViewerProps {
  item: ViewerItem | null;
  onClose: () => void;
}

export function MediaViewer({ item, onClose }: MediaViewerProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  return (
    <Modal
      visible={item !== null}
      animationType="fade"
      onRequestClose={onClose}
      // The vault is full-screen black behind media too; a translucent sheet would show the
      // thread underneath, which is not what "open this photo" means.
      statusBarTranslucent
    >
      <View style={styles.screen} testID="media_viewer">
        <Pressable
          testID="media_viewer_close"
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={onClose}
          style={styles.close}
        >
          <Text style={styles.closeGlyph}>✕</Text>
        </Pressable>
        <Body item={item} styles={styles} />
      </View>
    </Modal>
  );
}

function Body({
  item,
  styles,
}: {
  item: ViewerItem | null;
  styles: ReturnType<typeof makeStyles>;
}): React.JSX.Element | null {
  if (item === null) return null;
  if (item.kind === 'loading') {
    return <ActivityIndicator testID="media_viewer_loading" color="#FFFFFF" />;
  }
  if (item.kind === 'expired') {
    return (
      <View style={styles.centred} testID="media_viewer_expired">
        <Text style={styles.glyph}>⧖</Text>
        <Text style={styles.message}>{item.message}</Text>
      </View>
    );
  }
  if (item.kind === 'failed') {
    return (
      <View style={styles.centred} testID="media_viewer_failed">
        <Text style={styles.message}>{item.message}</Text>
      </View>
    );
  }
  if (item.kind === 'video') {
    return (
      <VideoSurface
        uri={item.uri}
        style={styles.media}
        autoPlay
        testID="media_viewer_video"
        accessibilityLabel="Video"
      />
    );
  }
  return (
    <Image
      testID="media_viewer_image"
      source={{ uri: `data:image/jpeg;base64,${base64Encode(item.bytes)}` }}
      style={styles.media}
      contentFit="contain"
      cachePolicy="memory"
      transition={0}
      accessibilityLabel="Photo"
    />
  );
}

const makeStyles = (_colors: Palette) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: '#000000',
      alignItems: 'center',
      justifyContent: 'center',
    },
    media: { width: '100%', height: '100%' },
    close: {
      position: 'absolute',
      top: spacing.xl,
      right: spacing.md,
      zIndex: 1,
      padding: spacing.sm,
    },
    closeGlyph: { color: '#FFFFFF', fontSize: 22 },
    centred: { alignItems: 'center', gap: spacing.sm },
    glyph: { color: '#FFFFFF', fontSize: 40, opacity: 0.7 },
    message: { ...typography.body, color: '#FFFFFF', padding: spacing.lg, textAlign: 'center' },
  });
