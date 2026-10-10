/**
 * How far along a long operation is: items finished, and how many there are in all.
 *
 * Items rather than bytes, because items are the figure every one of these operations can state
 * honestly. Uploads have no byte-level channel at all (`putBlob` takes no progress callback,
 * unlike `getBlob`), and an import's cost per item is decryption and re-encryption rather than
 * transfer, so a byte count would be real for some operations and invented for others. "12 of 73"
 * is true for all of them.
 *
 * It is also the figure that makes a stall visible. A spinner looks identical at item 3 of 300
 * and on a run that died ten minutes ago; a number that stops climbing does not.
 *
 * By convention the callback fires once with `done` at 0 before any work starts, so a screen can
 * show a real bar immediately instead of an indeterminate one that snaps to a percentage a moment
 * later, and then once as each item finishes -- including items that finished by being skipped.
 */
export type ProgressReport = (done: number, total: number) => void;
