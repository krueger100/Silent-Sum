/**
 * Full-screen pager over the vault.
 *
 * Only the current page and its two neighbours hold a decoded image: a full-resolution plaintext
 * is megabytes, and a pager that kept every page decoded would hold the entire vault in memory.
 * Pages that scroll out of that window drop their data URI, which is also what makes a lock
 * cheap -- there is very little plaintext left to collect.
 *
 * Pinch-zoom is not implemented (see the report); horizontal paging owns the gesture.
 *
 * A video page cannot work that way: no player takes bytes, so the page decrypts to a file in the
 * playback scratch directory and hands the player that path. The file is released the instant the
 * page leaves the keep-decoded window, on unmount, and whenever the app goes to the background --
 * which is why the page re-prepares itself when it comes back to the foreground, rather than
 * pointing a player at something that has been deleted underneath it.
 */
import { Image } from 'expo-image';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';

import type { Services } from '@/app/services';
import { useServices, usePhotos } from '@/app/ServicesProvider';
import { radius, spacing, type Palette, typography, useStyles, useTheme } from '@/app/theme';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { Screen } from '@/components/Screen';
import { toBase64 } from '@/crypto/sodium';
import {
  formatDimensions,
  formatKind,
  formatSizeBytes,
  formatSource,
  formatTaken,
} from '@/gallery/photoDetails';
import { openRepository } from '@/gallery/vaultAccess';
import { VideoSurface } from '@/gallery/VideoSurface';
import { formatDuration, isVideo } from '@/vault/mediaKind';
import type { PhotoEntry, VaultRepository } from '@/vault/types';

export interface PhotoViewerScreenProps {
  /** Preferred: survives the list shifting under the viewer. */
  initialPhotoId?: string;
  /** Fallback when only the tapped position is known. */
  initialIndex?: number;
  onClose?: () => void;
}

function resolveInitialIndex(
  photos: readonly PhotoEntry[],
  initialPhotoId: string | undefined,
  initialIndex: number | undefined,
): number {
  if (photos.length === 0) return 0;
  if (initialPhotoId !== undefined) {
    const found = photos.findIndex((photo) => photo.id === initialPhotoId);
    if (found >= 0) return found;
  }
  return Math.min(Math.max(initialIndex ?? 0, 0), photos.length - 1);
}

export function PhotoViewerScreen({
  initialPhotoId,
  initialIndex,
  onClose,
}: PhotoViewerScreenProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const services = useServices();
  const photos = usePhotos();
  const { width } = useWindowDimensions();

  const [index, setIndex] = useState(() =>
    resolveInitialIndex(photos, initialPhotoId, initialIndex),
  );
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const repository = openRepository(services);
  const count = photos.length;
  const safeIndex = count === 0 ? 0 : Math.min(index, count - 1);
  const current = photos[safeIndex];

  const onMomentumEnd = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (width <= 0) return;
      const next = Math.round(event.nativeEvent.contentOffset.x / width);
      setIndex(Math.min(Math.max(next, 0), Math.max(0, count - 1)));
    },
    [count, width],
  );

  const confirmDelete = useCallback(() => {
    setConfirmingDelete(false);
    const target = openRepository(services);
    if (current === undefined || target === null) return;
    const id = current.id;
    const wasLast = count <= 1;
    // Leaving first keeps the viewer from rendering a page whose blob is already gone.
    if (wasLast) onClose?.();
    else if (safeIndex >= count - 1) setIndex(Math.max(0, count - 2));
    void (async () => {
      try {
        await target.deletePhotos([id]);
      } catch {
        // Nothing useful to show here; the grid reflects whatever survived.
      }
    })();
  }, [count, current, onClose, safeIndex, services]);

  if (count === 0 || current === undefined || repository === null) {
    return (
      <Screen testID="photo-viewer" title="Item" {...(onClose ? { onBack: onClose } : {})}>
        <View style={styles.centered}>
          <Text style={styles.muted}>This item is no longer available.</Text>
        </View>
      </Screen>
    );
  }

  const currentIsVideo = isVideo(current);

  return (
    <Screen
      testID="photo-viewer"
      title={`${String(safeIndex + 1)} of ${String(count)}`}
      {...(onClose ? { onBack: onClose } : {})}
      actions={
        <>
          <Pressable
            testID="viewer-details"
            accessibilityRole="button"
            accessibilityLabel="Details"
            onPress={() => {
              setDetailsOpen(true);
            }}
            hitSlop={10}
            style={styles.headerAction}
          >
            <Text style={styles.headerActionLabel}>Details</Text>
          </Pressable>
          <Pressable
            testID="viewer-delete"
            accessibilityRole="button"
            accessibilityLabel="Delete"
            onPress={() => {
              setConfirmingDelete(true);
            }}
            hitSlop={10}
            style={styles.headerAction}
          >
            <Text style={[styles.headerActionLabel, styles.destructive]}>Delete</Text>
          </Pressable>
        </>
      }
    >
      <FlatList
        testID="viewer-pager"
        data={photos}
        keyExtractor={(item) => item.id}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        initialScrollIndex={safeIndex}
        getItemLayout={(_data, i) => ({ length: width, offset: width * i, index: i })}
        onMomentumScrollEnd={onMomentumEnd}
        renderItem={({ item, index: i }) => (
          <ViewerPage
            entry={item}
            repository={repository}
            services={services}
            width={width}
            // A video is only prepared when it is the page being looked at: decrypting the
            // neighbours would put two more plaintext recordings on disk for nothing.
            active={isVideo(item) ? i === safeIndex : Math.abs(i - safeIndex) <= 1}
          />
        )}
      />

      {detailsOpen ? (
        <DetailsSheet
          entry={current}
          onClose={() => {
            setDetailsOpen(false);
          }}
        />
      ) : null}

      <ConfirmDialog
        testID="viewer-delete-confirm"
        visible={confirmingDelete}
        title={currentIsVideo ? 'Delete video?' : 'Delete photo?'}
        message={
          currentIsVideo
            ? 'The video is securely erased and cannot be recovered.'
            : 'The photo is securely erased and cannot be recovered.'
        }
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDelete}
        onCancel={() => {
          setConfirmingDelete(false);
        }}
      />
    </Screen>
  );
}

