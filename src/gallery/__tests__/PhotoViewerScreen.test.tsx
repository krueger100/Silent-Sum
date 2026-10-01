import { fireEvent, waitFor, type RenderResult } from '@testing-library/react-native';
import React from 'react';

import { PhotoViewerScreen } from '@/gallery/PhotoViewerScreen';
import { imageBytes, renderInVault, unlockedVault } from '@/gallery/__tests__/vaultHarness';
import type { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import type { GalleryWriter } from '@/gallery/galleryExport';
import type { PhotoEntry, VaultRepository } from '@/vault/types';
import type { Services } from '@/app/services';

jest.mock('expo-image', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const react = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return {
    Image: (props: Record<string, unknown>) => react.createElement(View, props),
  };
});

async function withPhotos(count: number): Promise<{
  services: Services;
  repository: VaultRepository;
  entries: PhotoEntry[];
}> {
  const { services, repository } = await unlockedVault();
  const entries: PhotoEntry[] = [];
  for (let i = 0; i < count; i++) {
    entries.push(await repository.addPhoto({ bytes: imageBytes(0x20 + i) }, { source: 'camera' }));
  }
  return { services, repository, entries };
}

describe('PhotoViewerScreen', () => {
  it('opens on the requested photo and reports its position', async () => {
    const { services, entries } = await withPhotos(3);
    // Newest first: the first added photo sits at the end of the list.
    const oldest = entries[0];
    const view = await renderInVault(
      services,
      <PhotoViewerScreen initialPhotoId={oldest?.id ?? ''} />,
    );

    expect(view.getByText('3 of 3')).toBeTruthy();
    await waitFor(() => {
      expect(view.getAllByTestId('viewer-page-image').length).toBeGreaterThan(0);
    });
  });

  it('decrypts only the current page and its neighbours', async () => {
    const { services, repository } = await withPhotos(5);
    const readFullImage = jest.spyOn(repository, 'readFullImage');

    const view = await renderInVault(services, <PhotoViewerScreen initialIndex={0} />);

    await waitFor(() => {
      expect(view.getAllByTestId('viewer-page')).toHaveLength(5);
    });
    await waitFor(() => {
      expect(readFullImage).toHaveBeenCalledTimes(2);
    });
    // Page 0 and page 1 only: the other three pages stay ciphertext.
    expect(readFullImage).toHaveBeenCalledTimes(2);
  });

  it('shows capture details for the current photo', async () => {
    const { services } = await withPhotos(1);
    const view = await renderInVault(services, <PhotoViewerScreen initialIndex={0} />);

    await fireEvent.press(view.getByTestId('viewer-details'));

    expect(view.getByTestId('viewer-details-sheet')).toBeTruthy();
    expect(view.getByText('1200 × 900')).toBeTruthy();
    expect(view.getByText('256 B')).toBeTruthy();
    expect(view.getByText('Camera')).toBeTruthy();
    expect(view.getByText('Encrypted on this device')).toBeTruthy();
  });

  it('deletes the current photo after confirmation and closes on the last one', async () => {
    const { services, repository, entries } = await withPhotos(1);
    const deletePhotos = jest.spyOn(repository, 'deletePhotos');
    const onClose = jest.fn();
    const view = await renderInVault(
      services,
      <PhotoViewerScreen initialIndex={0} onClose={onClose} />,
    );

    await fireEvent.press(view.getByTestId('viewer-delete'));
    await fireEvent.press(view.getByTestId('viewer-delete-confirm-confirm'));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(deletePhotos).toHaveBeenCalledWith([entries[0]?.id]);
    await waitFor(() => {
      expect(services.vault.store.getState().photos).toHaveLength(0);
    });
  });

  it('renders a neutral message instead of a page when the vault is locked', async () => {
    const { services } = await withPhotos(2);
    services.session.lock();

    const view = await renderInVault(services, <PhotoViewerScreen initialIndex={0} />);

    expect(view.queryByTestId('viewer-pager')).toBeNull();
    expect(view.getByText('This item is no longer available.')).toBeTruthy();
  });
});

describe('PhotoViewerScreen saving to the gallery', () => {
  function recordingWriter(grant = true): {
    writer: GalleryWriter;
    handed: string[];
    bytesAtSave: (Uint8Array | null)[];
    fs: { current: InMemoryFileSystem | null };
  } {
    const handed: string[] = [];
    const bytesAtSave: (Uint8Array | null)[] = [];
    const held: { current: InMemoryFileSystem | null } = { current: null };
    return {
      handed,
      bytesAtSave,
      fs: held,
      writer: {
        requestWriteAccess: () => Promise.resolve(grant),
        save: async (uri) => {
          handed.push(uri);
          // Captured here because the whole point of the export is that this file stops
          // existing the moment the gallery has it.
          const disk = held.current;
          bytesAtSave.push(disk === null ? null : await disk.readBytes(uri).catch(() => null));
        },
      },
    };
  }

  async function viewerWithWriter(grant = true): Promise<{
    view: RenderResult;
    services: Services;
    recorder: ReturnType<typeof recordingWriter>;
  }> {
    const recorder = recordingWriter(grant);
    const { services, repository, fs: disk } = await unlockedVault(undefined, undefined, {
      galleryWriter: recorder.writer,
    });
    recorder.fs.current = disk;
    await repository.addPhoto({ bytes: imageBytes(0x41) }, { source: 'camera' });
    const view = await renderInVault(services, <PhotoViewerScreen initialIndex={0} />);
    return { view, services, recorder };
  }

  it('offers Save in the header without touching the gallery until it is confirmed', async () => {
    const { view, recorder } = await viewerWithWriter();

    await fireEvent.press(view.getByTestId('viewer-save'));

    expect(view.getByTestId('viewer-save-confirm')).toBeTruthy();
    expect(recorder.handed).toEqual([]);
  });

  it('writes nothing when the confirmation is dismissed', async () => {
    const { view, recorder } = await viewerWithWriter();

    await fireEvent.press(view.getByTestId('viewer-save'));
    await fireEvent.press(view.getByTestId('viewer-save-confirm-cancel'));

    expect(recorder.handed).toEqual([]);
  });

  it('hands the gallery a decrypted file, then leaves no plaintext behind', async () => {
    const { view, services, recorder } = await viewerWithWriter();

    await fireEvent.press(view.getByTestId('viewer-save'));
    await fireEvent.press(view.getByTestId('viewer-save-confirm-confirm'));

    await waitFor(() => {
      expect(recorder.handed).toHaveLength(1);
    });
    const handed = recorder.handed[0] ?? '';
    // MediaStore types the asset from the extension, so a photo must not arrive as .mp4.
    expect(handed.endsWith('.jpg')).toBe(true);
    // It really was plaintext at the moment the gallery took it...
    expect(recorder.bytesAtSave[0]).toEqual(imageBytes(0x41));
    // ...and it is gone now.
    await waitFor(() => {
      expect(services.playbackScratch.outstanding).toEqual([]);
    });
    await expect(services.fs.exists(handed)).resolves.toBe(false);
  });

  it('says so, rather than claiming success, when the gallery is refused', async () => {
    const { view, recorder } = await viewerWithWriter(false);

    await fireEvent.press(view.getByTestId('viewer-save'));
    await fireEvent.press(view.getByTestId('viewer-save-confirm-confirm'));

    await waitFor(() => {
      expect(view.getByTestId('viewer-save-result')).toBeTruthy();
    });
    expect(view.getByText(/Nothing left the vault/)).toBeTruthy();
    expect(recorder.handed).toEqual([]);
  });
});
