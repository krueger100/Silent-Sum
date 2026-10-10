/**
 * One grid cell.
 *
 * The thumbnail is decrypted lazily when the tile mounts and handed to `expo-image` as a base64
 * data URI. `cachePolicy="memory"` is not a performance choice: expo-image's default policy would
 * write the decoded image into its on-disk cache, which is exactly the plaintext-on-disk this app
 * exists to avoid.
 *
 * The decrypt is cancellation-safe in both directions: an unmounted tile ignores its result, and a
 * vault that locks mid-decrypt makes the repository throw, which renders a neutral placeholder
 * rather than propagating.
 *
 * LOCAL FIRST, ALWAYS. Where the vault still holds the photo the tile reads it from there and no
 * network call happens. `fallback` is for the Cloud Gallery, whose tiles may describe photos this
 * device no longer has a copy of; it is tried only after the local read has failed.
 *
 * A video tile is the same encrypted JPEG -- a poster frame, produced by the same thumbnail
 * pipeline -- with a play badge and its length drawn over it, so a video is recognisable at a
 * glance without a second decrypt path or a second kind of blob.
 */
import { Image } from 'expo-image';
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { radius, type Palette, useStyles } from '@/app/theme';
import { toBase64 } from '@/crypto/sodium';
import type { Bytes } from '@/utils/bytes';
import { formatDuration, isVideo } from '@/vault/mediaKind';
import type { PhotoEntry, VaultRepository } from '@/vault/types';

export interface PhotoTileProps {
  entry: PhotoEntry;
  repository: VaultRepository;
  size: number;
  selected: boolean;
  selecting: boolean;
  onPress: () => void;
  onLongPress: () => void;
  /**
   * Where else to look when the vault has no copy of this photo.
   *
   * Absent in the Local Gallery, where a failed read means the vault locked and the only honest
   * answer is a placeholder. The Cloud Gallery passes one for the tiles whose files are in the
   * cloud, so "Cloud only" shows the photo rather than a grey square.
   *
   * Its presence also decides what a total failure looks like. With no fallback the tile draws
   * the error placeholder, because local data that will not read is a fault worth showing. With
   * one, it draws the neutral placeholder: a thumbnail that could not be fetched is an offline
   * device or a slow network, and marking a perfectly healthy backup as broken would be a lie.
   */
  fallback?: (id: string) => Promise<Bytes>;
  /**
   * A short word drawn over the tile, for a gallery that has to explain a tile it cannot draw.
   *
   * The Local Gallery never passes one: there a tile either shows its photo or the vault has
   * locked, and neither needs explaining. The Cloud Gallery does, because "no bytes on this
   * device" covers three situations with three different answers -- safe in the cloud, repairable
   * from here, or gone for good -- and one grey square for all three tells the user nothing.
   */
  caption?: string;
}

export function PhotoTile({
  entry,
  repository,
  size,
  selected,
  selecting,
  onPress,
  onLongPress,
  fallback,
  caption,
}: PhotoTileProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const [dataUri, setDataUri] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const video = isVideo(entry);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      let bytes: Bytes;
      try {
        bytes = await repository.readThumbnail(entry.id);
      } catch {
        // Locked mid-decrypt, a missing blob, an unreadable thumbnail: all the same to a tile.
        if (cancelled) return;
        if (fallback === undefined) {
          setUnavailable(true);
          return;
        }
        try {
          bytes = await fallback(entry.id);
        } catch {
          // Offline, or the object really is gone. Either way the tile stays neutral and lets
          // its caption do the explaining.
          return;
        }
      }
      if (cancelled) return;
      // `toBase64` copies, so the shared cache buffer being zeroed on lock cannot blank a
      // thumbnail that is already on screen.
      setDataUri(`data:image/jpeg;base64,${toBase64(bytes)}`);
    })();

    return () => {
      cancelled = true;
      // Drops the decoded copy when the tile is reused for another photo and on unmount, so the
      // reset is never a synchronous setState inside the effect body.
      setDataUri(null);
      setUnavailable(false);
    };
  }, [entry.id, fallback, repository]);

  return (
    <Pressable
      testID="gallery-tile"
      accessibilityRole="image"
      accessibilityLabel={video ? 'Video' : 'Photo'}
      accessibilityState={{ selected }}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={250}
      style={[styles.cell, { width: size, height: size }]}
    >
      {dataUri === null ? (
        <View
          testID="gallery-tile-placeholder"
          style={[styles.placeholder, unavailable ? styles.placeholderError : null]}
        >
          {unavailable ? (
            <Text testID="gallery-tile-unavailable" style={styles.placeholderGlyph}>
              !
            </Text>
          ) : null}
        </View>
      ) : (
        <Image
          testID="gallery-tile-image"
          source={{ uri: dataUri }}
          style={styles.image}
          contentFit="cover"
          cachePolicy="memory"
          transition={0}
          accessible={false}
        />
      )}
      {video ? (
        <View style={styles.videoBadge} pointerEvents="none">
          <Text style={styles.videoGlyph}>{'\u25B6'}</Text>
          <Text testID="gallery-tile-duration" style={styles.videoDuration}>
            {formatDuration(entry.durationMs)}
          </Text>
        </View>
      ) : null}
      {caption === undefined ? null : (
        <View style={styles.caption} pointerEvents="none">
          <Text testID="gallery-tile-caption" style={styles.captionText}>
            {caption}
          </Text>
        </View>
      )}
      {selected ? <View style={styles.selectedOverlay} /> : null}
      {selecting ? (
        <View style={[styles.badge, selected ? styles.badgeSelected : null]}>
          <Text style={styles.badgeGlyph}>{selected ? '✓' : ''}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    cell: { backgroundColor: colors.surface, overflow: 'hidden' },
    image: { width: '100%', height: '100%' },
    placeholder: {
      flex: 1,
      backgroundColor: colors.surfaceAlt,
      alignItems: 'center',
      justifyContent: 'center',
    },
    placeholderError: { backgroundColor: colors.surface },
    videoBadge: {
      position: 'absolute',
      left: 6,
      bottom: 6,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: radius.pill,
      backgroundColor: 'rgba(17,24,39,0.72)',
    },
    videoGlyph: { color: '#FFFFFF', fontSize: 10, lineHeight: 14 },
    videoDuration: { color: '#FFFFFF', fontSize: 11, lineHeight: 14, fontWeight: '600' },
    placeholderGlyph: { color: colors.textMuted, fontSize: 20, fontWeight: '600' },
    // Bottom RIGHT: the video badge owns bottom-left and the selection tick owns top-right, so a
    // captioned video in a selecting gallery still shows all three without one covering another.
    caption: {
      position: 'absolute',
      right: 4,
      bottom: 4,
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: radius.pill,
      backgroundColor: 'rgba(17,24,39,0.78)',
    },
    captionText: { color: '#FFFFFF', fontSize: 10, lineHeight: 13, fontWeight: '700' },
    selectedOverlay: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: 'rgba(61,90,254,0.32)',
    },
    badge: {
      position: 'absolute',
      top: 6,
      right: 6,
      width: 24,
      height: 24,
      borderRadius: radius.pill,
      borderWidth: 2,
      borderColor: colors.text,
      backgroundColor: 'rgba(17,24,39,0.55)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    badgeSelected: { backgroundColor: colors.accent, borderColor: colors.accentText },
    badgeGlyph: { color: colors.accentText, fontSize: 14, lineHeight: 16, fontWeight: '700' },
  });
