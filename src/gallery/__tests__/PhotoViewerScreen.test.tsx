import { fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

import { PhotoViewerScreen } from '@/gallery/PhotoViewerScreen';
import { imageBytes, renderInVault, unlockedVault } from '@/gallery/__tests__/vaultHarness';
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
