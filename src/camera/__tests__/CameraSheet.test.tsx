import { fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

import { ScriptedCaptureInspector } from '@/camera/captureInspector';
import { CameraSheet } from '@/camera/CameraSheet';
import {
  MarkedThumbnailGenerator,
  UNDECODABLE,
  imageBytes,
  renderInVault,
  unlockedVault,
} from '@/gallery/__tests__/vaultHarness';

interface PermissionLike {
  granted: boolean;
  canAskAgain: boolean;
  status: string;
  expires: string;
}

interface CameraMockState {
  takePicture: jest.Mock;
  availableSizes: jest.Mock;
  permission: PermissionLike | null;
  request: jest.Mock;
}

const GRANTED: PermissionLike = {
  granted: true,
  canAskAgain: true,
  status: 'granted',
  expires: 'never',
};

jest.mock('expo-camera', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const react = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  const state = {
    takePicture: jest.fn(),
    availableSizes: jest.fn(),
    permission: { granted: true, canAskAgain: true, status: 'granted', expires: 'never' },
    request: jest.fn(),
  };
  const CameraView = react.forwardRef((props: Record<string, unknown>, ref: unknown) => {
    react.useImperativeHandle(ref, () => ({
      takePictureAsync: state.takePicture,
      getAvailablePictureSizesAsync: state.availableSizes,
    }));
    // The native view reports readiness once the session is running; the sheet waits for it
    // before it will fire the shutter, so the mock has to say so too.
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

/** The sheet as the gallery mounts it. */
function sheet(onClose: () => void = () => undefined): React.JSX.Element {
  return <CameraSheet visible onClose={onClose} />;
}

beforeEach(() => {
  cameraMock.__state.takePicture.mockReset();
  cameraMock.__state.availableSizes.mockReset();
  cameraMock.__state.availableSizes.mockResolvedValue([]);
  cameraMock.__state.request.mockReset();
  cameraMock.__state.request.mockResolvedValue(GRANTED);
  cameraMock.__state.permission = { ...GRANTED };
});

describe('CameraSheet', () => {
  it('renders nothing until it is opened', async () => {
    const { services } = await unlockedVault();
    const view = await renderInVault(services, <CameraSheet visible={false} onClose={() => {}} />);
    expect(view.queryByTestId('camera-sheet')).toBeNull();
    expect(view.queryByTestId('camera-preview')).toBeNull();
  });

  it('offers the capture for review instead of storing it, and wipes the temp file first', async () => {
    const { services, fs } = await unlockedVault();
    const tempUri = `${fs.cacheDirectory}/Camera/capture-1.jpg`;
    await fs.writeBytes(tempUri, imageBytes());
    cameraMock.__state.takePicture.mockResolvedValue({
      uri: tempUri,
      width: 1200,
      height: 900,
      format: 'jpg',
    });

    const view = await renderInVault(services, sheet());
    await fireEvent.press(view.getByTestId('camera-shutter'));

    await waitFor(() => {
      expect(view.getByTestId('camera-review-image')).toBeTruthy();
    });
    // Nothing is in the vault yet: the decision has not been made.
    expect(services.vault.store.getState().photos).toHaveLength(0);
    // The plugin's plaintext JPEG must not survive the capture, review or no review.
    expect(await fs.exists(tempUri)).toBe(false);
    // The review is an in-memory image, never a file.
    const raw = view.getByTestId('camera-review-image').props.source as
      | { uri?: string }
      | { uri?: string }[];
    const uri = (Array.isArray(raw) ? raw[0]?.uri : raw?.uri) ?? '';
    expect(uri.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('encrypts the capture into the vault when it is kept', async () => {
    const { services, fs } = await unlockedVault();
    const tempUri = `${fs.cacheDirectory}/Camera/capture-2.jpg`;
    await fs.writeBytes(tempUri, imageBytes());
    cameraMock.__state.takePicture.mockResolvedValue({
      uri: tempUri,
      width: 1200,
      height: 900,
      format: 'jpg',
    });

    const view = await renderInVault(services, sheet());
    await fireEvent.press(view.getByTestId('camera-shutter'));
    await waitFor(() => {
      expect(view.getByTestId('camera-keep')).toBeTruthy();
    });
    await fireEvent.press(view.getByTestId('camera-keep'));

    await waitFor(() => {
      expect(services.vault.store.getState().photos).toHaveLength(1);
    });
    expect(services.vault.store.getState().photos[0]?.source).toBe('camera');
    // Back to the live camera, ready for the next shot.
    await waitFor(() => {
      expect(view.queryByTestId('camera-review-image')).toBeNull();
    });
    expect(view.getByTestId('camera-preview')).toBeTruthy();
    expect(view.getByText('Saved to vault')).toBeTruthy();
  });

  it('stores nothing when the capture is discarded', async () => {
    const { services, fs } = await unlockedVault();
    const tempUri = `${fs.cacheDirectory}/Camera/capture-3.jpg`;
    await fs.writeBytes(tempUri, imageBytes());
    cameraMock.__state.takePicture.mockResolvedValue({
      uri: tempUri,
      width: 1200,
      height: 900,
      format: 'jpg',
    });

    const view = await renderInVault(services, sheet());
    await fireEvent.press(view.getByTestId('camera-shutter'));
    await waitFor(() => {
      expect(view.getByTestId('camera-discard')).toBeTruthy();
    });
    await fireEvent.press(view.getByTestId('camera-discard'));

    await waitFor(() => {
      expect(view.queryByTestId('camera-review-image')).toBeNull();
    });
    expect(services.vault.store.getState().photos).toHaveLength(0);
    expect(view.getByTestId('camera-preview')).toBeTruthy();
    expect(view.getByText('Photo discarded.')).toBeTruthy();
  });

  it('drops a pending review when the sheet is closed', async () => {
    const { services, fs } = await unlockedVault();
    const tempUri = `${fs.cacheDirectory}/Camera/capture-4.jpg`;
    await fs.writeBytes(tempUri, imageBytes());
    cameraMock.__state.takePicture.mockResolvedValue({
      uri: tempUri,
      width: 1200,
      height: 900,
      format: 'jpg',
    });
    const onClose = jest.fn();

    const view = await renderInVault(services, sheet(onClose));
    await fireEvent.press(view.getByTestId('camera-shutter'));
    await waitFor(() => {
      expect(view.getByTestId('camera-review-image')).toBeTruthy();
    });
    await fireEvent.press(view.getByTestId('camera-close'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(services.vault.store.getState().photos).toHaveLength(0);
    await waitFor(() => {
      expect(view.queryByTestId('camera-review-image')).toBeNull();
    });
  });

  it('never asks for EXIF or a base64 copy of the capture', async () => {
    const { services, fs } = await unlockedVault();
    const tempUri = `${fs.cacheDirectory}/Camera/capture-5.jpg`;
    await fs.writeBytes(tempUri, imageBytes());
    cameraMock.__state.takePicture.mockResolvedValue({
      uri: tempUri,
      width: 1200,
      height: 900,
      format: 'jpg',
    });

    const view = await renderInVault(services, sheet());
    await fireEvent.press(view.getByTestId('camera-shutter'));

    await waitFor(() => {
      expect(view.getByTestId('camera-review-image')).toBeTruthy();
    });
    const options = cameraMock.__state.takePicture.mock.calls[0]?.[0] as
      | { base64?: boolean; exif?: boolean }
      | undefined;
    expect(options?.base64).toBe(false);
    expect(options?.exif).toBe(false);
  });

  it('ignores a second shutter tap while a capture is in flight', async () => {
    const { services, fs } = await unlockedVault();
    const tempUri = `${fs.cacheDirectory}/Camera/capture-6.jpg`;
    await fs.writeBytes(tempUri, imageBytes());

    let release: (() => void) | null = null;
    const pending = new Promise<{ uri: string; width: number; height: number; format: string }>(
      (resolve) => {
        release = () => {
          resolve({ uri: tempUri, width: 1200, height: 900, format: 'jpg' });
        };
      },
    );
    cameraMock.__state.takePicture.mockReturnValue(pending);

    const view = await renderInVault(services, sheet());
    const shutter = view.getByTestId('camera-shutter');
    await fireEvent.press(shutter);
    await fireEvent.press(shutter);

    expect(cameraMock.__state.takePicture).toHaveBeenCalledTimes(1);

    if (release === null) throw new Error('capture was never started');
    (release as () => void)();
    await waitFor(() => {
      expect(view.getByTestId('camera-review-image')).toBeTruthy();
    });
    expect(cameraMock.__state.takePicture).toHaveBeenCalledTimes(1);
  });

  it('keeps the temp file wiped when storing the kept photo fails', async () => {
    const { services, fs } = await unlockedVault();
    const tempUri = `${fs.cacheDirectory}/Camera/capture-7.jpg`;
    await fs.writeBytes(tempUri, imageBytes(UNDECODABLE)); // the fake generator refuses this one
    cameraMock.__state.takePicture.mockResolvedValue({
      uri: tempUri,
      width: 1200,
      height: 900,
      format: 'jpg',
    });

    const view = await renderInVault(services, sheet());
    await fireEvent.press(view.getByTestId('camera-shutter'));
    await waitFor(() => {
      expect(view.getByTestId('camera-keep')).toBeTruthy();
    });
    // The temp file is gone before the decision is even offered.
    expect(await fs.exists(tempUri)).toBe(false);
    await fireEvent.press(view.getByTestId('camera-keep'));

    await waitFor(() => {
      expect(view.getByText('Could not save the photo.')).toBeTruthy();
    });
    expect(services.vault.store.getState().photos).toHaveLength(0);
  });

  it('explains a permanently denied permission and offers no shutter', async () => {
    const { services } = await unlockedVault();
    cameraMock.__state.permission = {
      granted: false,
      canAskAgain: false,
      status: 'denied',
      expires: 'never',
    };

    const view = await renderInVault(services, sheet());

    expect(view.getByTestId('camera-permission')).toBeTruthy();
    expect(view.getByText('Camera access needed')).toBeTruthy();
    expect(view.getByText(/device settings/)).toBeTruthy();
    expect(view.queryByTestId('camera-shutter')).toBeNull();
    // Nothing to ask for: the OS has stopped accepting prompts.
    expect(cameraMock.__state.request).not.toHaveBeenCalled();
  });

  it('suspends auto-lock across the permission prompt and resumes it', async () => {
    const { services } = await unlockedVault();
    cameraMock.__state.permission = {
      granted: false,
      canAskAgain: true,
      status: 'undetermined',
      expires: 'never',
    };
    const suspend = jest.spyOn(services.autoLockSuspension, 'suspend');
    const resume = jest.spyOn(services.autoLockSuspension, 'resume');
    cameraMock.__state.request.mockImplementation(async () => {
      expect(services.autoLockSuspension.isSuspended).toBe(true);
      return GRANTED;
    });

    await renderInVault(services, sheet());

    await waitFor(() => {
      expect(cameraMock.__state.request).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(services.autoLockSuspension.count).toBe(0);
    });
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it('refuses to capture once the vault is locked', async () => {
    const { services } = await unlockedVault();
    const view = await renderInVault(services, sheet());

    services.session.lock();
    await fireEvent.press(view.getByTestId('camera-shutter'));

    expect(cameraMock.__state.takePicture).not.toHaveBeenCalled();
    expect(view.getByText('The vault is locked.')).toBeTruthy();
  });

  it('discards a blank frame instead of offering it, and says so', async () => {
    // Every attempt comes back blank: what the emulator's virtual-scene camera does when the
    // capture pipeline hands over a frame the sensor never exposed.
    const inspector = new ScriptedCaptureInspector(Number.MAX_SAFE_INTEGER);
    const { services, fs } = await unlockedVault(new MarkedThumbnailGenerator(), inspector);
    const tempUri = `${fs.cacheDirectory}/Camera/capture-blank.jpg`;
    cameraMock.__state.takePicture.mockImplementation(async () => {
      await fs.writeBytes(tempUri, imageBytes());
      return { uri: tempUri, width: 1200, height: 900, format: 'jpg' };
    });

    const view = await renderInVault(services, sheet());
    await fireEvent.press(view.getByTestId('camera-shutter'));

    await waitFor(
      () => {
        expect(view.getByTestId('camera-notice')).toBeTruthy();
      },
      { timeout: 5000 },
    );
    expect(view.getByText(/blank frame/)).toBeTruthy();
    // A frame with no picture in it is never shown back, never stored, and leaves nothing behind.
    expect(view.queryByTestId('camera-review-image')).toBeNull();
    expect(services.vault.store.getState().photos).toHaveLength(0);
    expect(await fs.exists(tempUri)).toBe(false);
    // Retried rather than given up on after the first bad frame.
    expect(cameraMock.__state.takePicture).toHaveBeenCalledTimes(3);
  }, 20000);

  it('retries a blank first frame and offers the one that comes back good', async () => {
    const inspector = new ScriptedCaptureInspector(1);
    const { services, fs } = await unlockedVault(new MarkedThumbnailGenerator(), inspector);
    const tempUri = `${fs.cacheDirectory}/Camera/capture-retry.jpg`;
    cameraMock.__state.takePicture.mockImplementation(async () => {
      await fs.writeBytes(tempUri, imageBytes());
      return { uri: tempUri, width: 1200, height: 900, format: 'jpg' };
    });

    const view = await renderInVault(services, sheet());
    await fireEvent.press(view.getByTestId('camera-shutter'));

    await waitFor(
      () => {
        expect(view.getByTestId('camera-review-image')).toBeTruthy();
      },
      { timeout: 5000 },
    );
    expect(cameraMock.__state.takePicture).toHaveBeenCalledTimes(2);
    expect(await fs.exists(tempUri)).toBe(false);
  }, 20000);

  it('never requests a resolution: the camera keeps its own configuration', async () => {
    const inspector = new ScriptedCaptureInspector(Number.MAX_SAFE_INTEGER);
    const { services, fs } = await unlockedVault(new MarkedThumbnailGenerator(), inspector);
    const tempUri = `${fs.cacheDirectory}/Camera/capture-size.jpg`;
    cameraMock.__state.availableSizes.mockResolvedValue(['640x480', '4032x3024']);
    cameraMock.__state.takePicture.mockImplementation(async () => {
      await fs.writeBytes(tempUri, imageBytes());
      return { uri: tempUri, width: 1200, height: 900, format: 'jpg' };
    });

    const view = await renderInVault(services, sheet());
    await fireEvent.press(view.getByTestId('camera-shutter'));

    await waitFor(
      () => {
        expect(cameraMock.__state.takePicture).toHaveBeenCalledTimes(3);
      },
      { timeout: 5000 },
    );
    // Not as a capture option and not as a view property: on the Android emulator neither changes
    // the still that comes back, and a named size can only override a supported default.
    for (const call of cameraMock.__state.takePicture.mock.calls) {
      expect((call[0] as { pictureSize?: string }).pictureSize).toBeUndefined();
    }
    const preview = view.getByTestId('camera-preview');
    expect(preview.props.pictureSize).toBeUndefined();
    expect(preview.props.ratio).toBeUndefined();
  }, 20000);
});
