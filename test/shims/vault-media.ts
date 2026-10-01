/**
 * Jest replacement for the local `vault-media` native module.
 *
 * `requireNativeModule` throws under Jest, so importing the real one would break every spec that
 * builds a `Services`. Both members throw rather than resolve: `ImportService` takes the picker
 * and the remover as dependencies precisely so specs can hand it fakes, and a spec that reached
 * the real module would be claiming to have opened a system picker or deleted somebody's photo.
 */
function unreachable(member: string): never {
  throw new Error(
    `vault-media.${member} was called in a test. Inject pickMedia/removeFromGallery instead -- ` +
      'nothing in the suite may open a picker or delete a device original.',
  );
}

export default {
  pickAsync(): never {
    return unreachable('pickAsync');
  },
  deleteAsync(): never {
    return unreachable('deleteAsync');
  },
  canDeleteAsync(): never {
    return unreachable('canDeleteAsync');
  },
};