/** One page. Decrypts only while inside the keep-decoded window, and never throws upward. */
function ViewerPage({
  entry,
  repository,
  services,
  width,
  active,
}: {
  entry: PhotoEntry;
  repository: VaultRepository;
  services: Services;
  width: number;
  active: boolean;
}): React.JSX.Element {
  const colors = useTheme();
  const styles = useStyles(makeStyles);
  const video = isVideo(entry);
  const [dataUri, setDataUri] = useState<string | null>(null);
  const [playbackUri, setPlaybackUri] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  /** Bumped when the app returns to the foreground, which re-runs the decrypt after a purge. */
  const [epoch, setEpoch] = useState(0);

  // Backgrounding wipes the playback directory, so a video page has to rebuild its file when the
  // app comes back rather than keep pointing a player at a path that no longer exists.
  useEffect(() => {
    if (!video || !active) return undefined;
    const subscription = AppState.addEventListener('change', (status) => {
      if (status === 'active') setEpoch((current) => current + 1);
    });
    return () => {
      subscription.remove();
    };
  }, [active, video]);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;
    let allocated: string | null = null;
    const scratch = services.playbackScratch;

    void (async () => {
      try {
        if (video) {
          const target = await scratch.allocate();
          allocated = target;
          await repository.readVideoToFile(entry.id, target);
          if (cancelled) return;
          setPlaybackUri(target);
          return;
        }
        const bytes = await repository.readFullImage(entry.id);
        if (cancelled) return;
        const uri = `data:${entry.mimeType};base64,${toBase64(bytes)}`;
        if (!cancelled) setDataUri(uri);
      } catch {
        if (!cancelled) setUnavailable(true);
      }
    })();

    return () => {
      cancelled = true;
      // Leaving the keep-decoded window (or unmounting) drops the plaintext this page was holding:
      // the decoded image from memory, and the decrypted recording from disk.
      setDataUri(null);
      setPlaybackUri(null);
      setUnavailable(false);
      if (allocated !== null) void scratch.release(allocated);
    };
  }, [active, entry.id, entry.mimeType, epoch, repository, services, video]);

  const body = ((): React.JSX.Element => {
    if (video) {
      if (playbackUri !== null) {
        return (
          <VideoSurface
            testID="viewer-page-video"
            uri={playbackUri}
            style={styles.image}
            accessibilityLabel="Video"
          />
        );
      }
      return unavailable ? (
        <Text style={styles.muted}>This video could not be decrypted.</Text>
      ) : (
        <ActivityIndicator testID="viewer-page-loading" color={colors.text} />
      );
    }
    if (dataUri !== null) {
      return (
        <Image
          testID="viewer-page-image"
          source={{ uri: dataUri }}
          style={styles.image}
          contentFit="contain"
          cachePolicy="memory"
          transition={0}
          accessibilityLabel="Photo"
        />
      );
    }
    return unavailable ? (
      <Text style={styles.muted}>This photo could not be decrypted.</Text>
    ) : (
      <ActivityIndicator testID="viewer-page-loading" color={colors.text} />
    );
  })();

  return (
    <View testID="viewer-page" style={[styles.page, { width }]}>
      {body}
    </View>
  );
}

function DetailsSheet({
  entry,
  onClose,
}: {
  entry: PhotoEntry;
  onClose: () => void;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  return (
    <View testID="viewer-details-sheet" style={styles.sheet}>
      <Text style={styles.sheetTitle}>Details</Text>
      <ScrollView contentContainerStyle={styles.sheetRows}>
        <DetailRow label="Type" value={formatKind(entry)} />
        <DetailRow label="Taken" value={formatTaken(entry.createdAt)} />
        <DetailRow label="Dimensions" value={formatDimensions(entry)} />
        {isVideo(entry) ? (
          <DetailRow label="Length" value={formatDuration(entry.durationMs)} />
        ) : null}
        <DetailRow label="Size" value={formatSizeBytes(entry.sizeBytes)} />
        <DetailRow label="Source" value={formatSource(entry)} />
        <DetailRow label="Storage" value="Encrypted on this device" />
      </ScrollView>
      <Button testID="viewer-details-close" label="Close" variant="secondary" onPress={onClose} />
    </View>
  );
}

function DetailRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>{value}</Text>
    </View>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    page: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.background,
    },
    image: { width: '100%', height: '100%' },
    centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },
    muted: { ...typography.body, color: colors.textMuted, textAlign: 'center' },
    headerAction: {
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      minHeight: 40,
      justifyContent: 'center',
    },
    headerActionLabel: { ...typography.label, color: colors.text },
    destructive: { color: colors.danger },
    sheet: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: colors.surface,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      padding: spacing.lg,
      gap: spacing.sm,
      maxHeight: '70%',
    },
    sheetTitle: { ...typography.title, color: colors.text },
    sheetRows: { gap: spacing.xs, paddingBottom: spacing.sm },
    detailRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
      paddingVertical: spacing.xs,
    },
    detailLabel: { ...typography.label, color: colors.textMuted, width: 110 },
    detailValue: { ...typography.body, color: colors.text, flex: 1 },
  });
