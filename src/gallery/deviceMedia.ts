/**
 * The device's own media, as the import flow needs it.
 *
 * Both halves come from the local `vault-media` module rather than `expo-image-picker` and
 * `expo-media-library`, for one reason: picking and deleting have to be the same transaction.
 * A picker that hands back only bytes leaves the import with no way to say *which* original it
 * just copied, and matching afterwards on a name, a size or a timestamp is a guess -- an
 * acceptable guess for a cache lookup and an unacceptable one for permanently deleting somebody's
 * photo. The module keeps the handle the system issued at the moment of picking, so a deletion can
 * only ever land on the item the user actually chose.
 *
 * Nothing here holds a media permission. On Android the handle is a Storage Access Framework
 * document and the provider performs the delete after checking the grant; on iOS it is a
 * `PHAsset` identifier and the system raises its own confirmation. Both ask the user directly,
 * every time, and neither needs the app to be able to read the library.
 */
import VaultMedia from '../../modules/vault-media';

import type { PickMedia, RemoveFromGallery } from '@/gallery/importService';

export const pickDeviceMedia: PickMedia = async (options) => await VaultMedia.pickAsync(options);

/**
 * Returns how many originals actually went. A refusal at the system prompt comes back as a lower
 * count, not as an error: by the time this runs the vault already holds the encrypted copies, so
 * nothing about a kept original makes the import a failure.
 */
export const removeFromDeviceGallery: RemoveFromGallery = async (documentUris) =>
  await VaultMedia.deleteAsync(documentUris);
