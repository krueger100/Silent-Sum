/**
 * Layout of the encrypted vault inside the app-private document directory.
 *
 *   <documents>/vault/
 *     index.enc          encrypted item index (JSON)
 *     photos/<id>.enc    encrypted payloads: full-size images AND videos
 *     thumbs/<id>.enc    encrypted thumbnails, including video poster frames
 *
 * Videos share the payload directory rather than getting one of their own. The directory name is
 * a bucket, not a type: what actually distinguishes a video blob is the key id in its header,
 * which is bound in as associated data and selects a different sub-key. Keeping one bucket is
 * what lets deletion, the wipe, cloud backup, restore and the index stay single-path.
 *
 * Ids are 32 lower-case hex characters, so a file name reveals nothing about its contents, not
 * even a capture order.
 */
import { joinUri, type FileSystem } from '@/storage/fileSystem';

export const VAULT_DIRECTORY_NAME = 'vault';
export const VAULT_INDEX_FILE = 'index.enc';
export const PHOTOS_DIRECTORY_NAME = 'photos';
export const THUMBS_DIRECTORY_NAME = 'thumbs';

const ID_PATTERN = /^[0-9a-f]{8,64}$/;

/** Ids come from our own CSPRNG, but they also arrive inside restored backup indexes. */
export class InvalidPhotoIdError extends Error {
  constructor() {
    super('InvalidPhotoIdError');
    this.name = 'InvalidPhotoIdError';
  }
}

export function assertPhotoId(id: string): string {
  if (!ID_PATTERN.test(id)) throw new InvalidPhotoIdError();
  return id;
}

export class VaultPaths {
  readonly root: string;

  constructor(documentDirectory: string) {
    this.root = joinUri(documentDirectory, VAULT_DIRECTORY_NAME);
  }

  get photos(): string {
    return joinUri(this.root, PHOTOS_DIRECTORY_NAME);
  }

  get thumbs(): string {
    return joinUri(this.root, THUMBS_DIRECTORY_NAME);
  }

  get index(): string {
    return joinUri(this.root, VAULT_INDEX_FILE);
  }

  photoFile(id: string): string {
    return joinUri(this.photos, `${assertPhotoId(id)}.enc`);
  }

  thumbFile(id: string): string {
    return joinUri(this.thumbs, `${assertPhotoId(id)}.enc`);
  }

  async ensure(fs: FileSystem): Promise<void> {
    await fs.makeDirectory(this.photos);
    await fs.makeDirectory(this.thumbs);
  }
}
