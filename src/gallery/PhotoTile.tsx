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
 * A video tile is the same encrypted JPEG -- a poster frame, produced by the same thumbnail
 * pipeline -- with a play badge and its length drawn over it, so a video is recognisable at a
 * glance without a second decrypt path or a second kind of blob.
 */
import { Image } from 'expo-image';
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { radius, type Palette, useStyles } from '@/app/theme';
import { toBase64 } from '@/crypto/sodium';
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
}

export function PhotoTile({
  entry,
  repository,
  size,
  selected,
  selecting,
  onPress,
  onLongPress,
}: PhotoTileProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const [dataUri, setDataUri] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const video = isVideo(entry);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const bytes = await repository.readThumbnail(entry.id);
        if (cancelled) return;
        // `toBase64` copies, so the shared cache buffer being zeroed on lock cannot blank a
        // thumbnail that is already on screen.
        const uri = `data:image/jpeg;base64,${toBase64(bytes)}`;
        if (!cancelled) setDataUri(uri);
      } catch {
        // Locked mid-decrypt, a missing blob, an unreadable thumbnail: all the same to a tile.
        if (!cancelled) setUnavailable(true);
      }
    })();

    return () => {
      cancelled = true;
      // Drops the decoded copy when the tile is reused for another photo and on unmount, so the
      // reset is never a synchronous setState inside the effect body.
      setDataUri(null);
      setUnavailable(false);
    };
  }, [entry.id, repository]);

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
        <View style={[styles.placeholder, unavailable ? styles.placeholderError : null]}>
          {unavailable ? <Text style={styles.placeholderGlyph}>!</Text> : null}
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
