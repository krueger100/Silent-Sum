/**
 * Jest replacement for `expo-media-library`.
 *
 * The real module builds its exported classes by subclassing ones the native module supplies, so
 * importing it under Jest throws before any test runs -- the same reason `expo-video` is shimmed.
 *
 * Both members throw rather than resolve. Nothing in the suite should ever reach the real device
 * gallery: `exportToGallery` takes the writer as a dependency precisely so specs can hand it a
 * fake, and a spec that somehow got here would be claiming to have written to a gallery that does
 * not exist. Failing loudly is the only honest answer.
 */
function unreachable(member: string): never {
  throw new Error(
    `expo-media-library.${member} was called in a test. Inject a GalleryWriter instead -- ` +
      'nothing in the suite may touch the device gallery.',
  );
}

export const Asset = {
  create(): never {
    return unreachable('Asset.create');
  },
};

export function requestPermissionsAsync(): never {
  return unreachable('requestPermissionsAsync');
}

export function deleteAssetsAsync(): never {
  return unreachable('deleteAssetsAsync');
}
