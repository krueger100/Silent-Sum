import { fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

import { GalleryScreen } from '@/gallery/GalleryScreen';
import {
  buildServices,
  imageBytes,
  renderInVault,
  unlockedVault,
  type VaultHarness,
} from '@/gallery/__tests__/vaultHarness';
import { utf8Encode } from '@/utils/bytes';
import type { PhotoEntry } from '@/vault/types';

jest.mock('expo-image-picker', () => ({ launchImageLibraryAsync: jest.fn() }));

jest.mock('expo-image', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const react = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return {
    Image: (props: Record<string, unknown>) => react.createElement(View, props),
  };
});

async function withPhotos(count: number): Promise<VaultHarness & { entries: PhotoEntry[] }> {
  const harness = await unlockedVault();
  const entries: PhotoEntry[] = [];
  for (let i = 0; i < count; i++) {
    entries.push(
      await harness.repository.addPhoto({ bytes: imageBytes(0x10 + i) }, { source: 'camera' }),
    );
  }
  return { ...harness, entries };
}

describe('GalleryScreen', () => {
  it('renders a tile per photo, newest first', async () => {
    const { services, entries } = await withPhotos(3);
    const view = await renderInVault(services, <GalleryScreen />);

    await waitFor(() => {
      expect(view.getAllByTestId('gallery-tile-image')).toHaveLength(3);
    });
    expect(view.getAllByTestId('gallery-tile')).toHaveLength(3);
    // The store hands the list back newest first; the grid does not reorder it.
    const newest = entries[entries.length - 1];
    expect(services.vault.store.getState().photos[0]?.id).toBe(newest?.id);
  });

  it('renders the empty state and no grid when the vault holds nothing', async () => {
    const { services } = await unlockedVault();
    const view = await renderInVault(services, <GalleryScreen />);

    expect(view.getByTestId('gallery-empty')).toBeTruthy();
    expect(view.queryByTestId('gallery-grid')).toBeNull();
    expect(view.getByTestId('gallery-camera')).toBeTruthy();
    expect(view.getByTestId('gallery-import')).toBeTruthy();
  });

  it('long-press starts multi-select and delete removes exactly the selected ids', async () => {
    const { services, repository, entries } = await withPhotos(3);
    const deletePhotos = jest.spyOn(repository, 'deletePhotos');
    const view = await renderInVault(services, <GalleryScreen />);

    await waitFor(() => {
      expect(view.getAllByTestId('gallery-tile-image')).toHaveLength(3);
    });

    const tiles = view.getAllByTestId('gallery-tile');
    const first = tiles[0];
    const second = tiles[1];
    if (first === undefined || second === undefined) throw new Error('missing tiles');

    await fireEvent(first, 'longPress');
    expect(view.getByText('1 selected')).toBeTruthy();
    await fireEvent.press(second);
    expect(view.getByText('2 selected')).toBeTruthy();

    await fireEvent.press(view.getByTestId('gallery-delete'));
    await fireEvent.press(view.getByTestId('gallery-delete-confirm-confirm'));

    expect(deletePhotos).toHaveBeenCalledTimes(1);
    const [ids] = deletePhotos.mock.calls[0] ?? [];
    expect([...(ids ?? [])].sort()).toEqual([entries[2]?.id, entries[1]?.id].sort());

    // The grid refreshes from the store push, with no reload of its own.
    await waitFor(() => {
      expect(view.getAllByTestId('gallery-tile')).toHaveLength(1);
    });
    expect(view.queryByText('2 selected')).toBeNull();
    expect(services.vault.store.getState().photos).toHaveLength(1);
  });

  it('select all then cancel leaves the selection empty', async () => {
    const { services } = await withPhotos(2);
    const view = await renderInVault(services, <GalleryScreen />);

    await waitFor(() => {
      expect(view.getAllByTestId('gallery-tile-image')).toHaveLength(2);
    });

    const tiles = view.getAllByTestId('gallery-tile');
    const first = tiles[0];
    if (first === undefined) throw new Error('missing tile');
    await fireEvent(first, 'longPress');
    await fireEvent.press(view.getByTestId('gallery-select-all'));
    expect(view.getByText('2 selected')).toBeTruthy();

    await fireEvent.press(view.getByTestId('screen-back'));
    expect(view.queryByText('2 selected')).toBeNull();
    expect(view.getByTestId('vault-lock')).toBeTruthy();
  });

  it('opens the viewer for the tapped photo when not selecting', async () => {
    const { services, entries } = await withPhotos(2);
    const onOpenPhoto = jest.fn();
    const view = await renderInVault(services, <GalleryScreen onOpenPhoto={onOpenPhoto} />);

    await waitFor(() => {
      expect(view.getAllByTestId('gallery-tile-image')).toHaveLength(2);
    });
    const tiles = view.getAllByTestId('gallery-tile');
    const first = tiles[0];
    if (first === undefined) throw new Error('missing tile');
    await fireEvent.press(first);

    expect(onOpenPhoto).toHaveBeenCalledTimes(1);
    expect(onOpenPhoto.mock.calls[0]?.[1]).toBe(0);
    expect((onOpenPhoto.mock.calls[0]?.[0] as PhotoEntry | undefined)?.id).toBe(entries[1]?.id);
  });

  it('locks the session from the header', async () => {
    const { services } = await withPhotos(1);
    const view = await renderInVault(services, <GalleryScreen />);

    await waitFor(() => {
      expect(view.getAllByTestId('gallery-tile-image')).toHaveLength(1);
    });

    await fireEvent.press(view.getByTestId('vault-lock'));

    expect(services.session.isUnlocked).toBe(false);
    await waitFor(() => {
      expect(services.vault.current).toBeNull();
    });
  });

  it('shows the error path, not the grid, when the vault data cannot be read', async () => {
    const { services, fs } = buildServices();
    const keys = await services.auth.setupPin('1234');
    services.session.adopt(keys);
    // A foreign index: the files exist but do not decrypt with this session's keys.
    await fs.writeBytes(services.paths.index, utf8Encode('not a vault index'));
    await expect(services.vault.open(keys)).rejects.toThrow();
    expect(services.vault.store.getState().unreadable).toBe(true);

    const view = await renderInVault(services, <GalleryScreen />);

    expect(view.getByTestId('gallery-unreadable')).toBeTruthy();
    expect(view.queryByTestId('gallery-grid')).toBeNull();
    expect(view.queryByTestId('gallery-camera')).toBeNull();
    expect(view.getByText('Vault data cannot be read')).toBeTruthy();
  });

  it('erases the vault and locks the session from the unreadable state', async () => {
    const { services, fs } = buildServices();
    const keys = await services.auth.setupPin('1234');
    services.session.adopt(keys);
    await fs.writeBytes(services.paths.index, utf8Encode('not a vault index'));
    await expect(services.vault.open(keys)).rejects.toThrow();
    await services.settings.update({ onboardingDone: true });
    // A decrypted video a killed session never got to clean up. The narrower erase this screen
    // used to run left it behind; the shared wipe does not.
    const playback = await services.playbackScratch.allocate();
    await fs.writeBytes(playback, utf8Encode('decrypted frames'));

    const view = await renderInVault(services, <GalleryScreen />);
    await fireEvent.press(view.getByTestId('gallery-erase-vault'));
    await fireEvent.changeText(view.getByTestId('typed-confirm-input'), 'ERASE');
    await fireEvent.press(view.getByTestId('gallery-erase-confirm-confirm'));

    await waitFor(async () => {
      expect(await services.auth.isConfigured()).toBe(false);
    });
    expect(services.session.isUnlocked).toBe(false);
    expect(await fs.exists(services.paths.index)).toBe(false);
    expect(await fs.exists(playback)).toBe(false);
    expect(services.settings.current.onboardingDone).toBe(false);
  });
});
