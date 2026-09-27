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

import { MAX_ITEM_BYTES } from '@/billing/entitlements';
import type { AutoLockSuspension } from '@/privacy/autoLockSuspension';
import type { FileSystem } from '@/storage/fileSystem';
import type { SecureDelete } from '@/storage/secureDelete';
import { ImageDecodeError, type VaultRepository } from '@/vault/types';
import { zeroBytes, type Bytes } from '@/utils/bytes';

export interface ImportReport {
  readonly imported: number;
  readonly failed: number;
  /** Assets the picker reported as larger than `MAX_ITEM_BYTES`, skipped without being read. */
  readonly oversized: number;
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
   *
   * `selectionLimit` is how the free tier's item cap reaches the picker: the OS lets the user
   * choose at most that many, so the cap is enforced before any plaintext copy is made rather
   * than by importing part of a selection and quietly dropping the rest. Zero means no room at
   * all, and the picker is not opened; undefined means unlimited.
   */
  async importFromLibrary(
    repository: VaultRepository,
    options: { readonly selectionLimit?: number } = {},
  ): Promise<ImportReport> {
    if (options.selectionLimit !== undefined && options.selectionLimit <= 0) {
      return { imported: 0, failed: 0, oversized: 0 };
    }
    const assets = await this.pick(options.selectionLimit);
    let imported = 0;
    let failed = 0;
    let oversized = 0;

    try {
      for (const asset of assets) {
        // Checked from the picker's own metadata, before `readBytes` pulls the file into memory:
        // refusing a 500 MB video must not cost 500 MB of heap first. A provider that omits
        // `fileSize` is trusted -- an unknown size is not evidence of a large one.
        if (asset.fileSize !== undefined && asset.fileSize > MAX_ITEM_BYTES) {
          oversized += 1;
          continue;
        }
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

    return { imported, failed, oversized };
  }

  /** Suspends auto-lock for exactly the picker round trip. Cancel yields an empty selection. */
  private async pick(selectionLimit?: number): Promise<readonly ImagePicker.ImagePickerAsset[]> {
    const launch = this.deps.launchImageLibrary ?? ImagePicker.launchImageLibraryAsync;
    this.deps.autoLockSuspension.suspend();
    try {
      const result = await launch(
        selectionLimit === undefined
          ? IMPORT_PICKER_OPTIONS
          : { ...IMPORT_PICKER_OPTIONS, selectionLimit },
      );
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
