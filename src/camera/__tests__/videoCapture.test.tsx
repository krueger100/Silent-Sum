/**
 * Recording a video into the vault.
 *
 * The thing worth testing here is not that a button toggles: it is that the plaintext recording
 * CameraX leaves in the cache is accounted for on every exit. Kept, discarded, the sheet closed
 * mid-recording, the sheet unmounted by a vault lock -- in all four the file must be gone, and in
 * exactly one of them the vault must have gained an encrypted item.
 */
import { fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

import { CameraSheet } from '@/camera/CameraSheet';
import { renderInVault, unlockedVault, videoBytes } from '@/gallery/__tests__/vaultHarness';
import { isVideo } from '@/vault/mediaKind';
import { containsSequence, utf8Encode } from '@/utils/bytes';

interface CameraMockState {
  takePicture: jest.Mock;
  availableSizes: jest.Mock;
  record: jest.Mock;
  stopRecording: jest.Mock;
  permission: { granted: boolean; canAskAgain: boolean; status: string; expires: string } | null;
  request: jest.Mock;
  lastProps: Record<string, unknown>;
}

jest.mock('expo-camera', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const react = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  const state = {
    takePicture: jest.fn(),
    availableSizes: jest.fn(),
    record: jest.fn(),
    stopRecording: jest.fn(),
    permission: { granted: true, canAskAgain: true, status: 'granted', expires: 'never' },
    request: jest.fn(),
    lastProps: {} as Record<string, unknown>,
  };
  const CameraView = react.forwardRef((props: Record<string, unknown>, ref: unknown) => {
    state.lastProps = props;
    react.useImperativeHandle(ref, () => ({
      takePictureAsync: state.takePicture,
      getAvailablePictureSizesAsync: state.availableSizes,
      recordAsync: state.record,
      stopRecording: state.stopRecording,
    }));
    const onCameraReady = props.onCameraReady as (() => void) | undefined;
    // The real view reports readiness every time CameraX rebinds its use cases, which happens on
    // a flip and on a mode change as well as on the first mount. The sheet resets its readiness
    // flag at those points and waits, so a mock that only fires once would hang the shutter.
    react.useEffect(() => {
      onCameraReady?.();
    }, [onCameraReady, props.mode, props.facing]);
    return react.createElement(View, props);
  });
  return {
    __state: state,
    CameraView,
    useCameraPermissions: () => [state.permission, state.request],
  };
});

const cameraMock = jest.requireMock('expo-camera') as { __state: CameraMockState };

const RECORDING_URI = 'file:///memory/cache/Camera/recording.mp4';

/** Holds `recordAsync` open the way the native module does, until `stopRecording` is called. */
function pendingRecording(uri: string | null = RECORDING_URI): { stop: () => void } {
  let release: (() => void) | null = null;
  cameraMock.__state.record.mockImplementation(
    () =>
      new Promise<{ uri: string } | undefined>((resolve) => {
        release = () => {
          resolve(uri === null ? undefined : { uri });
        };
      }),
  );
  cameraMock.__state.stopRecording.mockImplementation(() => {
    release?.();
  });
  return {
    stop: () => {
      release?.();
    },
  };
}

beforeEach(() => {
  cameraMock.__state.takePicture.mockReset();
  cameraMock.__state.availableSizes.mockReset();
  cameraMock.__state.availableSizes.mockResolvedValue([]);
  cameraMock.__state.record.mockReset();
  cameraMock.__state.stopRecording.mockReset();
  cameraMock.__state.request.mockReset();
  cameraMock.__state.permission = {
    granted: true,
    canAskAgain: true,
    status: 'granted',
    expires: 'never',
  };
});

