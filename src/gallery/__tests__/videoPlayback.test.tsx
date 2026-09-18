/**
 * Watching a vault video.
 *
 * The viewer is where the vault's one concession to the platform lives: a video has to become a
 * real file before anything can play it. What these specs hold to is that the file exists only
 * while the page does, that the player is pointed at that file and nothing else, and that the
 * escape hatch which would survive leaving the app -- picture-in-picture -- is off.
 */
import { fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

import { PhotoViewerScreen } from '@/gallery/PhotoViewerScreen';
import { PhotoTile } from '@/gallery/PhotoTile';
import {
  renderInVault,
  unlockedVault,
  videoBytes,
  type VaultHarness,
} from '@/gallery/__tests__/vaultHarness';
import { PLAYBACK_DIRECTORY_NAME } from '@/vault/playbackScratch';
import { containsSequence, utf8Encode } from '@/utils/bytes';
import type { PhotoEntry } from '@/vault/types';

const RECORDING_URI = 'file:///memory/cache/Camera/clip.mp4';

async function vaultWithVideo(): Promise<VaultHarness & { entry: PhotoEntry }> {
  const harness = await unlockedVault();
  await harness.fs.writeBytes(RECORDING_URI, videoBytes(3000));
  const entry = await harness.repository.addVideo(
    { uri: RECORDING_URI, durationMs: 65_000 },
    { source: 'camera' },
  );
  await harness.fs.deleteFile(RECORDING_URI);
  return { ...harness, entry };
}

function playbackFiles(harness: VaultHarness): string[] {
  return [...harness.fs.allFiles.keys()].filter((uri) =>
    uri.includes(`/${PLAYBACK_DIRECTORY_NAME}/`),
  );
}

describe('a video in the gallery', () => {
  it('is marked as a video on its tile, with its length', async () => {
    const harness = await vaultWithVideo();
    const view = await renderInVault(
      harness.services,
      <PhotoTile
        entry={harness.entry}
        repository={harness.repository}
        size={120}
        selected={false}
        selecting={false}
        onPress={() => undefined}
        onLongPress={() => undefined}
      />,
    );

    // The poster frame decrypts through the ordinary thumbnail path...
    await view.findByTestId('gallery-tile-image');
    // ...and the badge is what makes it recognisable as something you press play on.
    expect(view.getByTestId('gallery-tile-duration')).toHaveTextContent('1:05');
    expect(view.getByLabelText('Video')).toBeTruthy();
  });
});

describe('the viewer on a video', () => {
  it('decrypts to the playback directory and plays from there', async () => {
    const harness = await vaultWithVideo();
    const view = await renderInVault(
      harness.services,
      <PhotoViewerScreen initialPhotoId={harness.entry.id} />,
    );

    const surface = await view.findByTestId('viewer-page-video');
    const files = playbackFiles(harness);
    expect(files).toHaveLength(1);

    // The player is pointed at the decrypted scratch file, not at a vault blob and not at a URL.
    const source = surface.props.accessibilityValue?.text as string;
    expect(source).toBe(files[0]);
    expect(source.startsWith(`${harness.fs.cacheDirectory}/${PLAYBACK_DIRECTORY_NAME}/`)).toBe(
      true,
    );

    // Picture-in-picture is refused in both forms: a system PiP window is drawn outside the app,
    // where FLAG_SECURE does not apply. The shim reports either being on as `disabled`.
    expect(surface.props.accessibilityState?.disabled).toBe(false);
  });

  it('releases the decrypted file when the page goes away', async () => {
    const harness = await vaultWithVideo();
    const view = await renderInVault(
      harness.services,
      <PhotoViewerScreen initialPhotoId={harness.entry.id} />,
    );
    await view.findByTestId('viewer-page-video');
    const [file] = playbackFiles(harness);
    if (file === undefined) throw new Error('expected a decrypted file');
    const stored = harness.fs.peek(file);
    if (stored === undefined) throw new Error('expected the decrypted bytes');

    view.unmount();

    await waitFor(() => {
      expect(playbackFiles(harness)).toEqual([]);
    });
    // Overwritten before it was unlinked, like every other plaintext this app touches.
    expect(containsSequence(stored, utf8Encode('ftypisom'))).toBe(false);
  });

  it('releases the decrypted file when the video is deleted', async () => {
    const harness = await vaultWithVideo();
    const view = await renderInVault(
      harness.services,
      <PhotoViewerScreen initialPhotoId={harness.entry.id} onClose={() => undefined} />,
    );
    await view.findByTestId('viewer-page-video');
    expect(playbackFiles(harness)).toHaveLength(1);

    fireEvent.press(view.getByTestId('viewer-delete'));
    expect(await view.findByText('Delete video?')).toBeTruthy();
    await fireEvent.press(view.getByTestId('viewer-delete-confirm-confirm'));

    await waitFor(() => {
      expect(harness.repository.photos).toEqual([]);
    });
    await waitFor(() => {
      expect(playbackFiles(harness)).toEqual([]);
    });
  });

  it('shows the length and the kind in the details sheet', async () => {
    const harness = await vaultWithVideo();
    const view = await renderInVault(
      harness.services,
      <PhotoViewerScreen initialPhotoId={harness.entry.id} />,
    );
    await view.findByTestId('viewer-page-video');

    fireEvent.press(view.getByTestId('viewer-details'));
    await view.findByTestId('viewer-details-sheet');
    expect(view.getByText('Video')).toBeTruthy();
    expect(view.getByText('1:05')).toBeTruthy();
    expect(view.getByText('Encrypted on this device')).toBeTruthy();
  });

  it('reports a failure instead of playing something it could not decrypt', async () => {
    const harness = await vaultWithVideo();
    // As if the blob had been corrupted on disk.
    await harness.fs.writeBytes(
      harness.services.paths.photoFile(harness.entry.id),
      new Uint8Array(64),
    );

    const view = await renderInVault(
      harness.services,
      <PhotoViewerScreen initialPhotoId={harness.entry.id} />,
    );

    expect(await view.findByText('This video could not be decrypted.')).toBeTruthy();
    expect(view.queryByTestId('viewer-page-video')).toBeNull();
    // And no half-written file was left where a player could reach it.
    expect(playbackFiles(harness)).toEqual([]);
  });
});
