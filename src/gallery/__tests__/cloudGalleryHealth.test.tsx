/**
 * What the Cloud Gallery says about a tile it cannot draw.
 *
 * A grey square is the honest picture for "no photo bytes on this device", and it is also three
 * completely different situations wearing the same face:
 *
 *   - the photo is safe in the cloud and this device deleted its copy;
 *   - the cloud's files are missing but this device can put them back;
 *   - the cloud's files are missing and so is the local copy, and nothing recovers it.
 *
 * Only the middle one is fixable and only the last one is bad news, so the screen has to name
 * which it is. These specs are about that naming, and about never showing the reassuring version
 * of the sentence when the app has not actually checked.
 */
import { screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import {
  buildCloudHarness,
  openVaultWithPhotos,
  renderWithServices,
  type CloudHarness,
} from '@/backup/screens/__tests__/harness';
import { BACKUP_PATHS, type BackupService } from '@/backup/types';
import { CloudError } from '@/firebase/types';
import { CloudGalleryScreen } from '@/gallery/CloudGalleryScreen';
import type { VaultRepository } from '@/vault/types';

jest.mock('expo-image', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const react = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  return {
    Image: (props: Record<string, unknown>) => react.createElement(View, props),
  };
});

const PIN = '2468';
const EMAIL = 'vault@example.test';
const ACCOUNT_PASSWORD = 'account-password';
const PASSPHRASE = 'correct horse battery staple';

function requireBackup(harness: CloudHarness): BackupService {
  const backup = harness.services.backup;
  if (backup === null) throw new Error('expected a backup service');
  return backup;
}

function requireRepository(harness: CloudHarness): VaultRepository {
  const repository = harness.services.vault.current;
  if (repository === null) throw new Error('expected an open vault');
  return repository;
}

interface Gallery {
  readonly harness: CloudHarness;
  readonly repository: VaultRepository;
  readonly uid: string;
  readonly ids: readonly string[];
}

/** A signed-in device with `count` photos, every one of them explicitly chosen for the cloud. */
async function galleryWith(count: number): Promise<Gallery> {
  const harness = buildCloudHarness();
  await openVaultWithPhotos(harness, PIN, count);
  await harness.cloud.signUp(EMAIL, ACCOUNT_PASSWORD);
  const backup = requireBackup(harness);
  const keys = harness.services.session.requireKeys();
  await backup.enable(keys, PASSPHRASE);
  const repository = requireRepository(harness);
  const ids = repository.photos.map((photo) => photo.id);
  await backup.backupNow(repository, keys, { ids });
  return { harness, repository, uid: harness.cloud.currentUser?.uid ?? '', ids };
}

function captions(): string[] {
  return screen.queryAllByTestId('gallery-tile-caption').map((node) => {
    const child = node.props.children;
    return typeof child === 'string' ? child : String(child);
  });
}

function pick(ids: readonly string[], at: number): string {
  const id = ids[at];
  if (id === undefined) throw new Error('no photo at that position');
  return id;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('a Cloud Gallery where everything is where it should be', () => {
  it('captions nothing and warns about nothing', async () => {
    const { harness } = await galleryWith(3);

    await renderWithServices(harness.services, <CloudGalleryScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('cloud-gallery-summary')).toBeTruthy();
    });

    expect(captions()).toEqual([]);
    expect(screen.queryByTestId('cloud-gallery-lost')).toBeNull();
    expect(screen.queryByTestId('cloud-gallery-repairable')).toBeNull();
    expect(screen.queryByTestId('cloud-gallery-unchecked')).toBeNull();
  });
});

describe('a photo that is only in the cloud', () => {
  /** The backup doing its job: deleted here, still there. Nothing is wrong and nothing to fix. */
  it('is marked "Cloud only", not as a problem', async () => {
    const { harness, repository, ids } = await galleryWith(2);
    await repository.deletePhotos([pick(ids, 0)]);

    await renderWithServices(harness.services, <CloudGalleryScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('cloud-gallery-summary')).toBeTruthy();
    });

    expect(captions()).toEqual(['Cloud only']);
    expect(screen.queryByTestId('cloud-gallery-lost')).toBeNull();
    expect(screen.queryByTestId('cloud-gallery-repairable')).toBeNull();
  });

  /**
   * And it draws the photo, which is the point of captioning it rather than hiding it.
   *
   * The thumbnail comes from the account's own Storage, decrypted with this vault's thumb key.
   * Before this, the tile fell through to the error placeholder -- so a backup that had done
   * exactly its job looked identical to a corrupt one.
   */
  it('draws its thumbnail from the cloud instead of an error square', async () => {
    const { harness, repository, ids } = await galleryWith(2);
    await repository.deletePhotos([pick(ids, 0)]);

    await renderWithServices(harness.services, <CloudGalleryScreen />);
    await waitFor(() => {
      expect(screen.getAllByTestId('gallery-tile-image')).toHaveLength(2);
    });

    // One tile from the vault, one from the cloud, and no tile claiming to be unreadable.
    expect(screen.queryByTestId('gallery-tile-unavailable')).toBeNull();
    expect(captions()).toEqual(['Cloud only']);
  });

  /** Offline, or Storage refused. A slow network is not a damaged backup and must not look like one. */
  it('keeps a neutral tile when the thumbnail cannot be fetched', async () => {
    const { harness, repository, uid, ids } = await galleryWith(2);
    const absent = pick(ids, 0);
    await repository.deletePhotos([absent]);
    // Listed as present, so the tile is "Cloud only" and does ask -- but the fetch fails. Only
    // that one object: the index comes down the same method, and breaking it would test the
    // "could not list" path instead of this one.
    const realGetBlob = harness.cloud.getBlob.bind(harness.cloud);
    jest.spyOn(harness.cloud, 'getBlob').mockImplementation(async (path: string) => {
      if (path === BACKUP_PATHS.thumb(uid, absent)) throw new CloudError('unavailable');
      return realGetBlob(path);
    });

    await renderWithServices(harness.services, <CloudGalleryScreen />);
    await waitFor(() => {
      expect(screen.getAllByTestId('gallery-tile')).toHaveLength(2);
    });

    expect(captions()).toEqual(['Cloud only']);
    expect(screen.queryByTestId('gallery-tile-unavailable')).toBeNull();
  });
});

