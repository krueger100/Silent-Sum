/**
 * Crash-safe file replacement: write a uniquely named temporary file next to the target, then
 * rename it over the target. A rename within one directory is atomic on both Android and iOS, so
 * a process death mid-write can leave a stale temp file but never a half-written index.
 */
import type { FileSystem } from '@/storage/fileSystem';
import { uriBasename, uriDirname } from '@/storage/fileSystem';
import type { Bytes } from '@/utils/bytes';

let sequence = 0;

/** Temp names are `<name>.<counter>.<random>.tmp`, so concurrent writers never collide. */
export function temporaryNameFor(targetUri: string): string {
  sequence += 1;
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${targetUri}.${String(sequence)}.${suffix}.tmp`;
}

export async function writeFileAtomically(
  fs: FileSystem,
  targetUri: string,
  bytes: Bytes,
): Promise<void> {
  const temporaryUri = temporaryNameFor(targetUri);
  await fs.makeDirectory(uriDirname(targetUri));
  try {
    await fs.writeBytes(temporaryUri, bytes);
    await fs.move(temporaryUri, targetUri);
  } catch (error) {
    // Never leave a partial temp file behind; the caller will surface the original failure.
    try {
      await fs.deleteFile(temporaryUri);
    } catch {
      // Nothing more we can do.
    }
    throw error;
  }
}

/** True for the temp files this module creates, so cleanup passes can recognise them. */
export function isTemporaryArtifact(uri: string): boolean {
  return uriBasename(uri).endsWith('.tmp');
}
