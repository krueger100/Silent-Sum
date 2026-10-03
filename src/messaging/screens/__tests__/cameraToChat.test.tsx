/**
 * Camera -> chat, end to end, against two real accounts sharing one store.
 *
 * The point of these is convergence. The camera was the one source the messaging spec promised and
 * the code never wired, and the temptation when wiring it is to give it its own path -- its own
 * encryption, its own upload, its own idea of what is too big. It gets none: a capture becomes a
 * `MediaSource` and joins the picker and the vault at `sendMedia`, which is why the assertions
 * below are about the SAME artefacts a library photo produces, not about camera-specific ones.
 *
 * The other half is the plaintext recording. A camera video is a file on this device's disk with no
 * encryption on it, handed to a send that may fail, and the choice made here is that it is deleted
 * once the attempt settles rather than kept alive to make retries convenient. That trade has a
 * visible consequence -- a retry afterwards says "choose it again" -- so it is asserted rather than
 * left as a comment.
 *
 * The vault is deliberately NEVER opened in this file: the harness adopts the session keys that
 * messaging needs without opening a repository. A camera that still works here is a camera that
 * has genuinely stopped consulting the vault.
 */
import React from 'react';
import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { AcceptingCaptureInspector } from '@/camera/captureInspector';
import { CloudError } from '@/firebase/types';
import { renderWithServices } from '@/billing/screens/__tests__/harness';
import { MESSAGING_PATHS } from '@/messaging/messaging';
import { MAX_PHOTO_BYTES, MAX_VIDEO_BYTES } from '@/messaging/media';
import { ConversationScreen } from '@/messaging/screens/ConversationScreen';
import { ALICE, BOB, MessagingWorld, flush, type Account } from '@/messaging/screens/__tests__/harness';
import type { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import type { FakeThumbnailGenerator } from '@/vault/thumbnailGenerator';

interface CameraMockState {
  takePicture: jest.Mock;
  availableSizes: jest.Mock;
  record: jest.Mock;
  stopRecording: jest.Mock;
  permission: { granted: boolean; canAskAgain: boolean; status: string; expires: string };
  request: jest.Mock;
}

jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn() }));

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

const TEMP_JPEG = 'file:///memory/cache/Camera/shot.jpg';
const RECORDING = 'file:///memory/cache/Camera/take.mp4';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7, 8, 9, 10, 11, 12]);
const MP4 = new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4]);

interface Chat {
  readonly world: MessagingWorld;
  readonly alice: Account;
  readonly conversationId: string;
  readonly fs: InMemoryFileSystem;
}

/** Two accounts, one conversation, and Alice's screen already on screen. */
async function chat(): Promise<Chat> {
  const world = new MessagingWorld();
  const alice = await world.join(ALICE, 1);
  await world.join(BOB, 2);
  const conversationId = await alice.messaging.startConversation(BOB);
  // Frame inspection is the camera's own concern and has its own suite; here it must simply pass
  // so that what is under test is the pipeline behind it.
  Object.assign(alice.services, { captureInspector: new AcceptingCaptureInspector() });
  await renderWithServices(alice.services, <ConversationScreen conversationId={conversationId} />);
  await flush();
  return { world, alice, conversationId, fs: alice.services.fs as InMemoryFileSystem };
}

async function openCamera(): Promise<void> {
  await fireEvent.press(screen.getByTestId('conversation_attach'));
  await fireEvent.press(screen.getByTestId('attach_camera'));
  await flush();
}

async function takePhoto(): Promise<void> {
  await openCamera();
  await fireEvent.press(screen.getByTestId('camera-shutter'));
  await waitFor(() => {
    expect(screen.getByTestId('camera-review-image')).toBeTruthy();
  });
  await fireEvent.press(screen.getByTestId('camera-keep'));
  await flush();
}

async function recordVideo(): Promise<void> {
  await openCamera();
  await fireEvent.press(screen.getByTestId('camera-mode-video'));
  await fireEvent.press(await screen.findByTestId('camera-record'));
  await fireEvent.press(await screen.findByTestId('camera-keep'));
  await flush();
}

