/**
 * In-memory `FileSystem` for tests.
 *
 * Deliberately faithful about the things the vault depends on: byte-exact contents, in-place
 * overwrite semantics that do not change a file's length, directory listings, and a `move` that
 * replaces the destination. Every stored buffer is a copy, so a test holding a reference cannot
 * mutate what the "disk" contains.
 */
import {
  FileNotFoundError,
  joinUri,
  uriBasename,
  uriDirname,
  type FileEntry,
  type FileReadHandle,
  type FileSystem,
  type FileWriteHandle,
} from '@/storage/fileSystem';
import type { Bytes } from '@/utils/bytes';

function normalise(uri: string): string {
  return uri.replace(/\/+$/, '');
}

export class InMemoryFileSystem implements FileSystem {
  readonly documentDirectory: string;
  readonly cacheDirectory: string;

  private readonly files = new Map<string, Uint8Array>();
  private readonly directories = new Set<string>();

  constructor(root = 'file:///memory') {
    this.documentDirectory = `${root}/documents`;
    this.cacheDirectory = `${root}/cache`;
    this.directories.add(normalise(this.documentDirectory));
    this.directories.add(normalise(this.cacheDirectory));
  }

  /** Every file URI currently stored, for assertions such as "no plaintext reached disk". */
  get allFiles(): ReadonlyMap<string, Uint8Array> {
    return this.files;
  }

  async exists(uri: string): Promise<boolean> {
    const key = normalise(uri);
    return this.files.has(key) || this.directories.has(key);
  }

  async isDirectory(uri: string): Promise<boolean> {
    return this.directories.has(normalise(uri));
  }

  async size(uri: string): Promise<number> {
    const bytes = this.files.get(normalise(uri));
    if (!bytes) throw new FileNotFoundError(uri);
    return bytes.length;
  }

  async readBytes(uri: string): Promise<Bytes> {
    const bytes = this.files.get(normalise(uri));
    if (!bytes) throw new FileNotFoundError(uri);
    return Uint8Array.from(bytes);
  }

  async writeBytes(uri: string, bytes: Bytes): Promise<void> {
    const key = normalise(uri);
    await this.makeDirectory(uriDirname(key));
    this.files.set(key, Uint8Array.from(bytes));
  }

  async overwriteInPlace(uri: string, bytes: Bytes): Promise<void> {
    const key = normalise(uri);
    const existing = this.files.get(key);
    if (!existing) return;
    existing.set(bytes.subarray(0, Math.min(bytes.length, existing.length)), 0);
  }

  async deleteFile(uri: string): Promise<void> {
    this.files.delete(normalise(uri));
  }

  async move(fromUri: string, toUri: string): Promise<void> {
    const from = normalise(fromUri);
    const bytes = this.files.get(from);
    if (!bytes) throw new FileNotFoundError(fromUri);
    const to = normalise(toUri);
    await this.makeDirectory(uriDirname(to));
    this.files.set(to, bytes);
    this.files.delete(from);
  }

  async makeDirectory(uri: string): Promise<void> {
    let current = normalise(uri);
    while (current && !this.directories.has(current) && current.includes('/')) {
      this.directories.add(current);
      const parent = uriDirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  async list(uri: string): Promise<FileEntry[]> {
    const base = normalise(uri);
    if (!this.directories.has(base)) return [];
    const prefix = `${base}/`;
    const seen = new Map<string, FileEntry>();

    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest.includes('/')) continue;
      seen.set(key, { uri: key, name: rest, isDirectory: false });
    }
    for (const key of this.directories) {
      if (key === base || !key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest.includes('/')) continue;
      seen.set(key, { uri: key, name: rest, isDirectory: true });
    }
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async deleteDirectory(uri: string): Promise<void> {
    const base = normalise(uri);
    const prefix = `${base}/`;
    for (const key of [...this.files.keys()]) {
      if (key === base || key.startsWith(prefix)) this.files.delete(key);
    }
    for (const key of [...this.directories]) {
      if (key === base || key.startsWith(prefix)) this.directories.delete(key);
    }
  }

  async openRead(uri: string): Promise<FileReadHandle> {
    const bytes = this.files.get(normalise(uri));
    if (!bytes) throw new FileNotFoundError(uri);
    // A snapshot, matching a real handle: later writes to the same path do not rewrite what an
    // already-open reader is walking through.
    const snapshot = Uint8Array.from(bytes);
    let offset = 0;
    return {
      size: snapshot.length,
      async read(length: number) {
        const end = Math.min(snapshot.length, offset + Math.max(0, length));
        const slice = snapshot.slice(offset, end);
        offset = end;
        return slice;
      },
      async close() {
        offset = snapshot.length;
      },
    };
  }

  async openWrite(uri: string): Promise<FileWriteHandle> {
    const key = normalise(uri);
    await this.makeDirectory(uriDirname(key));
    const parts: Uint8Array[] = [];
    const files = this.files;
    const flush = (): void => {
      let total = 0;
      for (const part of parts) total += part.length;
      const out = new Uint8Array(total);
      let at = 0;
      for (const part of parts) {
        out.set(part, at);
        at += part.length;
      }
      files.set(key, out);
    };
    flush();
    return {
      async write(bytes: Bytes) {
        parts.push(Uint8Array.from(bytes));
        flush();
      },
      async close() {
        flush();
      },
    };
  }

  /** Test helper: the raw stored bytes without copying, or undefined. */
  peek(uri: string): Uint8Array | undefined {
    return this.files.get(normalise(uri));
  }

  /** Test helper mirroring `joinUri` so specs read naturally. */
  join(base: string, ...segments: string[]): string {
    return joinUri(base, ...segments);
  }

  /** Test helper: basename, mirroring the production helper. */
  static basename(uri: string): string {
    return uriBasename(uri);
  }
}
