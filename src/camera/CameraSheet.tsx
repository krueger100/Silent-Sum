/**
 * In-vault camera, presented as a bottom sheet over the gallery.
 *
 * `expo-camera` writes every capture to a plaintext JPEG in the app's cache directory; there is no
 * API that hands back bytes only. So the capture path is: take the picture, read it into memory,
 * and securely delete that cache file in a `finally` -- on success, on failure, and when the sheet
 * has already been dismissed. The temp file never outlives the capture, and nothing is ever
 * written to the OS gallery.
 *
 * A capture is *not* stored straight away. It is held in memory and shown back for review, so the
 * photo that reaches the vault is one the user chose to keep. The review image is an in-memory
 * `data:` URI, like every other decrypted image in this app: nothing plaintext touches disk. The
 * held bytes are zeroed on discard, after a successful save, and on unmount -- including the
 * unmount that a vault lock causes, so a pending review cannot outlive the session.
 *
 * The permission prompt sends the app to the background, so auto-lock is suspended around it the
 * same way the photo picker does it.
 *
 * Getting a *real* frame out of CameraX takes three precautions, because a camera that is not
 * ready yet still answers `takePictureAsync` -- with a black frame:
 *
 *  1. The shutter waits for `onCameraReady`. The plugin documents this as a precondition of
 *     `takePictureAsync`, and skipping it is the usual cause of an all-black capture.
 *  2. No resolution is ever requested. `pictureSize` and `ratio` only feed CameraX's
 *     `ResolutionSelector`, so naming one can only override the configuration CameraX already
 *     chose for the active camera -- which is supported by definition. (The symptom that once
 *     looked like an ignored `pictureSize`, a still of exactly the preview view's pixel size, was
 *     `expo-camera` never calling the camera at all on an emulator; see
 *     `patches/expo-camera+57.0.5.patch`.)
 *  3. Every capture is inspected before it is offered for review ({@link CaptureInspector}). A
 *     blank or truncated frame is retried after a settling pause and, if it stays bad, discarded
 *     with a message rather than shown or stored: the vault is the only copy, so keeping a black
 *     rectangle would lose the photo silently.
 *
 * Video follows the same shape with one unavoidable difference. A recording is written to the
 * app-private cache by CameraX as it is captured -- there is no in-memory form to hold instead --
 * so the review stage plays that cache file directly rather than a `data:` URI. It is securely
 * deleted the moment the user keeps or discards it, on unmount, and on the unmount a vault lock
 * causes; keeping it encrypts it into the vault first and then deletes it. Nothing is ever written
 * to Pictures or DCIM in either mode.
 *
 * Recordings are SILENT. `mute` is set on the camera, which is what keeps `RECORD_AUDIO` out of
 * the manifest entirely (it is in `blockedPermissions` in app.config.ts): a calculator that asks
 * for the microphone is a calculator nobody installs. Enabling audio later means unblocking that
 * permission and dropping `mute`, and nothing else.
 *
 * A KEPT CAPTURE HAS TWO POSSIBLE DESTINATIONS, and exactly one prop decides which. Mounted
 * without {@link CameraSheetProps.onCapture} -- how the gallery mounts it -- "Keep" encrypts the
 * capture into the vault, under the vault's own entitlement gate, as it always has. Mounted WITH
 * it -- how a conversation mounts it -- "Keep" hands the capture over and the vault is not
 * involved at all: no repository, no 50-item cap, no 100 MB per-item cap, no import. Those rules
 * are about what the VAULT holds, and a photo on its way to a chat never becomes a vault item;
 * the chat has its own Pro gate, its own size ceilings and its own encryption, and the capture
 * joins them at the same place an item picked from the photo library does.
 *
 * Everything above about plaintext still holds in both modes. What changes is who owns it: a
 * handed-over photo is a COPY, because this sheet zeroes its own buffer the moment the decision
 * is made, and a handed-over recording is a file this sheet stops tracking, so the duty to delete
 * it travels with the URI.
 */
import {
  CameraView,
  useCameraPermissions,
  type CameraCapturedPicture,
  type CameraType,
  type FlashMode,
} from 'expo-camera';
import { Image } from 'expo-image';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';