/** The message documents in one conversation, in the form the store holds them. */
function messages(world: MessagingWorld, conversationId: string): Record<string, unknown>[] {
  const prefix = MESSAGING_PATHS.messages(conversationId);
  return [...world.store.documents.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, value]) => value as Record<string, unknown>);
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

describe('a photo taken in a conversation', () => {
  it('is encrypted and uploaded by the ordinary media path', async () => {
    const { world, alice, conversationId, fs } = await chat();
    await fs.writeBytes(TEMP_JPEG, JPEG);
    cameraMock.__state.takePicture.mockResolvedValue({
      uri: TEMP_JPEG,
      width: 800,
      height: 600,
      format: 'jpg',
    });
    const read = jest.spyOn(fs, 'readBytes');

    await takePhoto();

    const sent = messages(world, conversationId);
    expect(sent).toHaveLength(1);
    const record = sent[0] ?? {};
    expect(record.kind).toBe('photo');
    const object = record.object as string;
    expect(object.startsWith(`messages/${conversationId}/photo/`)).toBe(true);

    // The object exists, is the length the document claims, and is NOT the plaintext: a nonce and
    // a tag larger, and different in its first byte.
    const blob = world.store.blobs.get(object);
    if (blob === undefined) throw new Error('no object was uploaded');
    expect(blob.length).toBe(record.bytes);
    expect(blob.length).toBe(JPEG.length + 40);
    expect([...blob.slice(24, 24 + JPEG.length)]).not.toEqual([...JPEG]);

    // A preview went up too, under its own object, as it does for every other source.
    const thumb = record.thumbObject as string;
    expect(world.store.blobs.get(thumb)).toBeDefined();

    // The tray has let go, so the send completed rather than merely being attempted.
    expect(screen.queryByTestId('conversation_outgoing')).toBeNull();
    // The pseudo-URI is never dereferenced: the bytes were in hand the whole way.
    expect(read.mock.calls.map((call) => call[0])).not.toContain('camera://photo');
    // Nothing asked the vault for anything -- it was never opened in this test.
    expect(alice.services.vault.current).toBeNull();
    read.mockRestore();
  });

  it('re-encodes one that is over the chat ceiling, rather than refusing it', async () => {
    const { world, alice, conversationId, fs } = await chat();
    // Over 8 MB as captured, and compressible only once the ladder steps below 2048px.
    await fs.writeBytes(TEMP_JPEG, new Uint8Array(MAX_PHOTO_BYTES + 1024));
    (alice.services.thumbnails as FakeThumbnailGenerator).sizeForEdge = (edge) =>
      edge >= 2048 ? MAX_PHOTO_BYTES + 1024 : 2048;
    cameraMock.__state.takePicture.mockResolvedValue({
      uri: TEMP_JPEG,
      width: 4032,
      height: 3024,
      format: 'jpg',
    });

    await takePhoto();

    const record = messages(world, conversationId)[0] ?? {};
    expect(record.kind).toBe('photo');
    // Sent at a reduced size, not refused and not sent over the cap.
    expect(record.bytes).toBe(2048 + 40);
    expect(screen.queryByText(/too large/i)).toBeNull();
  });

  /**
   * Convergence, stated as an equality. If the camera had grown its own upload path, the document
   * it writes would differ from the picker's somewhere -- a missing preview, a different object
   * layout, an extra field. The two records are built by the same function because there is only
   * one function.
   */
  it('writes the same shape of message as one chosen from the library', async () => {
    const { world, conversationId, fs } = await chat();
    await fs.writeBytes(TEMP_JPEG, JPEG);
    cameraMock.__state.takePicture.mockResolvedValue({
      uri: TEMP_JPEG,
      width: 800,
      height: 600,
      format: 'jpg',
    });
    await takePhoto();

    const picked = 'file:///memory/cache/picked.jpg';
    await fs.writeBytes(picked, JPEG);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const picker = require('expo-image-picker') as { launchImageLibraryAsync: jest.Mock };
    picker.launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [{ uri: picked, type: 'image' }],
    });
    await fireEvent.press(screen.getByTestId('conversation_attach'));
    await fireEvent.press(screen.getByTestId('attach_library'));
    await flush();

    const sent = messages(world, conversationId);
    expect(sent).toHaveLength(2);
    const [fromCamera, fromLibrary] = sent;
    expect(Object.keys(fromCamera ?? {}).sort()).toEqual(Object.keys(fromLibrary ?? {}).sort());
    expect(fromCamera?.bytes).toBe(fromLibrary?.bytes);
    expect(fromCamera?.kind).toBe(fromLibrary?.kind);
  });
});

