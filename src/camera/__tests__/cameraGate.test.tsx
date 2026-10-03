/**
 * The free tier at the camera: video is free, and a full free vault takes no more items of any
 * kind. The refusal happens BEFORE anything is captured, so no plaintext frame or recording is
 * ever made for an item that could not be kept.
 *
 * Video used to need a Cloud term. It does not: one item is one item whatever it holds, and the
 * only thing left that distinguishes a video is its size. The tests below assert the new model
 * directly, because the old ones asserted the behaviour that was removed.
 */
import { fireEvent, waitFor, type RenderResult } from '@testing-library/react-native';
import React from 'react';

import type { Services } from '@/app/services';
import { InMemoryBillingService } from '@/billing/billingService';
import { FREE_TIER, MAX_ITEM_BYTES } from '@/billing/entitlements';
import { AcceptingCaptureInspector } from '@/camera/captureInspector';
import { CameraSheet, type CameraCapture } from '@/camera/CameraSheet';
import {
  MarkedThumbnailGenerator,
  buildServices,
  imageBytes,
  renderInVault,
  unlockedVault,
  videoBytes,
} from '@/gallery/__tests__/vaultHarness';
import { InMemoryCloudBackend } from '@/firebase/cloudBackend';
import { NoopAnalyticsService, NoopCrashReporter } from '@/firebase/types';
import { FakeClock } from '@/utils/clock';
import type { VaultRepository } from '@/vault/types';

interface CameraMockState {
  takePicture: jest.Mock;
  record: jest.Mock;
  availableSizes: jest.Mock;
  permission: { granted: boolean; canAskAgain: boolean; status: string; expires: string };
  request: jest.Mock;
}

