import type { Services } from '@/app/services';
import { MAX_ITEM_BYTES } from '@/billing/entitlements';
import {
  ImportService,
  type ImportServiceDependencies,
  type LaunchImageLibrary,
} from '@/gallery/importService';
import { imageBytes, unlockedVault, UNDECODABLE } from '@/gallery/__tests__/vaultHarness';
import type { FileSystem } from '@/storage/fileSystem';
import type { InMemoryFileSystem } from '@/storage/inMemoryFileSystem';
import type { Bytes } from '@/utils/bytes';
import type { ImagePickerAsset, ImagePickerOptions } from 'expo-image-picker';

jest.mock('expo-image-picker', () => ({
  launchImageLibraryAsync: jest.fn(),
}));

function deps(
  services: Services,
  launchImageLibrary: LaunchImageLibrary,
  fs?: Pick<FileSystem, 'readBytes'>,
): ImportServiceDependencies {
  return {
    fs: fs ?? services.fs,
    secureDelete: services.secureDelete,
    autoLockSuspension: services.autoLockSuspension,
    launchImageLibrary,
  };
}

function asset(uri: string, fileName: string): ImagePickerAsset {
  return { uri, width: 1200, height: 900, fileName, mimeType: 'image/jpeg', type: 'image' };
}

/** Puts a plaintext "picker copy" on the fake disk, exactly as the OS picker would. */
async function stageTempCopy(
  fs: InMemoryFileSystem,
  name: string,
  firstByte = 0x01,
): Promise<ImagePickerAsset> {
  const uri = `${fs.cacheDirectory}/picker/${name}`;
  await fs.writeBytes(uri, imageBytes(firstByte));
  return asset(uri, name);
}

describe('ImportService', () => {
  it('imports the readable assets, counts the undecodable one, and wipes every temp copy', async () => {
    const { services, fs, repository } = await unlockedVault();
    const first = await stageTempCopy(fs, 'a.jpg');
    const broken = await stageTempCopy(fs, 'b.jpg', UNDECODABLE);
    const last = await stageTempCopy(fs, 'c.jpg');

    const service = new ImportService(
      deps(services, async () => ({ canceled: false, assets: [first, broken, last] })),
    );

    const report = await service.importFromLibrary(repository);

    expect(report).toEqual({ imported: 2, failed: 1, oversized: 0 });
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
    const service = new ImportService(
      deps(services, async () => ({ canceled: false, assets: [picked] }), { readBytes }),
    );

    const report = await service.importFromLibrary(repository);

    expect(report).toEqual({ imported: 0, failed: 0, oversized: 1 });
    // The point of the check: a 500 MB file must not be pulled into memory to be refused.
    expect(readBytes).not.toHaveBeenCalled();
    // And it is still cleaned up -- a refused asset leaves no plaintext copy behind.
    expect(await fs.exists(picked.uri)).toBe(false);
  });

  it('imports an asset whose size the picker did not report', async () => {
    // Some providers omit fileSize. An unknown size is not evidence of a large one.
    const { services, fs, repository } = await unlockedVault();
    const staged = await stageTempCopy(fs, 'ok.jpg');
    const service = new ImportService(
      deps(services, async () => ({ canceled: false, assets: [staged] })),
    );

    const report = await service.importFromLibrary(repository);

    expect(report.imported).toBe(1);
    expect(report.oversized).toBe(0);
  });

  it('refuses only the oversized asset and imports the rest of the selection', async () => {
    const { services, fs, repository } = await unlockedVault();
    const small = await stageTempCopy(fs, 'small.jpg');
    const huge = { ...(await stageTempCopy(fs, 'huge.jpg')), fileSize: MAX_ITEM_BYTES + 1 };
    const service = new ImportService(
      deps(services, async () => ({ canceled: false, assets: [small, huge] })),
    );

    const report = await service.importFromLibrary(repository);

    expect(report).toEqual({ imported: 1, failed: 0, oversized: 1 });
    expect(repository.photos).toHaveLength(1);
  });

  it('accepts an asset exactly at the cap', async () => {
    const { services, fs, repository } = await unlockedVault();
    const staged = await stageTempCopy(fs, 'exact.jpg');
    const picked = { ...staged, fileSize: MAX_ITEM_BYTES };
    const service = new ImportService(
      deps(services, async () => ({ canceled: false, assets: [picked] })),
    );

    const report = await service.importFromLibrary(repository);

    expect(report).toEqual({ imported: 1, failed: 0, oversized: 0 });
  });

  it('wipes every temp copy even when an asset fails for a reason other than decoding', async () => {
    const { services, fs, repository } = await unlockedVault();
    const first = await stageTempCopy(fs, 'a.jpg');
    const missing = asset(`${fs.cacheDirectory}/picker/gone.jpg`, 'gone.jpg');
    const last = await stageTempCopy(fs, 'c.jpg');

    const service = new ImportService(
      deps(services, async () => ({ canceled: false, assets: [first, missing, last] })),
    );

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
        return { canceled: false, assets: [picked] };
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

  it('asks for multiple images without base64 or EXIF', async () => {
    const { services, repository } = await unlockedVault();
    const calls: ImagePickerOptions[] = [];

    const service = new ImportService(
      deps(services, async (options) => {
        calls.push(options);
        return { canceled: true, assets: null };
      }),
    );

    const report = await service.importFromLibrary(repository);

    expect(report).toEqual({ imported: 0, failed: 0, oversized: 0 });
    expect(calls).toHaveLength(1);
    const used = calls[0];
    expect(used?.allowsMultipleSelection).toBe(true);
    expect(used?.base64).toBe(false);
    expect(used?.exif).toBe(false);
    expect(used?.mediaTypes).toEqual(['images']);
  });

  it('zeroes the plaintext buffer it read for each asset', async () => {
    const { services, fs, repository } = await unlockedVault();
    const picked = await stageTempCopy(fs, 'a.jpg');
    const handedOut: Bytes[] = [];

    const service = new ImportService(
      deps(services, async () => ({ canceled: false, assets: [picked] }), {
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
  it('caps the picker at the room the free tier leaves, and leaves it open otherwise', async () => {
    const { services, repository } = await unlockedVault();
    const calls: ImagePickerOptions[] = [];
    const service = new ImportService(
      deps(services, async (options) => {
        calls.push(options);
        return { canceled: true, assets: null };
      }),
    );

    await service.importFromLibrary(repository, { selectionLimit: 3 });
    await service.importFromLibrary(repository);

    expect(calls[0]?.selectionLimit).toBe(3);
    expect(calls[0]?.allowsMultipleSelection).toBe(true);
    expect(calls[1]?.selectionLimit).toBeUndefined();
  });

  it('refuses a limit that leaves no room instead of opening a picker for nothing', async () => {
    const { services, repository } = await unlockedVault();
    const calls: ImagePickerOptions[] = [];
    const service = new ImportService(
      deps(services, async (options) => {
        calls.push(options);
        return { canceled: true, assets: null };
      }),
    );

    const report = await service.importFromLibrary(repository, { selectionLimit: 0 });

    expect(report).toEqual({ imported: 0, failed: 0, oversized: 0 });
    expect(calls).toHaveLength(0);
  });
});
