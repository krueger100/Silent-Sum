import { waitFor } from '@testing-library/react-native';
import React from 'react';

import { PhotoTile } from '@/gallery/PhotoTile';
import { imageBytes, renderInVault, unlockedVault } from '@/gallery/__tests__/vaultHarness';
import type { Bytes } from '@/utils/bytes';
import { VaultLockedError } from '@/vault/types';

jest.mock('expo-image', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const react = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return {
    Image: (props: Record<string, unknown>) => react.createElement(View, props),
  };
});

const noop = (): void => {};

describe('PhotoTile', () => {
  it('renders the decrypted thumbnail as an in-memory data URI', async () => {
    const { services, repository } = await unlockedVault();
    const entry = await repository.addPhoto({ bytes: imageBytes() }, { source: 'camera' });

    const view = await renderInVault(
      services,
      <PhotoTile
        entry={entry}
        repository={repository}
        size={120}
        selected={false}
        selecting={false}
        onPress={noop}
        onLongPress={noop}
      />,
    );

    await waitFor(() => {
      expect(view.getByTestId('gallery-tile-image')).toBeTruthy();
    });
    const source = view.getByTestId('gallery-tile-image').props.source as
      { uri?: string } | undefined;
    expect(source?.uri?.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('falls back to a placeholder when the vault locks mid-decrypt', async () => {
    const { services, repository } = await unlockedVault();
    const entry = await repository.addPhoto({ bytes: imageBytes() }, { source: 'camera' });
    jest.spyOn(repository, 'readThumbnail').mockRejectedValue(new VaultLockedError());

    const view = await renderInVault(
      services,
      <PhotoTile
        entry={entry}
        repository={repository}
        size={120}
        selected={false}
        selecting={false}
        onPress={noop}
        onLongPress={noop}
      />,
    );

    await waitFor(() => {
      expect(view.queryByTestId('gallery-tile-image')).toBeNull();
    });
    // The tile itself is still there and nothing propagated out of the effect.
    expect(view.getByTestId('gallery-tile')).toBeTruthy();
  });

  it('ignores a decrypt that lands after the tile is unmounted', async () => {
    const { services, repository } = await unlockedVault();
    const entry = await repository.addPhoto({ bytes: imageBytes() }, { source: 'camera' });

    let release: ((bytes: Bytes) => void) | null = null;
    jest.spyOn(repository, 'readThumbnail').mockReturnValue(
      new Promise<Bytes>((resolve) => {
        release = resolve;
      }),
    );
    const consoleError = jest.spyOn(console, 'error').mockImplementation(noop);

    try {
      const view = await renderInVault(
        services,
        <PhotoTile
          entry={entry}
          repository={repository}
          size={120}
          selected={false}
          selecting={false}
          onPress={noop}
          onLongPress={noop}
        />,
      );
      await view.unmount();

      if (release === null) throw new Error('the decrypt never started');
      (release as (bytes: Bytes) => void)(new Uint8Array([1, 2, 3]));
      await Promise.resolve();
      await Promise.resolve();

      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
