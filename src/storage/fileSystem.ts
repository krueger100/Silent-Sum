/**
 * Minimal file-system abstraction over expo-file-system so the vault, secure delete and atomic
 * writes can be unit-tested against an in-memory implementation.
 *
 * All paths are absolute URIs (`file:///...`) as produced by expo-file-system. Vault paths are
 * derived from `VaultPaths` (see src/vault/vaultPaths.ts); temp files from the camera and the
 * image picker arrive as URIs from those modules.
 */
import type { Bytes } from '@/utils/bytes';

export interface FileSystem {
  /** App-private, non-media, backup-excluded directory for persistent vault data. */
  readonly documentDirectory: string;
  /** App-private cache directory (temporary plaintext from plugins lives here briefly). */
  readonly cacheDirectory: string;

  exists(uri: string): Promise<boolean>;
  isDirectory(uri: string): Promise<boolean>;
  /** Byte size of a file; throws FileNotFoundError when missing. */
  size(uri: string): Promise<number>;
  readBytes(uri: string): Promise<Bytes>;
  /** Creates/truncates the file (parent directories are created as needed). Not atomic. */
  writeBytes(uri: string, bytes: Bytes): Promise<void>;
  /**
   * Overwrites the first `bytes.length` bytes of an existing file IN PLACE, without truncating and
   * without appending (used by secure delete). Missing file: no-op.
   */
  overwriteInPlace(uri: string, bytes: Bytes): Promise<void>;
  /** Deletes a file; missing file is a no-op. */
  deleteFile(uri: string): Promise<void>;
  /** Renames/moves a file, replacing any existing destination (same directory => atomic). */
  move(fromUri: string, toUri: string): Promise<void>;
  /** mkdir -p (idempotent). */
  makeDirectory(uri: string): Promise<void>;
  /** Non-recursive listing: entry URIs (files and directories) directly under `uri`. Missing dir => []. */
  list(uri: string): Promise<FileEntry[]>;
  /** Removes an (empty or not) directory; missing is a no-op. */
  deleteDirectory(uri: string): Promise<void>;

  /**
   * Sequential chunked access, so a payload larger than the JS heap can still be encrypted,
   * decrypted and hashed. Vault videos are the reason these exist: a 400 MB recording must never
   * be materialised as a `Uint8Array`.
   */
  openRead(uri: string): Promise<FileReadHandle>;
  /** Creates or truncates the file; parents are created as needed. */
  openWrite(uri: string): Promise<FileWriteHandle>;
}

export interface FileReadHandle {
  readonly size: number;
  /** Up to `length` bytes from the current position; shorter (or empty) at end of file. */
  read(length: number): Promise<Bytes>;
  close(): Promise<void>;
}

export interface FileWriteHandle {
  write(bytes: Bytes): Promise<void>;
  close(): Promise<void>;
}

export interface FileEntry {
  readonly uri: string;
  readonly name: string;
  readonly isDirectory: boolean;
}

export class FileNotFoundError extends Error {
  constructor(uri: string) {
    super('file not found');
    this.name = 'FileNotFoundError';
    // The URI is deliberately kept out of the message so error logs never carry vault paths.
    this.uri = uri;
  }
  readonly uri: string;
}

/** Joins URI segments with single slashes. */
export function joinUri(base: string, ...segments: string[]): string {
  let out = base.replace(/\/+$/, '');
  for (const s of segments) out += '/' + s.replace(/^\/+/, '').replace(/\/+$/, '');
  return out;
}

export function uriBasename(uri: string): string {
  const trimmed = uri.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

export function uriDirname(uri: string): string {
  const trimmed = uri.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? '' : trimmed.slice(0, idx);
}
