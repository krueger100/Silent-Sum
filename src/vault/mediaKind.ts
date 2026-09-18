/**
 * Which kind of item an index entry describes, and what follows from that.
 *
 * The kind is derived from `mimeType` rather than stored as a separate field. That is deliberate:
 * a vault written before videos existed has no kind to read, and two fields that can disagree
 * ("mimeType says video, kind says photo") would be a way to get a video blob decrypted under the
 * photo sub-key. With one source of truth there is nothing to disagree about, and an index from an
 * older build reads back exactly as it did.
 */
import { VaultKeyId } from '@/crypto/types';
import type { MediaKind, PhotoEntry } from '@/vault/types';

export const VIDEO_MIME_TYPE = 'video/mp4';
export const PHOTO_MIME_TYPE = 'image/jpeg';

export function mediaKindOf(entry: Pick<PhotoEntry, 'mimeType'>): MediaKind {
  return entry.mimeType.startsWith('video/') ? 'video' : 'photo';
}

export function isVideo(entry: Pick<PhotoEntry, 'mimeType'>): boolean {
  return mediaKindOf(entry) === 'video';
}

/** The sub-key a payload blob is encrypted under. Bound into the blob header as associated data. */
export function payloadKeyId(entry: Pick<PhotoEntry, 'mimeType'>): VaultKeyId {
  return isVideo(entry) ? VaultKeyId.video : VaultKeyId.photo;
}

/** `0:07`, `1:05:20`. Never localised: the same reasoning as `formatTaken`. */
export function formatDuration(durationMs: number | null): string {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return '--:--';
  const total = Math.round(durationMs / 1000);
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  const mm = hours > 0 ? String(minutes).padStart(2, '0') : String(minutes);
  return `${hours > 0 ? `${String(hours)}:` : ''}${mm}:${String(seconds).padStart(2, '0')}`;
}