import { useServices } from '@/app/ServicesProvider';
import { radius, spacing, type Palette, typography, useStyles, useTheme } from '@/app/theme';
import { upsellMessage } from '@/billing/screens/VaultUpsellDialog';
import type { CaptureInspector, CaptureRejection } from '@/camera/captureInspector';
import { Button } from '@/components/Button';
import { Paragraph } from '@/components/Screen';
import { toBase64 } from '@/crypto/sodium';
import { openRepository } from '@/gallery/vaultAccess';
import { VideoSurface } from '@/gallery/VideoSurface';
import { formatDuration } from '@/vault/mediaKind';
import { zeroBytes, type Bytes } from '@/utils/bytes';

const FLASH_CYCLE: readonly FlashMode[] = ['off', 'auto', 'on'];

type CaptureMode = 'photo' | 'video';

/**
 * A recording is a plaintext file in the cache until it is kept, so it has a ceiling. Five minutes
 * of 1080p is roughly 500 MB, which is already more than a phone should be asked to hold twice.
 */
const MAX_VIDEO_SECONDS = 300;
/** How often the on-screen recording timer ticks. */
const TIMER_INTERVAL_MS = 200;

/** A recording waiting to be kept or discarded. Plaintext on disk, and nowhere else. */
interface PendingVideo {
  readonly uri: string;
  readonly durationMs: number;
}

/** How many times a blank or malformed frame is re-taken before the capture is given up on. */
const MAX_ATTEMPTS = 3;
/** Pause before a retry, to let exposure and focus settle on a camera that answered too early. */
const SETTLE_MS = 450;
/** A camera that never reports itself ready is a failed capture, not a frozen shutter. */
const READY_TIMEOUT_MS = 6000;

const REJECTION_NOTICE: Record<CaptureRejection, string> = {
  blank: 'The camera returned a blank frame. Nothing was saved -- try again.',
  malformed: 'The camera returned an unreadable image. Nothing was saved -- try again.',
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Resolves when the preview reports itself ready, or rejects once {@link READY_TIMEOUT_MS} has
 * passed -- a camera that never starts must fail the capture, not hang the shutter forever.
 */
function waitForReady(
  waiters: React.RefObject<(() => void)[]>,
  ready: React.RefObject<boolean>,
  timeoutMs: number = READY_TIMEOUT_MS,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('camera never became ready'));
    }, timeoutMs);
    waiters.current.push(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
    // The camera may have become ready between the caller's check and this subscription.
    if (ready.current && !settled) {
      settled = true;
      clearTimeout(timer);
      resolve();
    }
  });
}

/** The capture options never name a resolution: the camera's own configuration is the one used. */
async function takePicture(camera: CameraView): Promise<CameraCapturedPicture | undefined> {
  return camera.takePictureAsync({ quality: 1, base64: false, exif: false, skipProcessing: false });
}

/**
 * A kept capture, handed to a caller instead of being encrypted into the vault.
 *
 * A photo is bytes, which is the form it is already in: `expo-camera`'s plaintext cache file was
 * overwritten and unlinked back in the capture, so there is no file left to own. A video is a URI,
 * because a recording is only ever a file -- CameraX writes it as it records and there is no
 * in-memory form to hand over instead.
 */
export type CameraCapture =
  | { readonly kind: 'photo'; readonly bytes: Bytes }
  | { readonly kind: 'video'; readonly uri: string; readonly durationMs: number };

export interface CameraSheetProps {
  visible: boolean;
  onClose: () => void;
  /**
   * Where a kept capture goes INSTEAD of the vault. Absent, and the vault behaviour is exactly
   * what it was; present, and no part of this sheet opens the vault or consults its caps.
   *
   * THE RECEIVER OWNS WHAT IT IS GIVEN. For a video that is the plaintext recording: this sheet
   * drops it from its own tracking the moment it is handed over, so whoever takes it must delete
   * it once the send no longer needs it -- nobody else will. For a photo it is a buffer to zero
   * when finished with; the copy handed over is not the one this sheet wipes.
   */
  onCapture?: (capture: CameraCapture) => void;
}