jest.mock('expo-camera', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const react = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  const state = {
    takePicture: jest.fn(),
    record: jest.fn(),
    availableSizes: jest.fn(),
    permission: { granted: true, canAskAgain: true, status: 'granted', expires: 'never' },
    request: jest.fn(),
  };
  const CameraView = react.forwardRef((props: Record<string, unknown>, ref: unknown) => {
    react.useImperativeHandle(ref, () => ({
      takePictureAsync: state.takePicture,
      recordAsync: state.record,
      stopRecording: () => undefined,
      getAvailablePictureSizesAsync: state.availableSizes,
    }));
    const onCameraReady = props.onCameraReady as (() => void) | undefined;
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

interface SellingVault {
  services: Services;
  repository: VaultRepository;
  billing: InMemoryBillingService;
  stop: () => void;
}

async function sellingVault(): Promise<SellingVault> {
  const cloud = new InMemoryCloudBackend();
  const clock = new FakeClock();
  const billing = new InMemoryBillingService(cloud, clock);
  const { services } = buildServices(
    new MarkedThumbnailGenerator(),
    new AcceptingCaptureInspector(),
    {
      clock,
      firebase: {
        available: true,
        crash: new NoopCrashReporter(),
        analytics: new NoopAnalyticsService(),
        cloud,
        billing,
      },
    },
  );
  const keys = await services.auth.setupPin('1234');
  services.session.adopt(keys);
  const repository = await services.vault.open(keys);
  await cloud.signUp('buyer@example.test', 'account-password');
  await services.entitlements.load();
  const stop = services.entitlements.start();
  return { services, repository, billing, stop };
}

async function openSheet(services: Services): Promise<RenderResult> {
  const view = await renderInVault(services, <CameraSheet visible onClose={() => undefined} />);
  await waitFor(() => {
    expect(view.getByTestId('camera-shutter')).toBeTruthy();
  });
  return view;
}

/** The same sheet as a conversation mounts it: with somewhere for the capture to go. */
async function openChatSheet(
  services: Services,
  captures: CameraCapture[],
): Promise<RenderResult> {
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
  await waitFor(() => {
    expect(view.getByTestId('camera-shutter')).toBeTruthy();
  });
  return view;
}

beforeEach(() => {
  cameraMock.__state.takePicture.mockReset();
  cameraMock.__state.record.mockReset();
  cameraMock.__state.availableSizes.mockReset();
  cameraMock.__state.availableSizes.mockResolvedValue([]);
});

describe('CameraSheet free-tier gates', () => {
  it('offers video on a free account, with no Cloud marking', async () => {
    const { services, stop } = await sellingVault();
    const view = await openSheet(services);

    await fireEvent.press(view.getByTestId('camera-mode-video'));

    await waitFor(() => {
      expect(view.getByTestId('camera-record')).toBeTruthy();
    });
    expect(view.getByTestId('camera-mode-video')).toHaveTextContent('Video');
    expect(view.getByTestId('camera-mode-video')).not.toHaveTextContent(/Cloud/);
    expect(view.queryByTestId('camera-notice')).toBeNull();
    stop();
  });

  it('still offers video once a Cloud term is on the account', async () => {
    const { services, billing, stop } = await sellingVault();
    billing.completePayment((await billing.createCheckout('cloud')).checkoutId);
    await services.entitlements.flush();
    const view = await openSheet(services);

    await fireEvent.press(view.getByTestId('camera-mode-video'));

    await waitFor(() => {
      expect(view.getByTestId('camera-record')).toBeTruthy();
    });
    expect(view.getByTestId('camera-mode-video')).not.toHaveTextContent(/Cloud/);
    stop();
  });

  // The other half of "one item is one item": video became free, but it did not become exempt.
  it('refuses video once the free vault is full, before the camera is rebound', async () => {
    const { services, repository, stop } = await sellingVault();
    for (let i = 0; i < FREE_TIER.maxItems; i++) {
      await repository.addPhoto({ bytes: imageBytes(0x10 + (i % 200)) }, { source: 'camera' });
    }
    const view = await openSheet(services);

    await fireEvent.press(view.getByTestId('camera-mode-video'));

    expect(view.getByTestId('camera-notice')).toHaveTextContent(/50 items/);
    expect(view.queryByTestId('camera-record')).toBeNull();
    expect(cameraMock.__state.record).not.toHaveBeenCalled();
    stop();
  });

  it('refuses a photo once the free vault is full, before the shutter fires', async () => {
    const { services, repository, stop } = await sellingVault();
    for (let i = 0; i < FREE_TIER.maxItems; i++) {
      await repository.addPhoto({ bytes: imageBytes(0x10 + (i % 200)) }, { source: 'camera' });
    }
    const view = await openSheet(services);

    await fireEvent.press(view.getByTestId('camera-shutter'));

    expect(view.getByTestId('camera-notice')).toHaveTextContent(/SilentSum Cloud/);
    expect(cameraMock.__state.takePicture).not.toHaveBeenCalled();
    expect(repository.photos).toHaveLength(FREE_TIER.maxItems);
    stop();
  });

  // The size cap is the one gate that cannot run before a capture: the file does not exist yet,
  // so the mode-switch gate passes `bytes: 0`. A long take is the easy way to pass that gate and
  // still produce an item the vault will not accept, so the check runs again at Keep.
  it('refuses a recording over the size cap at Keep, and sells nothing', async () => {
    const { services, repository, stop } = await sellingVault();
    const uri = 'file:///memory/cache/Camera/huge.mp4';
    await services.fs.writeBytes(uri, videoBytes());
    jest.spyOn(services.fs, 'size').mockResolvedValue(MAX_ITEM_BYTES + 1);
    cameraMock.__state.record.mockResolvedValue({ uri });
    const view = await openSheet(services);

    await fireEvent.press(view.getByTestId('camera-mode-video'));
    await fireEvent.press(await view.findByTestId('camera-record'));
    await fireEvent.press(await view.findByTestId('camera-keep'));

    await waitFor(() => {
      expect(view.getByTestId('camera-notice')).toHaveTextContent(/100 MB/);
    });
    expect(view.getByTestId('camera-notice')).not.toHaveTextContent(/Cloud/);
    expect(repository.photos).toHaveLength(0);
    // Refused is not a reason to leave a plaintext recording on disk.
    await waitFor(async () => {
      expect(await services.fs.exists(uri)).toBe(false);
    });
    stop();
  });

  it('never gates a build that cannot sell', async () => {
    const { services } = await unlockedVault();
    const view = await openSheet(services);

    await fireEvent.press(view.getByTestId('camera-mode-video'));

    await waitFor(() => {
      expect(view.getByTestId('camera-record')).toBeTruthy();
    });
    expect(view.queryByTestId('camera-notice')).toBeNull();
    expect(view.getByTestId('camera-mode-video')).not.toHaveTextContent(/Cloud/);
  });
});

/**
 * The same caps, from the other side of the destination branch.
 *
 * Every gate above is the vault answering "will I hold one more item?". A capture on its way to a
 * conversation never becomes a vault item, so none of them has standing over it -- and a free
 * account whose vault is full must still be able to send a photo in a chat it is paying Pro for.
 * The chat's own gate is Pro, enforced by the security rules, and its own ceilings are applied by
 * the send; neither is this sheet's business.
 *
 * These use the account that the specs above prove IS gated, so a wrongly-shared gate fails here
 * rather than passing by accident on a build that cannot sell anything.
 */
describe('CameraSheet gates do not reach a chat capture', () => {
  it('takes a photo for a chat with the free vault already full', async () => {
    const { services, repository, stop } = await sellingVault();
    for (let i = 0; i < FREE_TIER.maxItems; i++) {
      await repository.addPhoto({ bytes: imageBytes(0x10 + (i % 200)) }, { source: 'camera' });
    }
    const uri = 'file:///memory/cache/Camera/for-chat.jpg';
    await services.fs.writeBytes(uri, imageBytes(0x4a));
    cameraMock.__state.takePicture.mockResolvedValue({ uri, width: 800, height: 600, format: 'jpg' });
    const captures: CameraCapture[] = [];
    const view = await openChatSheet(services, captures);

    await fireEvent.press(view.getByTestId('camera-shutter'));
    await waitFor(() => {
      expect(view.getByTestId('camera-review-image')).toBeTruthy();
    });
    await fireEvent.press(view.getByTestId('camera-keep'));

    await waitFor(() => {
      expect(captures).toHaveLength(1);
    });
    // No upsell, and the shutter fired -- the two things the vault path refuses outright here.
    expect(view.queryByTestId('camera-notice')).toBeNull();
    expect(cameraMock.__state.takePicture).toHaveBeenCalled();
    // And the full vault is exactly as full as it was: nothing was added, nothing was refused.
    expect(repository.photos).toHaveLength(FREE_TIER.maxItems);
    stop();
  });

  it('switches to video for a chat with the free vault already full', async () => {
    const { services, repository, stop } = await sellingVault();
    for (let i = 0; i < FREE_TIER.maxItems; i++) {
      await repository.addPhoto({ bytes: imageBytes(0x10 + (i % 200)) }, { source: 'camera' });
    }
    const view = await openChatSheet(services, []);

    await fireEvent.press(view.getByTestId('camera-mode-video'));

    await waitFor(() => {
      expect(view.getByTestId('camera-record')).toBeTruthy();
    });
    expect(view.queryByTestId('camera-notice')).toBeNull();
    stop();
  });

  /**
   * The vault's 100 MB per-item cap is the one gate that runs at Keep, and it is the one most
   * likely to be left in place by accident, because it sits in the same method as the handover.
   * A chat video is bounded by the chat's own ceiling instead, which the send applies from the
   * file's size before it reads a byte of it.
   */
  it('hands over a recording the vault would refuse for its size', async () => {
    const { services, repository, stop } = await sellingVault();
    const uri = 'file:///memory/cache/Camera/big-for-chat.mp4';
    await services.fs.writeBytes(uri, videoBytes());
    jest.spyOn(services.fs, 'size').mockResolvedValue(MAX_ITEM_BYTES + 1);
    cameraMock.__state.record.mockResolvedValue({ uri });
    const captures: CameraCapture[] = [];
    const view = await openChatSheet(services, captures);

    await fireEvent.press(view.getByTestId('camera-mode-video'));
    await fireEvent.press(await view.findByTestId('camera-record'));
    await fireEvent.press(await view.findByTestId('camera-keep'));

    await waitFor(() => {
      expect(captures).toHaveLength(1);
    });
    expect(view.queryByTestId('camera-notice')).toBeNull();
    expect(repository.photos).toHaveLength(0);
    // Still there for the send that was given it, rather than deleted by a refusal.
    expect(await services.fs.exists(uri)).toBe(true);
    stop();
  });
});
