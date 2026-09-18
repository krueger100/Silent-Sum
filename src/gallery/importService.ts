/**
 * Imports photos the user picks from the OS library into the vault.
 *
 * Three things matter here and nothing else does:
 *
 * 1. The system picker takes the app to the background, so auto-lock is suspended for exactly the
 *    picker round trip and resumed in a `finally` -- otherwise a user browsing their library for a
 *    minute comes back to a locked vault and a half-done import.
 * 2. On Android (cache dir) and iOS (tmp dir) the picker hands back a private COPY of the image,
 *    never the user's original, so that copy is plaintext living in the app sandbox. It is
 *    securely deleted for every picked asset, whether the import succeeded, failed to decode, or
 *    blew up -- the deletion loop is in a `finally` around the whole import.
 * 3. The decrypted bytes are zeroed as soon as the repository has encrypted them.
 *
 * The user's originals in the OS library are never touched.
 */
import * as ImagePicker from 'expo-image-picker';

import type { AutoLockSuspension } from '@/privacy/autoLockSuspension';
import type { FileSystem } from '@/storage/fileSystem';
import type { SecureDelete } from '@/storage/secureDelete';
import { ImageDecodeError, type VaultRepository } from '@/vault/types';
import { zeroBytes, type Bytes } from '@/utils/bytes';

export interface ImportReport {
  readonly imported: number;
  readonly failed: number;
}

export type LaunchImageLibrary = (
  options: ImagePicker.ImagePickerOptions,
) => Promise<ImagePicker.ImagePickerResult>;

/**
 * Structural slices of the composition root, so tests can pass plain objects and production can
 * pass `services` itself.
 */
export interface ImportServiceDependencies {
  readonly fs: Pick<FileSystem, 'readBytes'>;
  readonly secureDelete: Pick<SecureDelete, 'file'>;
  readonly autoLockSuspension: Pick<AutoLockSuspension, 'suspend' | 'resume'>;
  /** Overridable for tests; defaults to expo-image-picker. */
  readonly launchImageLibrary?: LaunchImageLibrary;
}

const IMPORT_PICKER_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images'],
  allowsMultipleSelection: true,
  // The image bytes are read from the file; a base64 copy would be a second plaintext of every
  // picked image sitting in a JS string that cannot be zeroed.
  base64: false,
  // Never ask for EXIF: it carries GPS coordinates and device identifiers we have no use for and
  // must not end up in the vault index.
  exif: false,
  allowsEditing: false,
};

export class ImportService {
  constructor(private readonly deps: ImportServiceDependencies) {}

  /**
   * Opens the system picker and encrypts everything the user chose.
   *
   * Undecodable images are counted as `failed` and the rest of the selection still imports. Any
   * other failure (a read error, a full disk) aborts the remaining assets and propagates, after
   * the temp copies have been wiped.
   */
  async importFromLibrary(repository: VaultRepository): Promise<ImportReport> {
    const assets = await this.pick();
    let imported = 0;
    let failed = 0;

    try {
      for (const asset of assets) {
        let bytes: Bytes | null = null;
        try {
          bytes = await this.deps.fs.readBytes(asset.uri);
          await repository.addPhoto(
            { bytes, uri: asset.uri },
            {
              source: 'import',
              originalName: asset.fileName ?? null,
              mimeType: asset.mimeType ?? 'image/jpeg',
            },
          );
          imported += 1;
        } catch (error) {
          if (!(error instanceof ImageDecodeError)) throw error;
          failed += 1;
        } finally {
          zeroBytes(bytes);
        }
      }
    } finally {
      // Every picked asset, always: an abort halfway through must not leave the untouched
      // selection's plaintext copies behind.
      for (const asset of assets) await this.wipeTempCopy(asset.uri);
    }

    return { imported, failed };
  }

  /** Suspends auto-lock for exactly the picker round trip. Cancel yields an empty selection. */
  private async pick(): Promise<readonly ImagePicker.ImagePickerAsset[]> {
    const launch = this.deps.launchImageLibrary ?? ImagePicker.launchImageLibraryAsync;
    this.deps.autoLockSuspension.suspend();
    try {
      const result = await launch(IMPORT_PICKER_OPTIONS);
      return result.canceled ? [] : result.assets;
    } finally {
      this.deps.autoLockSuspension.resume();
    }
  }

  /**
   * Best effort by construction: `SecureDelete.file` already swallows a missing file and a
   * read-only volume, and a failure here must not turn a successful import into an error.
   */
  private async wipeTempCopy(uri: string): Promise<void> {
    if (uri.length === 0) return;
    try {
      await this.deps.secureDelete.file(uri);
    } catch {
      // The copy stays inside the app sandbox either way.
    }
  }
}
