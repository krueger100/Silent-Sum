/**
 * What the thread shows between picking an item and the real message arriving.
 *
 * Without this there is a gap: you choose a photo, the sheet closes, and nothing happens until
 * the upload, the document write and the listener round trip have all completed. On a slow
 * connection with a video that is many seconds of a screen that looks like it ignored you --
 * long enough that people tap again, which is how duplicates get sent.
 *
 * So an item appears immediately, showing its own preview, and stays until the message it
 * becomes arrives. Three things follow from that:
 *
 *  - The preview is generated locally, from the bytes already in hand. It is the same 256px
 *    thumbnail the send itself will make, so what you see now is what the other side will see.
 *  - `busy` is true while anything is in flight, and the composer uses it to refuse a second
 *    send. Refusing is better than queueing here: two photos racing to the same conversation
 *    would arrive in whichever order the network settled on, not the order they were picked.
 *  - A failure leaves the item in place rather than dropping it, holding the source so a retry
 *    needs no second trip to the picker. Nothing is lost by a dead connection.
 */
import { useCallback, useState } from 'react';

import { useServices } from '@/app/ServicesProvider';
import { describeSendFailure } from '@/messaging/sendFailure';
import { THUMB_MAX_EDGE } from '@/messaging/media';
import type { MediaSource } from '@/messaging/messagingService';
import type { Bytes } from '@/utils/bytes';

export interface OutgoingMedia {
  readonly id: string;
  readonly kind: 'photo' | 'video';
  /** A locally generated preview, so the bubble is never an empty box. */
  readonly preview: Bytes | null;
  /** Kept so a retry needs no second trip to the picker. */
  readonly source: MediaSource;
  readonly failed: boolean;
  /** Why the last attempt failed, in the words the user is shown. Null until one does. */
  readonly problem: string | null;
  /**
   * False when nothing about tapping again could change the outcome -- not Pro, a rules refusal,
   * a source file that is gone. The bubble withdraws its retry rather than offering one that is
   * certain to fail the same way.
   */
  readonly retryable: boolean;
}

export interface OutgoingMediaController {
  readonly items: readonly OutgoingMedia[];
  /** True while anything is uploading. The composer refuses a second send while it is. */
  readonly busy: boolean;
  send: (source: MediaSource) => Promise<void>;
  retry: (id: string) => Promise<void>;
  dismiss: (id: string) => void;
}

export function useOutgoingMedia(
  deliver: (source: MediaSource) => Promise<void>,
): OutgoingMediaController {
  const services = useServices();
  const [items, setItems] = useState<readonly OutgoingMedia[]>([]);

  const previewFor = useCallback(
    async (source: MediaSource): Promise<Bytes | null> => {
      try {
        if (source.kind === 'video') {
          return (await services.videoThumbnails.generate(source.uri, THUMB_MAX_EDGE)).jpegBytes;
        }
        const bytes = source.bytes ?? (await services.fs.readBytes(source.uri));
        return (await services.thumbnails.generate({ bytes }, THUMB_MAX_EDGE)).jpegBytes;
      } catch {
        // A bubble with no preview is still better feedback than no bubble at all.
        return null;
      }
    },
    [services],
  );

  const run = useCallback(
    async (id: string, source: MediaSource): Promise<void> => {
      setItems((prev) =>
        prev.map((it) => (it.id === id ? { ...it, failed: false, problem: null } : it)),
      );
      try {
        await deliver(source);
        // The real message is on its way through the listener; this placeholder has done its job.
        setItems((prev) => prev.filter((it) => it.id !== id));
      } catch (caught) {
        // Held, not dropped -- and the reason is held with it. Discarding the error is what made
        // a retry indistinguishable from a dead button: the bubble came back saying the same
        // thing whether the cause was a dropped connection or a server that will never accept it.
        const failure = describeSendFailure(caught);
        setItems((prev) =>
          prev.map((it) =>
            it.id === id
              ? { ...it, failed: true, problem: failure.message, retryable: failure.retryable }
              : it,
          ),
        );
      }
    },
    [deliver],
  );

  const send = useCallback(
    async (source: MediaSource): Promise<void> => {
      const id = `out_${String(Date.now())}_${String(Math.round(Math.random() * 1e6))}`;
      const preview = await previewFor(source);
      setItems((prev) => [
        ...prev,
        { id, kind: source.kind, preview, source, failed: false, problem: null, retryable: true },
      ]);
      await run(id, source);
    },
    [previewFor, run],
  );

  const retry = useCallback(
    async (id: string): Promise<void> => {
      const item = items.find((it) => it.id === id);
      // A hopeless item is not re-run even if something asks: re-running it would clear the
      // reason off the bubble, fail again, and put it back, which is the flicker-free nothing
      // that got reported as a broken button.
      if (item === undefined || !item.retryable) return;
      await run(id, item.source);
    },
    [items, run],
  );

  const dismiss = useCallback((id: string): void => {
    setItems((prev) => prev.filter((it) => it.id !== id));
  }, []);

  return { items, busy: items.some((it) => !it.failed), send, retry, dismiss };
}