describe('a video recorded in a conversation', () => {
  it('is uploaded, and the plaintext recording is deleted afterwards', async () => {
    const { world, conversationId, fs } = await chat();
    await fs.writeBytes(RECORDING, MP4);
    cameraMock.__state.record.mockResolvedValue({ uri: RECORDING });

    await recordVideo();

    const record = messages(world, conversationId)[0] ?? {};
    expect(record.kind).toBe('video');
    expect(world.store.blobs.get(record.object as string)).toBeDefined();
    // Sent, and then gone: the recording does not outlive the attempt it was handed to.
    await waitFor(async () => {
      expect(await fs.exists(RECORDING)).toBe(false);
    });
  });

  /**
   * The size preflight, reached from the camera. The recording is held to the CHAT's ceiling, and
   * it is held to it from the file's reported length -- a 100 MB clip must be refused without ever
   * becoming a 100 MB buffer in JS.
   */
  it('is refused for its size before a byte of it is read', async () => {
    const { world, alice, conversationId, fs } = await chat();
    await fs.writeBytes(RECORDING, MP4);
    // Reported rather than written: allocating the real thing to prove it is not allocated would
    // be self-defeating.
    jest.spyOn(fs, 'size').mockResolvedValue(MAX_VIDEO_BYTES + 1);
    // Stubbed for the same reason -- the real one would overwrite a notional 100 MB.
    const wipe = jest.spyOn(alice.services.secureDelete, 'file').mockResolvedValue(undefined);
    const read = jest.spyOn(fs, 'readBytes');
    cameraMock.__state.record.mockResolvedValue({ uri: RECORDING });

    await recordVideo();

    expect(read.mock.calls.map((call) => call[0])).not.toContain(RECORDING);
    expect(messages(world, conversationId)).toEqual([]);
    expect([...world.store.blobs.keys()]).toEqual([]);
    expect(
      screen.getByText('This video is too large to send. Please choose a shorter one.'),
    ).toBeTruthy();
    // Nothing a second tap could change, so no retry is offered.
    expect(screen.queryByLabelText('Retry sending video')).toBeNull();
    // Refused is not a reason to leave a plaintext recording on the disk.
    expect(wipe).toHaveBeenCalledWith(RECORDING);
    read.mockRestore();
  });

  /**
   * The cost of deleting the recording, paid out in full. A retryable failure leaves a bubble that
   * invites a second tap, and by then the file is gone -- so the second attempt must say so
   * plainly and withdraw the offer, rather than failing in a way that looks like a dead button.
   */
  it('says to choose it again once the recording it was given has gone', async () => {
    const { world, alice, conversationId, fs } = await chat();
    await fs.writeBytes(RECORDING, MP4);
    cameraMock.__state.record.mockResolvedValue({ uri: RECORDING });
    // One dropped upload: the kind of failure that is worth offering a retry for.
    jest.spyOn(alice.cloud, 'putBlob').mockRejectedValueOnce(new CloudError('unknown'));

    await recordVideo();

    expect(screen.getByLabelText('Retry sending video')).toBeTruthy();
    expect(messages(world, conversationId)).toEqual([]);
    // The recording was deleted when the attempt settled, retry offer or no retry offer.
    await waitFor(async () => {
      expect(await fs.exists(RECORDING)).toBe(false);
    });

    await fireEvent.press(screen.getByLabelText('Retry sending video'));
    await flush();

    expect(screen.getByText(/no longer on this device/i)).toBeTruthy();
    expect(screen.queryByLabelText('Retry sending video')).toBeNull();
    expect(screen.getByText(/not sent/i)).toBeTruthy();
    expect(messages(world, conversationId)).toEqual([]);
  });
});
