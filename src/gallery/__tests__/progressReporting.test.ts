/**
 * Counting the two vault operations that run long: adding and deleting.
 *
 * Neither used to say anything. Importing a page of photos showed a spinner, and deleting showed
 * nothing at all -- not even a busy state -- while secure erasure overwrote every file before
 * unlinking it. Both are now counted, and the counting has one rule worth pinning down: an item
 * the user waited for is DONE whether it succeeded or not. An oversized photo and an undecodable
 * one are both refused, and a bar that stopped counting them would stall on exactly the selection
 * that is already going badly.
 */
import { MAX_ITEM_BYTES } from '@/billing/entitlements';
import {
  ImportService,
  type ImportServiceDependencies,
  type PickMedia,
} from '@/gallery/importService';
import { imageBytes, unlockedVault, UNDECODABLE } from '@/gallery/__tests__/vaultHarness';
import type { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import type { Services } from '@/app/services';
import type { PickedMedia } from '../../../modules/vault-media';
import type { ProgressReport } from '@/utils/progress';

function deps(services: Services, pickMedia: PickMedia): ImportServiceDependencies {
  return {
    fs: services.fs,
    secureDelete: services.secureDelete,
    autoLockSuspension: services.autoLockSuspension,
    pickMedia,
  };
}

function asset(uri: string, fileName: string, overrides: Partial<PickedMedia> = {}): PickedMedia {
  return {
    uri,
    documentUri: `content://documents/${fileName}`,
    fileName,
    fileSize: null,
    mimeType: 'image/jpeg',
    deletable: true,
    ...overrides,
  };
}

async function stageTempCopy(
  fs: InMemoryFileSystem,
  name: string,
  firstByte = 0x01,
): Promise<PickedMedia> {
  const uri = `${fs.cacheDirectory}/vault-import/${name}`;
  await fs.writeBytes(uri, imageBytes(firstByte));
  return asset(uri, name);
}

/** Every (done, total) pair an operation emitted, in order. */
function recorder(): { readonly calls: [number, number][]; readonly onProgress: ProgressReport } {
  const calls: [number, number][] = [];
  return {
    calls,
    onProgress: (done, total) => {
      calls.push([done, total]);
    },
  };
}

describe('counting an import', () => {
  it('reports one step per picked asset, starting at zero', async () => {
    const { services, fs, repository } = await unlockedVault();
    const picked = [
      await stageTempCopy(fs, 'a.jpg'),
      await stageTempCopy(fs, 'b.jpg', 0x20),
      await stageTempCopy(fs, 'c.jpg', 0x30),
    ];
    const service = new ImportService(deps(services, async () => picked));
    const { calls, onProgress } = recorder();

    const report = await service.importFromLibrary(repository, { onProgress });

    expect(report.imported).toBe(3);
    expect(calls).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  /** Refused, but still one of the items the user is waiting on. */
  it('counts an oversized asset it never reads', async () => {
    const { services, fs, repository } = await unlockedVault();
    const big = asset('content://huge.jpg', 'huge.jpg', { fileSize: MAX_ITEM_BYTES + 1 });
    const good = await stageTempCopy(fs, 'ok.jpg');
    const service = new ImportService(deps(services, async () => [big, good]));
    const { calls, onProgress } = recorder();

    const report = await service.importFromLibrary(repository, { onProgress });

    expect(report).toMatchObject({ imported: 1, oversized: 1 });
    expect(calls[calls.length - 1]).toEqual([2, 2]);
  });

  it('counts an asset that could not be decoded', async () => {
    const { services, fs, repository } = await unlockedVault();
    const broken = await stageTempCopy(fs, 'broken.jpg', UNDECODABLE);
    const good = await stageTempCopy(fs, 'fine.jpg');
    const service = new ImportService(deps(services, async () => [broken, good]));
    const { calls, onProgress } = recorder();

    const report = await service.importFromLibrary(repository, { onProgress });

    expect(report).toMatchObject({ imported: 1, failed: 1 });
    expect(calls[calls.length - 1]).toEqual([2, 2]);
  });

  it('says nothing was picked rather than leaving the bar unexplained', async () => {
    const { services, repository } = await unlockedVault();
    const service = new ImportService(deps(services, async () => []));
    const { calls, onProgress } = recorder();

    await service.importFromLibrary(repository, { onProgress });

    expect(calls).toEqual([[0, 0]]);
  });

  it('never goes backwards and never passes the total', async () => {
    const { services, fs, repository } = await unlockedVault();
    const picked: PickedMedia[] = [];
    for (let i = 0; i < 5; i++) picked.push(await stageTempCopy(fs, `p${String(i)}.jpg`, 0x10 + i));
    const service = new ImportService(deps(services, async () => picked));
    const { calls, onProgress } = recorder();

    await service.importFromLibrary(repository, { onProgress });

    let previous = -1;
    for (const [done, total] of calls) {
      expect(done).toBeGreaterThan(previous);
      expect(done).toBeLessThanOrEqual(total);
      previous = done;
    }
    expect(previous).toBe(5);
  });
});

describe('counting a delete', () => {
  it('reports one step per photo erased', async () => {
    const { repository } = await unlockedVault();
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const photo = await repository.addPhoto({ bytes: imageBytes(0x40 + i) }, { source: 'camera' });
      ids.push(photo.id);
    }
    const { calls, onProgress } = recorder();

    await repository.deletePhotos(ids, onProgress);

    expect(repository.photos).toHaveLength(0);
    expect(calls).toEqual([
      [0, 4],
      [1, 4],
      [2, 4],
      [3, 4],
      [4, 4],
    ]);
  });

  it('counts only what was asked for, not the whole vault', async () => {
    const { repository } = await unlockedVault();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const photo = await repository.addPhoto({ bytes: imageBytes(0x50 + i) }, { source: 'camera' });
      ids.push(photo.id);
    }
    const { calls, onProgress } = recorder();

    await repository.deletePhotos(ids.slice(0, 2), onProgress);

    expect(repository.photos).toHaveLength(4);
    expect(calls).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
  });

  /** Deleting nothing does nothing, including to the bar. */
  it('reports nothing at all for an empty selection', async () => {
    const { repository } = await unlockedVault();
    await repository.addPhoto({ bytes: imageBytes(0x60) }, { source: 'camera' });
    const { calls, onProgress } = recorder();

    await repository.deletePhotos([], onProgress);

    expect(calls).toEqual([]);
    expect(repository.photos).toHaveLength(1);
  });
});
