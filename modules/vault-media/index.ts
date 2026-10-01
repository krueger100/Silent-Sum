/**
 * Picking that comes with permission to delete what was picked.
 *
 * The import flow needs two things from a chosen photo: its bytes, and a handle precise enough to
 * delete that exact item afterwards. No picker reachable through `expo-image-picker` gives both.
 * The system photo picker returns a URI that cannot be resolved to a MediaStore row, and Android
 * 13+ substitutes the photo picker for `ACTION_GET_CONTENT` whenever the filter is image or video,
 * so asking for the older picker does not help either.
 *
 * `ACTION_OPEN_DOCUMENT` is not substituted. What it returns is a Storage Access Framework
 * document: the exact item, with a grant that authorises deleting it and no permission of any kind
 * attached. That is the whole reason this module exists.
 *
 * On iOS the equivalent is `PHPicker` plus `PHPhotoLibrary.performChanges`, which raises its own
 * system confirmation before anything is removed.
 */
import { requireNativeModule } from 'expo-modules-core';

export interface PickedMedia {
  /** A `file://` copy in app-private cache. Read it, then wipe it; it is plaintext. */
  readonly uri: string;
  /** The opaque handle that identifies the ORIGINAL. The only thing allowed to delete it. */
  readonly documentUri: string;
  readonly fileName: string | null;
  readonly fileSize: number | null;
  readonly mimeType: string | null;
  /** False when the provider serves this item read-only; deleting it will not be attempted. */
  readonly deletable: boolean;
}

export interface PickMediaOptions {
  /** MIME filters handed to the system picker. */
  readonly mimeTypes: readonly string[];
  readonly allowsMultipleSelection: boolean;
}

interface VaultMediaNativeModule {
  pickAsync(options: PickMediaOptions): Promise<PickedMedia[]>;
  /** Returns how many originals were actually removed. Never throws for a refusal. */
  deleteAsync(documentUris: readonly string[]): Promise<number>;
  /** Whether each document could be deleted at all, without attempting it. */
  canDeleteAsync(documentUris: readonly string[]): Promise<boolean[]>;
}

export default requireNativeModule<VaultMediaNativeModule>('VaultMedia');