describe('the camera sheet in video mode', () => {
  it('records, reviews and encrypts the recording into the vault', async () => {
    const { services, fs, repository } = await unlockedVault();
    await fs.writeBytes(RECORDING_URI, videoBytes());
    const recording = pendingRecording();

    const view = await renderInVault(services, <CameraSheet visible onClose={() => undefined} />);

    fireEvent.press(view.getByTestId('camera-mode-video'));
    // The camera has to be rebound for video, or CameraX has no recorder to start.
    await waitFor(() => {
      expect(cameraMock.__state.lastProps.mode).toBe('video');
    });
    // And the microphone is never opened, which is what keeps RECORD_AUDIO out of the manifest.
    expect(cameraMock.__state.lastProps.mute).toBe(true);

    fireEvent.press(await view.findByTestId('camera-record'));
    await waitFor(() => {
      expect(cameraMock.__state.record).toHaveBeenCalledTimes(1);
    });
    expect(view.getByTestId('camera-timer')).toBeTruthy();

    fireEvent.press(view.getByTestId('camera-record'));
    recording.stop();

    // The recording is offered for review, played from its own cache file.
    const surface = await view.findByTestId('camera-review-video');
    expect(surface).toBeTruthy();
    expect(view.getByText('Keep this video?')).toBeTruthy();

    fireEvent.press(view.getByTestId('camera-keep'));
    await waitFor(() => {
      expect(repository.photos).toHaveLength(1);
    });

    const entry = repository.photos[0];
    if (entry === undefined) throw new Error('expected the entry');
    expect(isVideo(entry)).toBe(true);
    expect(entry.source).toBe('camera');
    expect(entry.durationMs).not.toBeNull();

    // The plaintext recording is gone, and nothing on disk contains it.
    await waitFor(async () => {
      expect(await fs.exists(RECORDING_URI)).toBe(false);
    });
    for (const bytes of fs.allFiles.values()) {
      expect(containsSequence(bytes, utf8Encode('ftypisom'))).toBe(false);
    }
  });

  it('securely deletes a discarded recording and stores nothing', async () => {
    const { services, fs, repository } = await unlockedVault();
    await fs.writeBytes(RECORDING_URI, videoBytes());
    const stored = fs.peek(RECORDING_URI);
    if (stored === undefined) throw new Error('expected the file');
    const recording = pendingRecording();

    const view = await renderInVault(services, <CameraSheet visible onClose={() => undefined} />);
    fireEvent.press(view.getByTestId('camera-mode-video'));
    fireEvent.press(await view.findByTestId('camera-record'));
    await waitFor(() => {
      expect(cameraMock.__state.record).toHaveBeenCalled();
    });
    recording.stop();
    await view.findByTestId('camera-review-video');

    fireEvent.press(view.getByTestId('camera-discard'));

    await waitFor(async () => {
      expect(await fs.exists(RECORDING_URI)).toBe(false);
    });
    expect(repository.photos).toEqual([]);
    // Overwritten, not merely unlinked.
    expect(containsSequence(stored, utf8Encode('ftypisom'))).toBe(false);
    expect(view.getByTestId('camera-notice')).toHaveTextContent('Video discarded.');
  });

  it('stops and deletes the recording when the sheet is closed mid-take', async () => {
    const { services, fs, repository } = await unlockedVault();
    await fs.writeBytes(RECORDING_URI, videoBytes());
    pendingRecording();

    const onClose = jest.fn();
    const view = await renderInVault(services, <CameraSheet visible onClose={onClose} />);
    fireEvent.press(view.getByTestId('camera-mode-video'));
    fireEvent.press(await view.findByTestId('camera-record'));
    await waitFor(() => {
      expect(cameraMock.__state.record).toHaveBeenCalled();
    });

    fireEvent.press(view.getByTestId('camera-close'));

    // The native recorder is told to stop -- otherwise it would keep writing to a file nobody is
    // tracking -- and the file it produces is deleted rather than reviewed.
    expect(cameraMock.__state.stopRecording).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    await waitFor(async () => {
      expect(await fs.exists(RECORDING_URI)).toBe(false);
    });
    expect(repository.photos).toEqual([]);
  });

  it('deletes a recording that arrives after a vault lock has unmounted the sheet', async () => {
    const { services, fs } = await unlockedVault();
    await fs.writeBytes(RECORDING_URI, videoBytes());
    const recording = pendingRecording();

    const view = await renderInVault(services, <CameraSheet visible onClose={() => undefined} />);
    fireEvent.press(view.getByTestId('camera-mode-video'));
    fireEvent.press(await view.findByTestId('camera-record'));
    await waitFor(() => {
      expect(cameraMock.__state.record).toHaveBeenCalled();
    });

    // The vault locks: the navigator unmounts the whole vault flow, sheet included.
    view.unmount();
    recording.stop();

    await waitFor(async () => {
      expect(await fs.exists(RECORDING_URI)).toBe(false);
    });
  });

  it('reports a failed recording without storing anything', async () => {
    const { services, repository } = await unlockedVault();
    cameraMock.__state.record.mockRejectedValue(new Error('camera in use'));

    const view = await renderInVault(services, <CameraSheet visible onClose={() => undefined} />);
    fireEvent.press(view.getByTestId('camera-mode-video'));
    fireEvent.press(await view.findByTestId('camera-record'));

    await waitFor(() => {
      expect(view.getByTestId('camera-notice')).toHaveTextContent('Could not record the video.');
    });
    expect(repository.photos).toEqual([]);
  });

  it('still takes photos, and does not put the camera in video mode to do it', async () => {
    const { services, fs, repository } = await unlockedVault();
    const captureUri = 'file:///memory/cache/Camera/shot.jpg';
    await fs.writeBytes(captureUri, videoBytes(256));
    cameraMock.__state.takePicture.mockResolvedValue({ uri: captureUri });

    const view = await renderInVault(services, <CameraSheet visible onClose={() => undefined} />);
    expect(cameraMock.__state.lastProps.mode).toBe('picture');

    fireEvent.press(view.getByTestId('camera-shutter'));
    await view.findByTestId('camera-review-image');
    fireEvent.press(view.getByTestId('camera-keep'));

    await waitFor(() => {
      expect(repository.photos).toHaveLength(1);
    });
    expect(isVideo(repository.photos[0] ?? { mimeType: '' })).toBe(false);
  });
});