describe('a cloud file that went missing', () => {
  it('is marked "Repair" while this device still has the photo', async () => {
    const { harness, uid, ids } = await galleryWith(2);
    harness.cloud.blobs.delete(BACKUP_PATHS.photo(uid, pick(ids, 0)));

    await renderWithServices(harness.services, <CloudGalleryScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('cloud-gallery-repairable')).toBeTruthy();
    });

    expect(captions()).toEqual(['Repair']);
    expect(screen.getByTestId('cloud-gallery-repairable')).toHaveTextContent(
      /this device still has the photos/,
    );
    expect(screen.queryByTestId('cloud-gallery-lost')).toBeNull();
  });

  /**
   * The case this whole change exists for. It used to draw a plain grey square, and "Back up now"
   * went on reporting that nothing needed repairing.
   */
  it('is marked "Lost" and explained once the local copy is gone too', async () => {
    const { harness, repository, uid, ids } = await galleryWith(2);
    const reads = jest.spyOn(harness.services.cloudThumbnails, 'read');
    const gone = pick(ids, 0);
    harness.cloud.blobs.delete(BACKUP_PATHS.photo(uid, gone));
    harness.cloud.blobs.delete(BACKUP_PATHS.thumb(uid, gone));
    await repository.deletePhotos([gone]);

    await renderWithServices(harness.services, <CloudGalleryScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('cloud-gallery-lost')).toBeTruthy();
    });

    expect(captions()).toEqual(['Lost']);
    // Nothing was asked of Storage for it: the listing already said the files are gone, so a
    // request could only 404, and a "Lost" tile has nothing to draw either way.
    expect(reads).not.toHaveBeenCalled();
    expect(screen.getByTestId('gallery-tile-unavailable')).toBeTruthy();
    const panel = screen.getByTestId('cloud-gallery-lost');
    expect(panel).toHaveTextContent(/cannot be recovered/);
    expect(panel).toHaveTextContent(/no copy either/);
    // And it says so without claiming the button will help, which is the thing that misled.
    expect(panel).toHaveTextContent(/cannot put them back/);
    expect(screen.queryByTestId('cloud-gallery-repairable')).toBeNull();
  });

  it('keeps the lost entry listed rather than hiding the problem', async () => {
    const { harness, repository, uid, ids } = await galleryWith(2);
    const gone = pick(ids, 0);
    harness.cloud.blobs.delete(BACKUP_PATHS.photo(uid, gone));
    harness.cloud.blobs.delete(BACKUP_PATHS.thumb(uid, gone));
    await repository.deletePhotos([gone]);

    await renderWithServices(harness.services, <CloudGalleryScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('cloud-gallery-lost')).toBeTruthy();
    });

    expect(screen.getByTestId('cloud-gallery-summary')).toHaveTextContent(/2 items backed up/);
    expect(screen.getAllByTestId('gallery-tile')).toHaveLength(2);
  });
});

describe('a Cloud Gallery that could not reach Storage', () => {
  /**
   * Offline. The list still comes from the index, but nothing on it has been verified, so no tile
   * gets a caption and the screen says why instead of implying everything is fine.
   */
  it('says the check did not run, and captions nothing', async () => {
    const { harness } = await galleryWith(2);
    jest.spyOn(harness.cloud, 'listBlobs').mockRejectedValue(new CloudError('unavailable'));

    await renderWithServices(harness.services, <CloudGalleryScreen />);
    await waitFor(() => {
      expect(screen.getByTestId('cloud-gallery-unchecked')).toBeTruthy();
    });

    expect(screen.getByTestId('cloud-gallery-unchecked')).toHaveTextContent(/has been verified/);
    expect(captions()).toEqual([]);
    expect(screen.queryByTestId('cloud-gallery-lost')).toBeNull();
    expect(screen.getAllByTestId('gallery-tile')).toHaveLength(2);
  });
});
