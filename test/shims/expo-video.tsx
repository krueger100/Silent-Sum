/**
 * Jest replacement for `expo-video`.
 *
 * The real module reaches into its native view on import (`VideoPlayer` extends a class the native
 * module supplies), so merely importing it fails under Jest -- which would mean no screen that can
 * play a video could be rendered in a test at all.
 *
 * The stand-in renders a plain `View` carrying the same testID and the URI it was handed, which is
 * exactly what the specs assert on: that a video page points the player at the decrypted scratch
 * file and at nothing else. Playback itself is a platform concern and is verified on a device.
 */
import React from 'react';
import { View, type ViewProps } from 'react-native';

export interface FakeVideoPlayer {
  loop: boolean;
  muted: boolean;
  playing: boolean;
  source: unknown;
  play(): void;
  pause(): void;
  release(): void;
}

export function useVideoPlayer(
  source: unknown,
  setup?: (player: FakeVideoPlayer) => void,
): FakeVideoPlayer {
  const player = React.useMemo<FakeVideoPlayer>(() => {
    const instance: FakeVideoPlayer = {
      loop: false,
      muted: false,
      playing: false,
      source,
      play() {
        instance.playing = true;
      },
      pause() {
        instance.playing = false;
      },
      release() {
        instance.playing = false;
      },
    };
    return instance;
  }, [source]);

  React.useEffect(() => {
    setup?.(player);
    // `setup` is an inline closure at every call site; re-running it on identity changes would
    // restart playback on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [player]);

  return player;
}

export interface FakeVideoViewProps extends ViewProps {
  player?: FakeVideoPlayer | null;
  nativeControls?: boolean;
  contentFit?: string;
  allowsPictureInPicture?: boolean;
  startsPictureInPictureAutomatically?: boolean;
}

export const VideoView = React.forwardRef<View, FakeVideoViewProps>(function VideoView(
  { player, nativeControls, contentFit, allowsPictureInPicture, startsPictureInPictureAutomatically, ...rest },
  ref,
) {
  return (
    <View
      ref={ref}
      {...rest}
      // Surfaced so a spec can assert both halves of picture-in-picture stay off.
      accessibilityValue={{
        text: typeof player?.source === 'string' ? player.source : '',
      }}
      accessibilityState={{
        disabled: allowsPictureInPicture === true || startsPictureInPictureAutomatically === true,
      }}
    />
  );
});

export function createVideoPlayer(source: unknown): FakeVideoPlayer {
  return {
    loop: false,
    muted: false,
    playing: false,
    source,
    play() {},
    pause() {},
    release() {},
  };
}

export const isPictureInPictureSupported = (): boolean => false;
