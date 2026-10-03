/**
 * What the viewer says while a chat video is on its way.
 *
 * Opening a video is two long operations wearing one spinner: the encrypted object is downloaded
 * in full, and then opened in full. On a real recording over a real connection that was measured
 * at seventy-six seconds and then forty more -- two minutes of a featureless spinner, which a user
 * is entirely right to read as "this is broken" and close.
 *
 * Only the first phase can report a fraction. The object is a single sealed box, so it opens in
 * one go or not at all and there is no honest percentage to give for the second. Naming the phase
 * is what the second one gets, and it is enough: a label that changes is proof something is still
 * happening, which is the whole thing the old spinner failed to communicate.
 */
export interface TransferState {
  /** Bytes of the encrypted object fetched so far. */
  readonly transferred?: number | undefined;
  /** Total bytes, when the transfer knows it. Zero or absent until the first chunk lands. */
  readonly total?: number | undefined;
  /** The bytes are here; what is left is decryption, which has no fraction to report. */
  readonly opening?: boolean | undefined;
}

function percentage(transferred: number, total: number): number {
  // Floored, never rounded: showing 100% while the last bytes are still in flight is the one
  // reading that makes a working transfer look stuck again.
  return Math.min(100, Math.max(0, Math.floor((transferred / total) * 100)));
}

export function describeTransfer(state: TransferState): string {
  if (state.opening === true) return 'Decrypting…';

  const { transferred, total } = state;
  const measurable =
    typeof transferred === 'number' &&
    Number.isFinite(transferred) &&
    typeof total === 'number' &&
    Number.isFinite(total) &&
    total > 0;

  if (!measurable) return 'Downloading…';
  return `Downloading… ${String(percentage(transferred, total))}%`;
}
