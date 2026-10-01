import type { Services } from '@/app/services';
import { MAX_ITEM_BYTES } from '@/billing/entitlements';
import {
  ImportService,
  type ImportServiceDependencies,
  type PickMedia,
} from '@/gallery/importService';
import { imageBytes, unlockedVault, UNDECODABLE } from '@/gallery/__tests__/vaultHarness';
import type { FileSystem } from '@/storage/fileSystem';
import type { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import type { Bytes } from '@/utils/bytes';
import type { PickedMedia, PickMediaOptions } from '../../../modules/vault-media';

function deps(
  services: Services,
  pickMedia: PickMedia,
  fs?: Pick<FileSystem, 'readBytes'>,
): ImportServiceDependencies {
  return {
    fs: fs ?? services.fs,
    secureDelete: services.secureDelete,
    autoLockSuspension: services.autoLockSuspension,
    pickMedia,
  };
}

function asset(uri: string, fileName: string, overrides: Partial<PickedMedia> = {}): PickedMedia {
  return {
    uri,
    // The handle the system issued when the user chose this item: the only thing a deletion may
    // act on, and deliberately unrelated to where the cache copy happens to live.
    documentUri: `content://documents/${fileName}`,
    fileName,
    fileSize: null,
    mimeType: 'image/jpeg',
    deletable: true,
    ...overrides,
  };
}

/** Puts a plaintext "picker copy" on the fake disk, exactly as the real module would. */
async function stageTempCopy(
  fs: InMemoryFileSystem,
  name: string,
  firstByte = 0x01,
): Promise<PickedMedia> {
  const uri = `${fs.cacheDirectory}/vault-import/${name}`;
  await fs.writeBytes(uri, imageBytes(firstByte));
  return asset(uri, name);
}

describe('ImportService', () => {
  it('imports the readable assets, counts the undecodable one, and wipes every temp copy', async () => {
    const { services, fs, repository } = await unlockedVault();
    const first = await stageTempCopy(fs, 'a.jpg');
    const broken = await stageTempCopy(fs, 'b.jpg', UNDECODABLE);
    const last = await stageTempCopy(fs, 'c.jpg');

    const service = new ImportService(deps(services, async () => [first, broken, last]));

    const report = await service.importFromLibrary(repository);

    expect(report).toEqual({ imported: 2, failed: 1, oversized: 0, removed: 0, overLimit: 0 });
    expect(repository.photos).toHaveLength(2);
    for (const picked of [first, broken, last]) {
      expect(await fs.exists(picked.uri)).toBe(false);
    }
  });

  it('refuses an oversized asset without reading it', async () => {
    const { services, fs, repository } = await unlockedVault();
    const readBytes = jest.fn();
    const staged = await stageTempCopy(fs, 'huge.jpg');
    const picked = { ...staged, fileSize: MAX_ITEM_BYTES + 1 };
    const service = new ImportService(deps(services, async () => [picked], { readBytes }));

    const report = await service.importFromLibrary(repository);

    expect(report).toEqual({ imported: 0, failed: 0, oversized: 1, removed: 0, overLimit: 0 });
    // The point of the check: a 500 MB file must not be pulled into memory to be refused.
    expect(readBytes).not.toHaveBeenCalled();
    // And it is still cleaned up -- a refused asset leaves no plaintext copy behind.
    expect(await fs.exists(picked.uri)).toBe(false);
  });

  it('imports an asset whose size the picker did not report', async () => {
    // Some providers omit the size. An unknown size is not evidence of a large one.
    const { services, fs, repository } = await unlockedVault();
    const staged = await stageTempCopy(fs, 'ok.jpg');
    const service = new ImportService(deps(services, async () => [staged]));

    const report = await service.importFromLibrary(repository);

    expect(report.imported).toBe(1);
    expect(report.oversized).toBe(0);
  });

  it('refuses only the oversized asset and imports the rest of the selection', async () => {
    const { services, fs, repository } = await unlockedVault();
    const small = await stageTempCopy(fs, 'small.jpg');
    const huge = { ...(await stageTempCopy(fs, 'huge.jpg')), fileSize: MAX_ITEM_BYTES + 1 };
    const service = new ImportService(deps(services, async () => [small, huge]));

    const report = await service.importFromLibrary(repository);

    expect(report).toEqual({ imported: 1, failed: 0, oversized: 1, removed: 0, overLimit: 0 });
    expect(repository.photos).toHaveLength(1);
  });

  it('accepts an asset exactly at the cap', async () => {
    const { services, fs, repository } = await unlockedVault();
    const staged = await stageTempCopy(fs, 'exact.jpg');
    const picked = { ...staged, fileSize: MAX_ITEM_BYTES };
    const service = new ImportService(deps(services, async () => [picked]));

    const report = await service.importFromLibrary(repository);

    expect(report).toEqual({ imported: 1, failed: 0, oversized: 0, removed: 0, overLimit: 0 });
  });

  it('wipes every temp copy even when an asset fails for a reason other than decoding', async () => {
    const { services, fs, repository } = await unlockedVault();
    const first = await stageTempCopy(fs, 'a.jpg');
    const missing = asset(`${fs.cacheDirectory}/vault-import/gone.jpg`, 'gone.jpg');
    const last = await stageTempCopy(fs, 'c.jpg');

    const service = new ImportService(deps(services, async () => [first, missing, last]));

    await expect(service.importFromLibrary(repository)).rejects.toThrow();

    // The abort happened on the second asset, but the untouched third one's copy is gone too.
    expect(await fs.exists(first.uri)).toBe(false);
    expect(await fs.exists(last.uri)).toBe(false);
  });

  it('suspends auto-lock exactly once, for the picker round trip only', async () => {
    const { services, fs, repository } = await unlockedVault();
    const picked = await stageTempCopy(fs, 'a.jpg');

    const suspend = jest.spyOn(services.autoLockSuspension, 'suspend');
    const resume = jest.spyOn(services.autoLockSuspension, 'resume');
    let suspendedWhilePickerOpen = false;

    const service = new ImportService(
      deps(services, async () => {
        suspendedWhilePickerOpen = services.autoLockSuspension.isSuspended;
        return [picked];
      }),
    );

    await service.importFromLibrary(repository);

    expect(suspendedWhilePickerOpen).toBe(true);
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(services.autoLockSuspension.count).toBe(0);
  });

  it('resumes auto-lock when the picker throws', async () => {
    const { services, repository } = await unlockedVault();
    const service = new ImportService(
      deps(services, () => Promise.reject(new Error('picker blew up'))),
    );

    await expect(service.importFromLibrary(repository)).rejects.toThrow('picker blew up');
    expect(services.autoLockSuspension.count).toBe(0);
  });

  it('asks the picker for images and videos, and for more than one', async () => {
    const { services, repository } = await unlockedVault();
    const calls: PickMediaOptions[] = [];

    const service = new ImportService(
      deps(services, async (options) => {
        calls.push(options);
        return [];
      }),
    );

    const report = await service.importFromLibrary(repository);

    expect(report).toEqual({ imported: 0, failed: 0, oversized: 0, removed: 0, overLimit: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.allowsMultipleSelection).toBe(true);
    expect(calls[0]?.mimeTypes).toEqual(['image/*', 'video/*']);
  });

  it('asks for a single item when the free tier has room for exactly one', async () => {
    const { services, repository } = await unlockedVault();
    const calls: PickMediaOptions[] = [];
    const service = new ImportService(
      deps(services, async (options) => {
        calls.push(options);
        return [];
      }),
    );

    await service.importFromLibrary(repository, { selectionLimit: 1 });

    expect(calls[0]?.allowsMultipleSelection).toBe(false);
  });

  it('zeroes the plaintext buffer it read for each asset', async () => {
    const { services, fs, repository } = await unlockedVault();
    const picked = await stageTempCopy(fs, 'a.jpg');
    const handedOut: Bytes[] = [];

    const service = new ImportService(
      deps(services, async () => [picked], {
        readBytes: async (uri: string) => {
          const bytes = await fs.readBytes(uri);
          handedOut.push(bytes);
          return bytes;
        },
      }),
    );

    await service.importFromLibrary(repository);

    expect(handedOut).toHaveLength(1);
    for (const buffer of handedOut) {
      expect(buffer.every((byte) => byte === 0)).toBe(true);
    }
  });
});

describe('ImportService selection limit', () => {
  it('refuses a limit that leaves no room instead of opening a picker for nothing', async () => {
    const { services, repository } = await unlockedVault();
    const calls: PickMediaOptions[] = [];
    const service = new ImportService(
      deps(services, async (options) => {
        calls.push(options);
        return [];
      }),
    );

    const report = await service.importFromLibrary(repository, { selectionLimit: 0 });

    expect(report).toEqual({ imported: 0, failed: 0, oversized: 0, removed: 0, overLimit: 0 });
    expect(calls).toHaveLength(0);
  });
});

describe('ImportService removing the originals it imported', () => {
  type Remover = jest.Mock<Promise<number>, [readonly string[]]>;

  /** Resolves "all of them" by default; a number or an Error overrides that. */
  function remover(outcome?: number | Error): Remover {
    const fn = jest.fn<Promise<number>, [readonly string[]]>();
    if (outcome instanceof Error) return fn.mockRejectedValue(outcome);
    if (typeof outcome === 'number') return fn.mockResolvedValue(outcome);
    return fn.mockImplementation((uris) => Promise.resolve(uris.length));
  }

  function withRemover(
    services: Services,
    pick: PickMedia,
    removeFromGallery: Remover,
    fs?: Pick<FileSystem, 'readBytes'>,
  ): ImportServiceDependencies {
    return { ...deps(services, pick, fs), removeFromGallery };
  }

  it('deletes the originals of the items that reached the vault, in one request', async () => {
    const { services, fs, repository } = await unlockedVault();
    const first = await stageTempCopy(fs, 'a.jpg');
    const second = await stageTempCopy(fs, 'c.jpg');
    const remove = remover();

    const service = new ImportService(withRemover(services, async () => [first, second], remove));

    const report = await service.importFromLibrary(repository);

    expect(report.imported).toBe(2);
    expect(report.removed).toBe(2);
    // One request, not one per photo: the system raises a confirmation for every call.
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith([first.documentUri, second.documentUri]);
  });

  it('never deletes the original of an item that failed to import', async () => {
    const { services, fs, repository } = await unlockedVault();
    const good = await stageTempCopy(fs, 'a.jpg');
    const broken = await stageTempCopy(fs, 'b.jpg', UNDECODABLE);
    const remove = remover();

    const service = new ImportService(withRemover(services, async () => [good, broken], remove));

    const report = await service.importFromLibrary(repository);

    expect(report).toMatchObject({ imported: 1, failed: 1, removed: 1 });
    expect(remove).toHaveBeenCalledWith([good.documentUri]);
  });

  it('never deletes an oversized original, which was skipped rather than stored', async () => {
    const { services, fs, repository } = await unlockedVault();
    const staged = await stageTempCopy(fs, 'huge.jpg');
    const huge = { ...staged, fileSize: MAX_ITEM_BYTES + 1 };
    const remove = remover();

    const service = new ImportService(withRemover(services, async () => [huge], remove));

    const report = await service.importFromLibrary(repository);

    expect(report).toMatchObject({ imported: 0, oversized: 1, removed: 0 });
    expect(remove).not.toHaveBeenCalled();
  });

  it('leaves an original alone when its provider serves it read-only', async () => {
    const { services, fs, repository } = await unlockedVault();
    const deletable = await stageTempCopy(fs, 'a.jpg');
    const readOnly = { ...(await stageTempCopy(fs, 'c.jpg')), deletable: false };
    const remove = remover();

    const service = new ImportService(
      withRemover(services, async () => [deletable, readOnly], remove),
    );

    const report = await service.importFromLibrary(repository);

    expect(report.imported).toBe(2);
    expect(report.removed).toBe(1);
    expect(remove).toHaveBeenCalledWith([deletable.documentUri]);
  });

  it('deletes nothing at all when the import aborts part-way', async () => {
    const { services, fs, repository } = await unlockedVault();
    const good = await stageTempCopy(fs, 'a.jpg');
    const doomed = await stageTempCopy(fs, 'b.jpg');
    const remove = remover();
    const readBytes = jest
      .fn<Promise<Bytes>, [string]>()
      .mockResolvedValueOnce(imageBytes(0x01))
      .mockRejectedValueOnce(new Error('disk full'));

    const service = new ImportService(
      withRemover(services, async () => [good, doomed], remove, { readBytes }),
    );

    await expect(service.importFromLibrary(repository)).rejects.toThrow('disk full');

    // The first item IS in the vault, but a half-finished run deletes nothing: a duplicate on
    // retry is something the user can undo, a deleted original is not.
    expect(remove).not.toHaveBeenCalled();
  });

  it('treats a refused deletion as a kept original, not as a failed import', async () => {
    const { services, fs, repository } = await unlockedVault();
    const only = await stageTempCopy(fs, 'a.jpg');
    const remove = remover(0);

    const service = new ImportService(withRemover(services, async () => [only], remove));

    const report = await service.importFromLibrary(repository);

    expect(report).toMatchObject({ imported: 1, failed: 0, removed: 0 });
    expect(repository.photos).toHaveLength(1);
  });

  it('survives a deletion that throws, with the vault copy still committed', async () => {
    const { services, fs, repository } = await unlockedVault();
    const only = await stageTempCopy(fs, 'a.jpg');
    const remove = remover(new Error('activity gone'));

    const service = new ImportService(withRemover(services, async () => [only], remove));

    const report = await service.importFromLibrary(repository);

    expect(report).toMatchObject({ imported: 1, removed: 0 });
    expect(repository.photos).toHaveLength(1);
  });

  it('never reports more removed than it asked for, whatever the native side claims', async () => {
    const { services, fs, repository } = await unlockedVault();
    const only = await stageTempCopy(fs, 'a.jpg');
    const remove = remover(99);

    const service = new ImportService(withRemover(services, async () => [only], remove));

    const report = await service.importFromLibrary(repository);

    expect(report.removed).toBe(1);
  });

  it('keeps auto-lock suspended across the system delete confirmation', async () => {
    const { services, fs, repository } = await unlockedVault();
    const only = await stageTempCopy(fs, 'a.jpg');
    let suspendedDuringDelete = false;
    const remove = remover();
    remove.mockImplementation((uris) => {
      // The delete prompt is another activity on top of ours, exactly like the picker.
      suspendedDuringDelete = services.autoLockSuspension.isSuspended;
      return Promise.resolve(uris.length);
    });

    const service = new ImportService(withRemover(services, async () => [only], remove));

    await service.importFromLibrary(repository);

    expect(suspendedDuringDelete).toBe(true);
    expect(services.autoLockSuspension.count).toBe(0);
  });

  it('enforces the free-tier cap itself rather than trusting the picker to honour it', async () => {
    const { services, fs, repository } = await unlockedVault();
    const readBytes = jest.fn<Promise<Bytes>, [string]>().mockResolvedValue(imageBytes(0x01));
    const selection = [
      await stageTempCopy(fs, 'a.jpg'),
      await stageTempCopy(fs, 'b.jpg'),
      await stageTempCopy(fs, 'c.jpg'),
    ];
    const remove = remover();

    const service = new ImportService(
      withRemover(services, async () => selection, remove, { readBytes }),
    );

    const report = await service.importFromLibrary(repository, { selectionLimit: 2 });

    expect(report).toMatchObject({ imported: 2, overLimit: 1 });
    // The third was never read, let alone encrypted: the cap holds before any plaintext copy.
    expect(readBytes).toHaveBeenCalledTimes(2);
    // ...and its original survives, because it never reached the vault.
    expect(remove).toHaveBeenCalledWith([selection[0]?.documentUri, selection[1]?.documentUri]);
  });
});
