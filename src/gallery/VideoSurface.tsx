/**
 * The only component in the app that plays a video, and the only one that imports `expo-video`.
 *
 * Every player on the platform takes a URL, so a vault video has to exist as a plaintext file for
 * as long as it is on screen. Two rules keep that bounded, and both live here rather than at the
 * call sites so they cannot be forgotten:
 *
 *  - Picture-in-picture is off, in both forms. A PiP window is drawn by the system *outside* the
 *    app, where `FLAG_SECURE` does not reach and where the vault would keep playing after the user
 *    thought they had left it.
 *  - Nothing offers to share, download or open the file elsewhere. There is no share button, no
 *    external-player hand-off, and the URI is never passed to an intent -- the file is app-private
 *    and stays that way.
 *
 * The player is released when the surface unmounts. The *file* is not this component's to delete:
 * whoever decrypted it owns it (see `@/vault/playbackScratch`).
 */
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useRef } from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';

export interface VideoSurfaceProps {
  /** A `file://` URI in app-private storage. Never a remote URL. */
  uri: string;
  style?: StyleProp<ViewStyle>;
  /** Start playing as soon as the surface is ready. */
  autoPlay?: boolean;
  loop?: boolean;
  testID?: string;
  accessibilityLabel?: string;
}

export function VideoSurface({
  uri,
  style,
  autoPlay = false,
  loop = false,
  testID = 'video-surface',
  accessibilityLabel = 'Video',
}: VideoSurfaceProps): React.JSX.Element {
  const viewRef = useRef<React.ComponentRef<typeof VideoView> | null>(null);

  const player = useVideoPlayer(uri, (instance) => {
    instance.loop = loop;
    // Recordings are silent (the app never opens the microphone), but an imported file might not
    // be, and a vault should not start making noise on its own.
    instance.muted = false;
    if (autoPlay) instance.play();
  });

  return (
    <VideoView
      testID={testID}
      ref={viewRef}
      player={player}
      style={[styles.surface, style]}
      contentFit="contain"
      nativeControls
      // Both halves of picture-in-picture: the system window escapes FLAG_SECURE.
      allowsPictureInPicture={false}
      startsPictureInPictureAutomatically={false}
      accessibilityLabel={accessibilityLabel}
    />
  );
}

const styles = StyleSheet.create({
  surface: { width: '100%', height: '100%', backgroundColor: '#000000' },
});
