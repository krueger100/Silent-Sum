/**
 * `expo-media-library`, narrowed to the one thing this app does with it: add a file to the
 * gallery. Nothing here reads the gallery, and the permission request says so.
 *
 * `writeOnly` is what keeps the app's permission set from growing. With it set, the native module
 * asks for `WRITE_EXTERNAL_STORAGE` and nothing else -- and only below Android 13, where the
 * library caps that permission at `maxSdkVersion="32"` anyway. On Android 13+ the request resolves
 * to an empty permission list, granted without a prompt, because inserting into MediaStore needs
 * no permission for content the app created. Dropping `writeOnly` would pull in
 * `READ_MEDIA_IMAGES` and `READ_MEDIA_VIDEO`, which Play treats as sensitive and which an app
 * presenting itself as a calculator has no business declaring.
 *
 * The granular list is passed explicitly even though `writeOnly` makes it moot, so that a future
 * edit that drops `writeOnly` still never asks for audio.
 */
import { Asset, requestPermissionsAsync } from 'expo-media-library';

import type { GalleryWriter } from '@/gallery/galleryExport';

export const deviceGalleryWriter: GalleryWriter = {
  async requestWriteAccess(): Promise<boolean> {
    const response = await requestPermissionsAsync(true, ['photo', 'video']);
    return response.granted;
  },
  async save(fileUri: string): Promise<void> {
    // Below Android 11 this copies into public storage; on 11+ it inserts through MediaStore.
    await Asset.create(fileUri);
  },
};