export function CameraSheet({
  visible,
  onClose,
  onCapture,
}: CameraSheetProps): React.JSX.Element | null {
  const colors = useTheme();
  const styles = useStyles(makeStyles);
  const services = useServices();
  const [permission, requestPermission] = useCameraPermissions();
  /** Whether this sheet is feeding a conversation rather than the vault. */
  const toChat = onCapture !== undefined;

  const [facing, setFacing] = useState<CameraType>('back');
  const [flash, setFlash] = useState<FlashMode>('off');
  const [mode, setMode] = useState<CaptureMode>('photo');
  const [capturing, setCapturing] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** The capture waiting to be kept or discarded, as an in-memory image. Null while shooting. */
  const [review, setReview] = useState<string | null>(null);
  const [pendingVideo, setPendingVideo] = useState<PendingVideo | null>(null);

  const cameraRef = useRef<CameraView | null>(null);
  // A ref, not the `capturing` state: a second tap in the same frame must be rejected before
  // React has had a chance to re-render.
  const captureInFlight = useRef(false);
  const mounted = useRef(true);
  const askedOnce = useRef(false);
  // `onCameraReady` is a precondition of takePictureAsync. A ref so an already-ready camera is
  // shot without an intervening await, and a waiter list so a tap that beats it simply queues.
  const cameraReady = useRef(false);
  const readyWaiters = useRef<(() => void)[]>([]);
  /** The plaintext bytes behind {@link review}. Held only between the capture and the decision. */
  const pending = useRef<Bytes | null>(null);
  /** The recording behind {@link pendingVideo}, so teardown can delete it without React state. */
  const pendingVideoUri = useRef<string | null>(null);
  const recordingStartedAt = useRef(0);
  /**
   * Bumped every time the sheet is closed. A capture that is still in flight compares the value it
   * started with against the current one, and throws its result away if they differ -- the sheet
   * only ever *hides* (the gallery keeps it mounted), so "am I still mounted?" is not the question.
   * Without this, closing mid-recording would leave the finished recording sitting in the cache as
   * plaintext, queued for a review the user will never see.
   */
  const captureGeneration = useRef(0);
  /**
   * Secure delete, reachable from the unmount cleanup. The cleanup runs once, with the services of
   * the first render captured in its closure; a recording that finishes after a vault lock has to
   * be deleted with whatever is current, so it is read from a ref instead.
   */
  const secureDeleteRef = useRef(services.secureDelete);
  useEffect(() => {
    secureDeleteRef.current = services.secureDelete;
  }, [services]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // A dismissal, or the unmount a vault lock causes, must not leave plaintext in memory...
      zeroBytes(pending.current);
      pending.current = null;
      // ...nor a plaintext recording on disk. Fire and forget: the unmount cannot await.
      const stranded = pendingVideoUri.current;
      pendingVideoUri.current = null;
      if (stranded !== null) void secureDeleteRef.current.file(stranded);
    };
  }, []);

  /** Ticks the on-screen timer. Display only; the stored duration is measured from the clock. */
  useEffect(() => {
    if (!recording) return undefined;
    const timer = setInterval(() => {
      setElapsedMs(Date.now() - recordingStartedAt.current);
    }, TIMER_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [recording]);

  /** Drops a pending capture without storing it. */
  const dropPending = useCallback(() => {
    zeroBytes(pending.current);
    pending.current = null;
    setReview(null);
    const stranded = pendingVideoUri.current;
    pendingVideoUri.current = null;
    setPendingVideo(null);
    // The recording is plaintext; discarding it means overwriting it, not just forgetting it.
    if (stranded !== null) void services.secureDelete.file(stranded);
  }, [services]);

  const close = useCallback(() => {
    // A sheet dismissed mid-recording must still finish the recording so its file can be deleted;
    // CameraX would otherwise keep writing to a file nobody is tracking any more.
    if (recording) cameraRef.current?.stopRecording();
    captureGeneration.current += 1;
    dropPending();
    setNotice(null);
    cameraReady.current = false;
    onClose();
  }, [dropPending, onClose, recording]);

  // While the sheet is up, the system back gesture closes it instead of leaving the gallery.
  useEffect(() => {
    if (!visible) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => {
      subscription.remove();
    };
  }, [close, visible]);

  const handleCameraReady = useCallback(() => {
    cameraReady.current = true;
    const waiters = readyWaiters.current.splice(0);
    for (const waiter of waiters) waiter();
  }, []);

  // The preview is torn down on a flip, so the next capture must wait for the new one again.
  const handleMountError = useCallback(() => {
    cameraReady.current = false;
  }, []);

  const ask = useCallback(() => {
    // Suspends for exactly the system dialog, resumed however it ends.
    services.autoLockSuspension.suspend();
    void (async () => {
      try {
        await requestPermission();
      } catch {
        // A denied prompt is reported through `permission`, not by throwing; anything else is
        // equivalent to "still not granted".
      } finally {
        services.autoLockSuspension.resume();
      }
    })();
  }, [requestPermission, services]);

  // One automatic prompt when the OS is still willing to ask. After that it is the user's move.
  useEffect(() => {
    if (!visible) return;
    if (askedOnce.current) return;
    if (permission === null || permission.granted || !permission.canAskAgain) return;
    askedOnce.current = true;
    ask();
  }, [ask, permission, visible]);

  /**
   * Null when the vault would accept one more item, otherwise the notice to show instead of
   * capturing anything. Asked BEFORE the camera runs: a frame that could not be kept is a
   * plaintext file that never needed to exist.
   *
   * Always null in chat mode. A capture bound for a conversation never becomes a vault item, so
   * the vault's 50-item free cap has nothing to say about it -- the chat's own gate is Pro, and
   * it is enforced by the security rules rather than here.
   */
  const vaultRefusal = useCallback((): string | null => {
    if (toChat) return null;
    const gate = services.entitlements.gate(openRepository(services)?.photos.length ?? 0, 0);
    return gate.allowed ? null : upsellMessage(gate.reason);
  }, [services, toChat]);

  const capture = useCallback(() => {
    if (captureInFlight.current) return;
    const camera = cameraRef.current;
    if (camera === null) return;
    // The vault is the destination only when no conversation is waiting for this capture, so
    // only then is its lock a precondition of the shutter. Whether messaging itself can run is the
    // send's own business: it reports `locked` through the tray, in the right words.
    if (!toChat && openRepository(services) === null) {
      setNotice('The vault is locked.');
      return;
    }
    const refusal = vaultRefusal();
    if (refusal !== null) {
      setNotice(refusal);
      return;
    }
    const inspector: CaptureInspector = services.captureInspector;

    captureInFlight.current = true;
    const generation = captureGeneration.current;
    setCapturing(true);
    setNotice(null);

    void (async () => {
      let outcome: 'captured' | 'failed' | CaptureRejection = 'failed';
      let captured: Bytes | null = null;
      try {
        // Nothing is awaited when the camera is already ready: the shutter stays immediate.
        if (!cameraReady.current) await waitForReady(readyWaiters, cameraReady);

        for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
          let bytes: Bytes | null = null;
          let tempUri: string | null = null;
          let fatal = false;
          try {
            // A camera that answered too early needs time, not a different configuration.
            if (attempt > 0) await delay(SETTLE_MS);

            const picture = await takePicture(camera);
            if (picture === undefined) throw new Error('capture produced no image');
            tempUri = picture.uri;
            bytes = await services.fs.readBytes(tempUri);

            const verdict = await inspector.inspect({ bytes, uri: tempUri });
            if (!verdict.ok) {
              // Never offered for review: a black or truncated frame is not a photo.
              outcome = verdict.reason;
              continue;
            }

            captured = bytes;
            outcome = 'captured';
          } catch {
            // The reason is never surfaced or logged: it can carry the cache file's path.
            outcome = 'failed';
            fatal = true;
          } finally {
            // The kept buffer is zeroed when the decision is made, not here.
            if (bytes !== captured) zeroBytes(bytes);
            // Runs even when the sheet is gone: a dismissal must not strand a plaintext JPEG.
            if (tempUri !== null) await services.secureDelete.file(tempUri);
          }
          if (outcome === 'captured' || fatal) break;
        }
      } catch {
        outcome = 'failed';
      }

      const dataUri = captured === null ? null : `data:image/jpeg;base64,${toBase64(captured)}`;
      captureInFlight.current = false;
      const abandoned = !mounted.current || generation !== captureGeneration.current;
      if (abandoned || dataUri === null) {
        // Nothing to review: either it failed, or the sheet is gone and the bytes must not linger.
        zeroBytes(captured);
      } else {
        zeroBytes(pending.current);
        pending.current = captured;
        setReview(dataUri);
      }
      if (mounted.current) {
        setCapturing(false);
        if (outcome !== 'captured' && !abandoned) {
          setNotice(outcome === 'failed' ? 'Could not take the photo.' : REJECTION_NOTICE[outcome]);
        }
      }
    })();
  }, [services, toChat, vaultRefusal]);

  /**
   * `recordAsync` does not resolve until `stopRecording` is called (or the cap is reached), so the
   * whole recording lives inside this one promise. The file it produces is plaintext, and from the
   * moment it exists it is tracked in a ref so that every exit -- keep, discard, close, lock --
   * has something to delete.
   */
  const startRecording = useCallback(() => {
    if (captureInFlight.current) return;
    const camera = cameraRef.current;
    if (camera === null) return;
    if (!toChat && openRepository(services) === null) {
      setNotice('The vault is locked.');
      return;
    }

    captureInFlight.current = true;
    const generation = captureGeneration.current;
    recordingStartedAt.current = Date.now();
    setElapsedMs(0);
    setRecording(true);
    setNotice(null);

    void (async () => {
      let uri: string | null = null;
      try {
        if (!cameraReady.current) await waitForReady(readyWaiters, cameraReady);
        // Re-stamped after the wait: a camera that took a moment to bind must not be counted as
        // part of the recording, or the stored length would be longer than the video.
        recordingStartedAt.current = Date.now();
        const result = await camera.recordAsync({ maxDuration: MAX_VIDEO_SECONDS });
        uri = result?.uri ?? null;
      } catch {
        // The reason is never surfaced or logged: it can carry the cache file's path.
        uri = null;
      }
      const durationMs = Date.now() - recordingStartedAt.current;
      captureInFlight.current = false;

      if (uri === null) {
        if (mounted.current) {
          setRecording(false);
          if (generation === captureGeneration.current) {
            setNotice('Could not record the video.');
          }
        }
        return;
      }
      if (!mounted.current || generation !== captureGeneration.current) {
        // The sheet was closed or unmounted while this was recording: the file it produced is
        // plaintext and belongs to nobody, so it goes rather than waiting for a review.
        if (mounted.current) setRecording(false);
        await secureDeleteRef.current.file(uri);
        return;
      }
      pendingVideoUri.current = uri;
      setPendingVideo({ uri, durationMs });
      setRecording(false);
    })();
  }, [services, toChat]);

  const stopRecording = useCallback(() => {
    cameraRef.current?.stopRecording();
  }, []);

  const keep = useCallback(() => {
    const bytes = pending.current;
    const video = pendingVideo;
    if (bytes === null && video === null) return;

    // Handed to the conversation, and this sheet is done. Nothing below this branch runs: no
    // repository is opened, no entitlement is gated, nothing is encrypted here. The chat pipeline
    // does all three, under its own rules, exactly as it does for a picked item.
    if (onCapture !== undefined) {
      if (video !== null) {
        // Ownership of the plaintext recording travels with the URI. Dropped from the ref FIRST,
        // because `close` securely deletes whatever is still in it -- which would otherwise wipe
        // the file out from under a send that has not read it yet.
        pendingVideoUri.current = null;
        onCapture({ kind: 'video', uri: video.uri, durationMs: video.durationMs });
      } else if (bytes !== null) {
        // A copy. `close` zeroes ours, and handing over the same array would deliver a photo of
        // nothing but zeroes.
        onCapture({ kind: 'photo', bytes: bytes.slice() });
      }
      close();
      return;
    }

    const repository = openRepository(services);
    if (repository === null) {
      setNotice('The vault is locked.');
      return;
    }
    setSaving(true);
    void (async () => {
      try {
        if (video !== null) {
          // The size cap can only be checked here. The mode-switch gate runs before anything is
          // recorded, when the file does not exist and its length is unknown; a long take is the
          // easiest way to pass that gate and still produce an item the vault will not accept.
          // Asked of the file rather than read from it, so a 500 MB recording costs no memory.
          const gate = services.entitlements.gate(
            repository.photos.length,
            await services.fs.size(video.uri),
          );
          if (!gate.allowed) {
            if (mounted.current) setNotice(upsellMessage(gate.reason));
            return;
          }
          // The recording is read from its cache file straight into the cipher, a chunk at a time:
          // its bytes are never a JS buffer, so length is not a memory problem.
          await repository.addVideo(
            { uri: video.uri, durationMs: video.durationMs },
            { source: 'camera' },
          );
        } else if (bytes !== null) {
          await repository.addPhoto({ bytes }, { source: 'camera' });
        }
        if (mounted.current) setNotice('Saved to vault');
      } catch {
        // The reason is never surfaced: it can carry a path.
        if (mounted.current) {
          setNotice(video === null ? 'Could not save the photo.' : 'Could not save the video.');
        }
      } finally {
        // Deletes the plaintext recording whether the save worked or not.
        dropPending();
        if (mounted.current) setSaving(false);
      }
    })();
  }, [close, dropPending, onCapture, pendingVideo, services]);

  const discard = useCallback(() => {
    const wasVideo = pendingVideo !== null;
    dropPending();
    setNotice(wasVideo ? 'Video discarded.' : 'Photo discarded.');
  }, [dropPending, pendingVideo]);

  if (!visible) return null;

  const body = ((): React.JSX.Element => {
    if (permission === null) {
      return (
        <View testID="camera-checking" style={styles.centered}>
          <ActivityIndicator color={colors.text} />
        </View>
      );
    }
    if (!permission.granted) {
      return (
        <View testID="camera-permission" style={styles.centered}>
          <Text style={styles.heading}>Camera access needed</Text>
          <Paragraph>
            Photos and videos you capture here are encrypted straight into the vault and never reach
            your regular gallery. Recordings are silent -- this app never opens the microphone. The
            camera cannot start without permission.
          </Paragraph>
          {permission.canAskAgain ? null : (
            <Paragraph>
              Permission was turned off for this app. Allow camera access in your device settings,
              then come back.
            </Paragraph>
          )}
          <Button
            testID="camera-grant"
            label="Grant permission"
            onPress={ask}
            disabled={!permission.canAskAgain}
            style={styles.stretch}
          />
        </View>
      );
    }
    if (pendingVideo !== null) {
      return (
        <View style={styles.stage}>
          {/* The recording's own cache file, which already exists; nothing new is written. */}
          <VideoSurface
            testID="camera-review-video"
            uri={pendingVideo.uri}
            autoPlay
            accessibilityLabel="The video you just recorded"
          />
        </View>
      );
    }
    if (review !== null) {
      return (
        <View style={styles.stage}>
          <Image
            testID="camera-review-image"
            source={{ uri: review }}
            style={StyleSheet.absoluteFill}
            contentFit="contain"
            cachePolicy="memory"
            transition={0}
            accessibilityLabel="The photo you just took"
          />
        </View>
      );
    }
    return (
      <View style={styles.stage}>
        <CameraView
          testID="camera-preview"
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          facing={facing}
          flash={flash}
          mode={mode === 'video' ? 'video' : 'picture'}
          onCameraReady={handleCameraReady}
          onMountError={handleMountError}
          // The microphone is never opened by this app: stills, and silent recordings.
          mute
          animateShutter={false}
        />
        {recording ? (
          <View style={styles.recordingBadge} pointerEvents="none">
            <View style={styles.recordingDot} />
            <Text testID="camera-timer" style={styles.recordingLabel}>
              {formatDuration(elapsedMs)}
            </Text>
          </View>
        ) : null}
      </View>
    );
  })();

  const reviewing = review !== null || pendingVideo !== null;

  const controls =
    permission?.granted !== true ? null : reviewing ? (
      <View style={styles.decision}>
        <Button
          testID="camera-discard"
          label="Discard"
          variant="secondary"
          onPress={discard}
          disabled={saving}
          style={styles.decisionButton}
        />
        <Button
          testID="camera-keep"
          label="Keep"
          onPress={keep}
          busy={saving}
          disabled={saving}
          style={styles.decisionButton}
        />
      </View>
    ) : (
      <View style={styles.shutterRow}>
        <View style={styles.modeSwitch}>
          {(['photo', 'video'] as const).map((option) => (
            <Pressable
              key={option}
              testID={`camera-mode-${option}`}
              accessibilityRole="button"
              accessibilityLabel={option === 'photo' ? 'Photo mode' : 'Video mode'}
              accessibilityState={{ selected: mode === option, disabled: capturing || recording }}
              // Switching mode rebinds the camera's use cases, which a capture in flight would not
              // survive; the tab is simply inert until the shutter is free.
              disabled={capturing || recording}
              onPress={() => {
                setNotice(null);
                if (option === 'video') {
                  // A video is one vault item like any other, so a full free vault refuses it.
                  // Refused HERE, before the camera is rebound for video, so no recording can
                  // ever be started that could not be kept. The size is unknown until the file
                  // exists, so only the item count is asked about; the size is checked once the
                  // recording exists. In chat mode there is nothing to refuse: see
                  // `vaultRefusal`, and the chat's own ceiling is applied by the send.
                  const refusal = vaultRefusal();
                  if (refusal !== null) {
                    setNotice(refusal);
                    return;
                  }
                }
                // Switching mode rebinds CameraX's use cases, so the next capture has to wait for
                // the new session to report ready -- exactly as a flip does.
                cameraReady.current = false;
                setMode(option);
              }}
              style={[styles.modeTab, mode === option ? styles.modeTabActive : null]}
            >
              <Text style={[styles.modeLabel, mode === option ? styles.modeLabelActive : null]}>
                {option === 'photo' ? 'Photo' : 'Video'}
              </Text>
            </Pressable>
          ))}
        </View>
        {mode === 'photo' ? (
          <Pressable
            testID="camera-shutter"
            accessibilityRole="button"
            accessibilityLabel="Take photo"
            accessibilityState={{ busy: capturing, disabled: capturing }}
            onPress={capture}
            style={[styles.shutter, capturing ? styles.shutterBusy : null]}
          >
            <View style={styles.shutterInner}>
              {capturing ? <ActivityIndicator color={colors.background} /> : null}
            </View>
          </Pressable>
        ) : (
          <Pressable
            testID="camera-record"
            accessibilityRole="button"
            accessibilityLabel={recording ? 'Stop recording' : 'Start recording'}
            accessibilityState={{ busy: recording }}
            onPress={recording ? stopRecording : startRecording}
            style={[styles.shutter, styles.recordRing]}
          >
            <View style={recording ? styles.recordStop : styles.recordInner} />
          </Pressable>
        )}
      </View>
    );

  return (
    <View testID="camera-sheet" style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <Pressable
        testID="camera-sheet-scrim"
        accessibilityRole="button"
        accessibilityLabel="Close camera"
        style={styles.scrim}
        onPress={close}
      />
      <View style={styles.sheet}>
        <View style={styles.grabber} />
        <View style={styles.header}>
          <Text style={styles.title}>
            {pendingVideo !== null
              ? 'Keep this video?'
              : review !== null
                ? 'Keep this photo?'
                : 'Camera'}
          </Text>
          <View style={styles.headerActions}>
            {permission?.granted === true && !reviewing ? (
              <>
                <Pressable
                  testID="camera-flash"
                  accessibilityRole="button"
                  accessibilityLabel={`Flash ${flash}`}
                  disabled={capturing || recording}
                  onPress={() => {
                    setFlash((current) => {
                      const next = FLASH_CYCLE.indexOf(current) + 1;
                      return FLASH_CYCLE[next % FLASH_CYCLE.length] ?? 'off';
                    });
                  }}
                  hitSlop={10}
                  style={styles.headerAction}
                >
                  <Text style={styles.headerActionLabel}>{`Flash ${flash}`}</Text>
                </Pressable>
                <Pressable
                  testID="camera-flip"
                  accessibilityRole="button"
                  accessibilityLabel="Switch camera"
                  disabled={capturing || recording}
                  onPress={() => {
                    cameraReady.current = false;
                    setFacing((current) => (current === 'back' ? 'front' : 'back'));
                  }}
                  hitSlop={10}
                  style={styles.headerAction}
                >
                  <Text style={styles.headerActionLabel}>Flip</Text>
                </Pressable>
              </>
            ) : null}
            <Pressable
              testID="camera-close"
              accessibilityRole="button"
              accessibilityLabel="Close camera"
              disabled={capturing}
              onPress={close}
              hitSlop={10}
              style={styles.headerAction}
            >
              <Text style={styles.headerActionLabel}>Close</Text>
            </Pressable>
          </View>
        </View>
        {notice === null ? null : (
          <Text testID="camera-notice" style={styles.notice}>
            {notice}
          </Text>
        )}
        {body}
        {controls}
      </View>
    </View>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    scrim: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(0, 0, 0, 0.6)',
    },
    sheet: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      height: '88%',
      backgroundColor: colors.surface,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      paddingHorizontal: spacing.md,
      paddingBottom: spacing.lg,
      gap: spacing.sm,
    },
    grabber: {
      alignSelf: 'center',
      width: 44,
      height: 5,
      borderRadius: radius.pill,
      backgroundColor: colors.text,
      opacity: 0.35,
      marginTop: spacing.sm,
    },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
    headerActions: { flexDirection: 'row', alignItems: 'center' },
    title: { ...typography.title, color: colors.text },
    heading: { ...typography.title, color: colors.text, textAlign: 'center' },
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: spacing.md,
      gap: spacing.sm,
    },
    stretch: { alignSelf: 'stretch', marginTop: spacing.md },
    stage: { flex: 1, backgroundColor: '#000000', borderRadius: radius.md, overflow: 'hidden' },
    shutterRow: { alignItems: 'center', paddingTop: spacing.sm, gap: spacing.sm },
    modeSwitch: {
      flexDirection: 'row',
      backgroundColor: colors.surfaceAlt,
      borderRadius: radius.pill,
      padding: 3,
    },
    modeTab: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      minHeight: 34,
      borderRadius: radius.pill,
      justifyContent: 'center',
    },
    modeTabActive: { backgroundColor: colors.accent },
    modeLabel: { ...typography.label, color: colors.textMuted },
    modeLabelActive: { color: colors.accentText },
    recordRing: { borderColor: colors.danger },
    recordInner: {
      width: 58,
      height: 58,
      borderRadius: radius.pill,
      backgroundColor: colors.danger,
    },
    recordStop: { width: 30, height: 30, borderRadius: radius.sm, backgroundColor: colors.danger },
    recordingBadge: {
      position: 'absolute',
      top: spacing.sm,
      left: spacing.sm,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      borderRadius: radius.pill,
      backgroundColor: 'rgba(0, 0, 0, 0.6)',
    },
    recordingDot: {
      width: 10,
      height: 10,
      borderRadius: radius.pill,
      backgroundColor: colors.danger,
    },
    recordingLabel: { ...typography.label, color: '#FFFFFF' },
    shutter: {
      width: 76,
      height: 76,
      borderRadius: radius.pill,
      borderWidth: 4,
      borderColor: colors.text,
      alignItems: 'center',
      justifyContent: 'center',
    },
    shutterBusy: { opacity: 0.55 },
    shutterInner: {
      width: 58,
      height: 58,
      borderRadius: radius.pill,
      backgroundColor: colors.text,
      alignItems: 'center',
      justifyContent: 'center',
    },
    decision: { flexDirection: 'row', gap: spacing.sm, paddingTop: spacing.sm },
    decisionButton: { flex: 1 },
    headerAction: {
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      minHeight: 40,
      justifyContent: 'center',
    },
    headerActionLabel: { ...typography.label, color: colors.text },
    notice: {
      ...typography.label,
      color: colors.text,
      backgroundColor: colors.background,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.sm,
    },
  });
