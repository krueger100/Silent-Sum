import type { Services } from '@/app/services';
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

    expect(report).toEqual({ imported: 2, failed: 1 });
    expect(repository.photos).toHaveLength(2);
    for (const picked of [first, broken, last]) {
      expect(await fs.exists(picked.uri)).toBe(false);
    }
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

    expect(report).toEqual({ imported: 0, failed: 0 });
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
