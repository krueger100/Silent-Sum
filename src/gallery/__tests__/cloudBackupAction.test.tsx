/**
 * "Back up to Cloud", and everything it must NOT do.
 *
 * The Local Gallery is the master copy: unlimited, device-level, and never uploaded by itself.
 * Nothing reaches an account unless the user picked it here and said so, which is why the action
 * lives behind a selection rather than on the screen at all times.
 *
 * These specs run with no Firebase wired in at all -- the ordinary signed-out build, and the one
 * most SilentSum installs are. The gallery has to work completely in that state, and the backup
 * action has to say why it cannot rather than failing in a way that reads as a broken vault.
 */
import { fireEvent, waitFor } from '@testing-library/react-native';
import React from 'react';

import { GalleryScreen } from '@/gallery/GalleryScreen';
import {
  imageBytes,
  renderInVault,
  unlockedVault,
  type VaultHarness,
} from '@/gallery/__tests__/vaultHarness';
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

describe('backing a selection up to the cloud', () => {
  it('offers the action only once something is selected', async () => {
    const { services } = await withPhotos(2);
    const view = await renderInVault(services, <GalleryScreen />);

    // Nothing selected: the header offers the vault's own actions, not a backup.
    expect(view.queryByTestId('gallery-backup-cloud')).toBeNull();
    expect(view.getByTestId('vault-lock')).toBeTruthy();

    const tiles = view.getAllByTestId('gallery-tile');
    const tile = tiles[0];
    if (tile === undefined) throw new Error('no tile rendered');
    await fireEvent(tile, 'longPress');

    expect(view.getByTestId('gallery-backup-cloud')).toBeTruthy();
  });

  /**
   * The signed-out build. Pressing it must explain itself and upload nothing -- the failure mode
   * that matters is a user believing their photos went somewhere they did not.
   */
  it('says why it cannot, in a build with no cloud, and keeps every photo local', async () => {
    const { services, repository } = await withPhotos(2);
    const view = await renderInVault(services, <GalleryScreen />);

    const tiles = view.getAllByTestId('gallery-tile');
    const tile = tiles[0];
    if (tile === undefined) throw new Error('no tile rendered');
    await fireEvent(tile, 'longPress');
    await fireEvent.press(view.getByTestId('gallery-backup-cloud'));

    await waitFor(() => {
      expect(view.getByTestId('gallery-notice')).toHaveTextContent(/not available in this build/i);
    });
    // The Local Gallery is exactly as it was: nothing uploaded, nothing removed, nothing changed.
    expect(repository.photos).toHaveLength(2);
  });

  /** The selection is spent by the action, the way Delete spends it. */
  it('leaves selection mode once the action has run', async () => {
    const { services } = await withPhotos(2);
    const view = await renderInVault(services, <GalleryScreen />);

    const tiles = view.getAllByTestId('gallery-tile');
    const tile = tiles[0];
    if (tile === undefined) throw new Error('no tile rendered');
    await fireEvent(tile, 'longPress');
    await fireEvent.press(view.getByTestId('gallery-backup-cloud'));

    await waitFor(() => {
      expect(view.queryByTestId('gallery-backup-cloud')).toBeNull();
    });
  });
});

describe('the Local Gallery with no account at all', () => {
  /**
   * The whole offline promise in one spec: no Firebase, no sign-in, no subscription, and the
   * vault still holds and shows everything put in it.
   */
  it('holds and shows photos with no Firebase wired in', async () => {
    const { services, repository, entries } = await withPhotos(5);
    const view = await renderInVault(services, <GalleryScreen />);

    expect(services.backup).toBeNull();
    expect(repository.photos).toHaveLength(5);
    expect(view.getAllByTestId('gallery-tile')).toHaveLength(entries.length);
  });

  /** And there is no cap on it: the free-tier gate is about ADDING through the picker, not this. */
  it('keeps every photo when there are more than a free plan would allow', async () => {
    const { services, repository } = await withPhotos(12);
    const view = await renderInVault(services, <GalleryScreen />);

    expect(repository.photos).toHaveLength(12);
    expect(view.getByTestId('gallery-grid')).toBeTruthy();
  });
});
