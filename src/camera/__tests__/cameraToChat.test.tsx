/**
 * The camera, handing a capture to a caller instead of to the vault.
 *
 * One optional prop decides the destination, so the thing worth pinning is the handover itself --
 * and specifically the two places where ownership of plaintext changes hands, because getting
 * either one backwards is silent:
 *
 *  - A PHOTO is handed over as a copy. The sheet zeroes its own buffer as soon as the decision is
 *    made, so handing over the same array would deliver an image of nothing but zeroes: a bug that
 *    produces a real message, a real upload and a blank picture at the other end.
 *  - A RECORDING is handed over as a file the sheet stops tracking. Every other exit from this
 *    sheet securely deletes that file, so failing to release it would wipe the recording out from
 *    under the send that was given it.
 *
 * The mirror of both is here too: without the callback, nothing about the vault path changes.
 */
import { fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

import { CameraSheet, type CameraCapture } from '@/camera/CameraSheet';
import { imageBytes, renderInVault, unlockedVault, videoBytes } from '@/gallery/__tests__/vaultHarness';
import { isVideo } from '@/vault/mediaKind';

interface CameraMockState {
  takePicture: jest.Mock;
  availableSizes: jest.Mock;
  record: jest.Mock;
  stopRecording: jest.Mock;
  permission: { granted: boolean; canAskAgain: boolean; status: string; expires: string } | null;
  request: jest.Mock;
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
  };
  const CameraView = react.forwardRef((props: Record<string, unknown>, ref: unknown) => {
    react.useImperativeHandle(ref, () => ({
      takePictureAsync: state.takePicture,
      getAvailablePictureSizesAsync: state.availableSizes,
      recordAsync: state.record,
      stopRecording: state.stopRecording,
    }));
    const onCameraReady = props.onCameraReady as (() => void) | undefined;
    // The real view reports readiness every time CameraX rebinds, which a mode change does.
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

const TEMP_JPEG = 'file:///memory/cache/Camera/capture-1.jpg';
const RECORDING = 'file:///memory/cache/Camera/recording.mp4';

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

describe('the camera sheet with a capture callback', () => {
  it('hands a photo over instead of storing it, and stores nothing', async () => {
    const { services, fs, repository } = await unlockedVault();
    const original = imageBytes(0x4a);
    await fs.writeBytes(TEMP_JPEG, original);
    cameraMock.__state.takePicture.mockResolvedValue({
      uri: TEMP_JPEG,
      width: 1200,
      height: 900,
      format: 'jpg',
    });
    const captures: CameraCapture[] = [];
    let closed = 0;

    const view = await renderInVault(
      services,
      <CameraSheet
        visible
        onClose={() => {
          closed += 1;
        }}
        onCapture={(capture) => {
          captures.push(capture);
        }}
      />,
    );
    await fireEvent.press(view.getByTestId('camera-shutter'));
    await waitFor(() => {
      expect(view.getByTestId('camera-review-image')).toBeTruthy();
    });
    await fireEvent.press(view.getByTestId('camera-keep'));

    await waitFor(() => {
      expect(captures).toHaveLength(1);
    });
    const capture = captures[0];
    if (capture?.kind !== 'photo') throw new Error('expected a photo capture');
    // The bytes the camera produced, not a re-encode and not an empty buffer.
    expect(capture.bytes).toEqual(original);
    // The vault was never opened for this: no item, and no "Saved to vault".
    expect(repository.photos).toHaveLength(0);
    expect(view.queryByTestId('camera-notice')).toBeNull();
    // The sheet closes itself, exactly as it does on any other exit.
    expect(closed).toBe(1);
  });

  /**
   * The copy, pinned by what happens AFTER the handover. The sheet wipes its own buffer on the way
   * out, so a handover that passed the array itself would leave this holding 256 zero bytes -- and
   * the send would carry them all the way to the other device.
   */
  it('hands over a copy, so wiping its own buffer does not blank the photo', async () => {
    const { services, fs } = await unlockedVault();
    const original = imageBytes(0x4a);
    await fs.writeBytes(TEMP_JPEG, original);
    cameraMock.__state.takePicture.mockResolvedValue({
      uri: TEMP_JPEG,
      width: 1200,
      height: 900,
      format: 'jpg',
    });
    let handed: Uint8Array | null = null;

    const view = await renderInVault(
      services,
      <CameraSheet
        visible
        onClose={() => undefined}
        onCapture={(capture) => {
          if (capture.kind === 'photo') handed = capture.bytes;
        }}
      />,
    );
    await fireEvent.press(view.getByTestId('camera-shutter'));
    await waitFor(() => {
      expect(view.getByTestId('camera-review-image')).toBeTruthy();
    });
    await fireEvent.press(view.getByTestId('camera-keep'));

    await waitFor(() => {
      expect(handed).not.toBeNull();
    });
    const bytes: Uint8Array = handed as unknown as Uint8Array;
    expect(bytes.some((b) => b !== 0)).toBe(true);
    expect(bytes).toEqual(original);
    // And the camera's own plaintext JPEG is gone either way: it is deleted inside the capture,
    // long before the decision, so a chat photo leaves nothing on disk at all.
    expect(await fs.exists(TEMP_JPEG)).toBe(false);
  });

  /**
   * The recording is the other direction: the sheet must NOT delete it, because the send it was
   * handed to has not read it yet. Every other exit from this sheet does delete it, which is what
   * makes this worth a spec of its own.
   */
  it('hands a recording over and leaves the file for its new owner', async () => {
    const { services, fs, repository } = await unlockedVault();
    await fs.writeBytes(RECORDING, videoBytes());
    cameraMock.__state.record.mockResolvedValue({ uri: RECORDING });
    const captures: CameraCapture[] = [];

    const view = await renderInVault(
      services,
      <CameraSheet
        visible
        onClose={() => undefined}
        onCapture={(capture) => {
          captures.push(capture);
        }}
      />,
    );
    await fireEvent.press(view.getByTestId('camera-mode-video'));
    await fireEvent.press(await view.findByTestId('camera-record'));
    await fireEvent.press(await view.findByTestId('camera-keep'));

    await waitFor(() => {
      expect(captures).toHaveLength(1);
    });
    const capture = captures[0];
    if (capture?.kind !== 'video') throw new Error('expected a video capture');
    expect(capture.uri).toBe(RECORDING);
    expect(capture.durationMs).toBeGreaterThanOrEqual(0);
    // Not deleted, not encrypted into the vault: handed over, with its bytes intact.
    expect(await fs.exists(RECORDING)).toBe(true);
    expect(await fs.readBytes(RECORDING)).toEqual(videoBytes());
    expect(repository.photos).toHaveLength(0);
  });

  it('discards a capture without handing it anywhere', async () => {
    const { services, fs } = await unlockedVault();
    await fs.writeBytes(RECORDING, videoBytes());
    cameraMock.__state.record.mockResolvedValue({ uri: RECORDING });
    const captures: CameraCapture[] = [];

    const view = await renderInVault(
      services,
      <CameraSheet
        visible
        onClose={() => undefined}
        onCapture={(capture) => {
          captures.push(capture);
        }}
      />,
    );
    await fireEvent.press(view.getByTestId('camera-mode-video'));
    await fireEvent.press(await view.findByTestId('camera-record'));
    await fireEvent.press(await view.findByTestId('camera-discard'));

    expect(captures).toEqual([]);
    // Discarding still owns the file, so it still overwrites it.
    await waitFor(async () => {
      expect(await fs.exists(RECORDING)).toBe(false);
    });
  });
});

/**
 * The same sheet with the prop absent. These are the vault behaviours the chat path must not have
 * disturbed, asserted from the other side of the branch.
 */
describe('the camera sheet without a capture callback', () => {
  it('still encrypts a photo into the vault', async () => {
    const { services, fs, repository } = await unlockedVault();
    await fs.writeBytes(TEMP_JPEG, imageBytes(0x4a));
    cameraMock.__state.takePicture.mockResolvedValue({
      uri: TEMP_JPEG,
      width: 1200,
      height: 900,
      format: 'jpg',
    });

    const view = await renderInVault(services, <CameraSheet visible onClose={() => undefined} />);
    await fireEvent.press(view.getByTestId('camera-shutter'));
    await waitFor(() => {
      expect(view.getByTestId('camera-review-image')).toBeTruthy();
    });
    await fireEvent.press(view.getByTestId('camera-keep'));

    await waitFor(() => {
      expect(view.getByTestId('camera-notice')).toHaveTextContent('Saved to vault');
    });
    expect(repository.photos).toHaveLength(1);
    expect(await fs.exists(TEMP_JPEG)).toBe(false);
  });

  it('still encrypts a recording into the vault and deletes the plaintext', async () => {
    const { services, fs, repository } = await unlockedVault();
    await fs.writeBytes(RECORDING, videoBytes());
    cameraMock.__state.record.mockResolvedValue({ uri: RECORDING });

    const view = await renderInVault(services, <CameraSheet visible onClose={() => undefined} />);
    await fireEvent.press(view.getByTestId('camera-mode-video'));
    await fireEvent.press(await view.findByTestId('camera-record'));
    await fireEvent.press(await view.findByTestId('camera-keep'));

    await waitFor(() => {
      expect(view.getByTestId('camera-notice')).toHaveTextContent('Saved to vault');
    });
    expect(repository.photos).toHaveLength(1);
    expect(repository.photos.every(isVideo)).toBe(true);
    expect(await fs.exists(RECORDING)).toBe(false);
  });
});
