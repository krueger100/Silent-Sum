/**
 * `FileSystem` over the expo-file-system class API (`File` / `Directory` / `Paths`).
 *
 * Everything the vault writes lives under the app-private document directory, which is never
 * media-scanned and is excluded from OS backups (`allowBackup=false` plus explicit data extraction
 * rules on Android). No vault byte is ever written to Pictures, DCIM, or any shared location.
 */
import { Directory, File, FileMode, Paths } from 'expo-file-system';

import {
  FileNotFoundError,
  uriBasename,
  uriDirname,
  type FileEntry,
  type FileReadHandle,
  type FileSystem,
  type FileWriteHandle,
} from '@/storage/fileSystem';
import type { Bytes } from '@/utils/bytes';

export class ExpoFileSystem implements FileSystem {
  get documentDirectory(): string {
    return Paths.document.uri;
  }

  get cacheDirectory(): string {
    return Paths.cache.uri;
  }

  async exists(uri: string): Promise<boolean> {
    return new File(uri).exists || new Directory(uri).exists;
  }

  async isDirectory(uri: string): Promise<boolean> {
    return new Directory(uri).exists;
  }

  async size(uri: string): Promise<number> {
    const file = new File(uri);
    if (!file.exists) throw new FileNotFoundError(uri);
    return file.size;
  }

  async readBytes(uri: string): Promise<Bytes> {
    const file = new File(uri);
    if (!file.exists) throw new FileNotFoundError(uri);
    return file.bytes();
  }

  async writeBytes(uri: string, bytes: Bytes): Promise<void> {
    const file = new File(uri);
    if (!file.exists) {
      await this.makeDirectory(uriDirname(uri));
      file.create({ intermediates: true, overwrite: true });
    }
    file.write(bytes);
  }

  /**
   * Overwrites the leading bytes of an existing file without truncating or extending it.
   * `FileMode.ReadWrite` opens at offset 0 and does not truncate, which is what lets secure
   * delete scribble over the real blocks before unlinking.
   */
  async overwriteInPlace(uri: string, bytes: Bytes): Promise<void> {
    const file = new File(uri);
    if (!file.exists) return;
    const handle = file.open(FileMode.ReadWrite);
    try {
      handle.offset = 0;
      handle.writeBytes(bytes);
    } finally {
      handle.close();
    }
  }

  async deleteFile(uri: string): Promise<void> {
    const file = new File(uri);
    if (file.exists) file.delete();
  }

  async move(fromUri: string, toUri: string): Promise<void> {
    const source = new File(fromUri);
    if (!source.exists) throw new FileNotFoundError(fromUri);
    await this.makeDirectory(uriDirname(toUri));
    await source.move(new File(toUri), { overwrite: true });
  }

  async makeDirectory(uri: string): Promise<void> {
    if (!uri) return;
    const directory = new Directory(uri);
    if (!directory.exists) directory.create({ intermediates: true, idempotent: true });
  }

  async list(uri: string): Promise<FileEntry[]> {
    const directory = new Directory(uri);
    if (!directory.exists) return [];
    return directory.list().map((entry) => ({
      uri: entry.uri,
      name: uriBasename(entry.uri),
      isDirectory: entry instanceof Directory,
    }));
  }

  async deleteDirectory(uri: string): Promise<void> {
    const directory = new Directory(uri);
    if (directory.exists) directory.delete();
  }

  /**
   * `FileMode.Read` gives a cursor that advances with every `readBytes`, which is all the chunked
   * cipher needs. The handle is closed by the caller in a `finally`, never left to a finaliser.
   */
  async openRead(uri: string): Promise<FileReadHandle> {
    const file = new File(uri);
    if (!file.exists) throw new FileNotFoundError(uri);
    const size = file.size;
    const handle = file.open(FileMode.ReadOnly);
    return {
      size,
      async read(length: number) {
        return handle.readBytes(length);
      },
      async close() {
        handle.close();
      },
    };
  }

  async openWrite(uri: string): Promise<FileWriteHandle> {
    const file = new File(uri);
    await this.makeDirectory(uriDirname(uri));
    if (!file.exists) file.create({ intermediates: true, overwrite: true });
    // Truncate: a shorter payload must never leave the tail of a previous one behind it.
    const handle = file.open(FileMode.Truncate);
    return {
      async write(bytes) {
        handle.writeBytes(bytes);
      },
      async close() {
        handle.close();
      },
    };
  }
}
