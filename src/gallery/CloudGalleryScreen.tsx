/**
 * What this account has in the cloud -- and only this account.
 *
 * The list comes from the account's own encrypted index, read with the vault's keys. There is no
 * local record of "what is backed up" anywhere, per account or otherwise, so there is nothing that
 * could show one account another's photos: ask while signed in as somebody else and you read a
 * different index, sealed under a different key.
 *
 * Tiles are drawn from the LOCAL copy where there still is one, which is the ordinary case since
 * these were chosen on this device. Where there is not, the thumbnail is fetched from this
 * account's own Storage and decrypted with this vault's thumb key -- see `CloudThumbnails` for
 * why that needs no key this vault does not already have, and for what it does with the plaintext.
 * Only the tiles whose files really are in the cloud ask for one, so a "Lost" tile makes no
 * request and an offline device simply keeps its placeholder.
 *
 * Either way the tile says WHICH of three things is true, because they are not the same situation
 * and only one of them can be acted on:
 *
 *   - "Cloud only" -- the files are in the cloud and this device deleted its copy. A restore
 *     brings it back. This is the backup doing exactly the job it exists for.
 *   - "Repair" -- the cloud's files are missing or half-uploaded, but this device still has the
 *     photo, so "Back up now" can put them back.
 *   - "Lost" -- the cloud's files are gone AND this device has no copy. Nothing recovers it, and
 *     saying so plainly is all that is left. This case used to draw an unexplained grey square
 *     sitting among photos that were perfectly fine.
 *
 * The index is never quietly edited to make one of these disappear. An entry whose files have gone
 * is still the record of what the user chose, and dropping it would destroy the only evidence the
 * photo was ever meant to be there. "Remove from Cloud" is how an entry goes, when the user says.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { usePhotos, useServices } from '@/app/ServicesProvider';
import { radius, spacing, type Palette, typography, useStyles } from '@/app/theme';
import { describeCloudError } from '@/backup/screens/cloudErrors';
import type { CloudContents } from '@/backup/types';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { Paragraph, Screen } from '@/components/Screen';
import { gridColumns } from '@/gallery/gridColumns';
import { PhotoTile } from '@/gallery/PhotoTile';
import { openRepository } from '@/gallery/vaultAccess';
import type { PhotoEntry } from '@/vault/types';

const GAP = 4;
const EDGE = 4;

export interface CloudGalleryScreenProps {
  onBack?: () => void;
  /** Opens the Cloud backup screen, which is where signing in, repairing and restoring live. */
  onOpenBackup?: () => void;
}

/**
 * What is true of one entry, given the index, Storage, and this device.
 *
 * `unchecked` is its own state rather than an optimistic `present`: when Storage could not be
 * listed the app does not know which files are still there, and a tile that looks healthy would
 * be a promise it cannot keep.
 */
type TileState = 'present' | 'cloudOnly' | 'repairable' | 'lost' | 'unchecked';

/** The word drawn on the tile. Null where the photo speaks for itself, or where nothing is known. */
const CAPTIONS: Readonly<Record<TileState, string | null>> = {
  present: null,
  unchecked: null,
  cloudOnly: 'Cloud only',
  repairable: 'Repair',
  lost: 'Lost',
};

/** Bytes as the plain-language figure a storage line wants. Plaintext sizes, from the index. */
function describeSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const mb = bytes / (1024 * 1024);
  if (mb < 1) return `${(bytes / 1024).toFixed(0)} KB`;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

export function CloudGalleryScreen({
  onBack,
  onOpenBackup,
}: CloudGalleryScreenProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const services = useServices();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const localPhotos = usePhotos();

  const [contents, setContents] = useState<CloudContents | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const repository = openRepository(services);

  /**
   * The thumbnail source for tiles with no local copy.
   *
   * Passed only where the cloud is known to hold the files. `idsFullyUploaded` counts an id
   * complete only when both its photo and its thumbnail are listed, so a `cloudOnly` tile is one
   * whose thumbnail object exists -- and a `repairable` or `lost` tile is not asked for, because
   * there is nothing there to fetch. `unchecked` is included because the listing failed and the
   * app does not know; a request that 404s costs one round trip and leaves the tile as it was.
   *
   * `requireKeys` throws on a locked vault. That is read inside the call rather than captured, so
   * a tile that resolves after a lock cannot hold a key the session has dropped.
   */
  const fetchCloudThumbnail = useCallback(
    async (id: string) => services.cloudThumbnails.read(services.session.requireKeys(), id),
    [services],
  );
  const selecting = selectedIds.size > 0;
  const contentWidth = width - insets.left - insets.right;
  const columns = gridColumns(contentWidth);
  const tileSize = Math.floor((contentWidth - EDGE * 2 - GAP * (columns - 1)) / columns);

  const load = useCallback(() => {
    void (async () => {
      setBusy(true);
      const backup = services.backup;
      const cloud = services.firebase.cloud;
      try {
        if (backup === null || cloud === null) {
          setContents({ kind: 'none' });
          setNotice('Cloud backup is not available in this build.');
          return;
        }
        if (cloud.currentUser === null) {
          setContents({ kind: 'none' });
          setNotice('Sign in under Cloud backup to use a Cloud Gallery.');
          return;
        }
        const answer = await backup.cloudContents(services.session.requireKeys());
        if (!mounted.current) return;
        setContents(answer);
        setNotice(null);
      } catch (cause) {
        if (!mounted.current) return;
        setContents({ kind: 'none' });
        setNotice(describeCloudError(cause));
      } finally {
        if (mounted.current) setBusy(false);
      }
    })();
  }, [services]);

  useEffect(() => {
    load();
  }, [load]);

  const entries: readonly PhotoEntry[] = useMemo(
    () => (contents !== null && contents.kind === 'listed' ? contents.entries : []),
    [contents],
  );

  const totalBytes = useMemo(
    () => entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    [entries],
  );

  /** Which ids this device still holds, so a missing cloud file can be told from a lost photo. */
  const localIds = useMemo(
    () => new Set(localPhotos.map((photo) => photo.id)),
    [localPhotos],
  );

  /** Null when Storage could not be listed; an empty set when it was listed and nothing was gone. */
  const missing = useMemo<ReadonlySet<string> | null>(() => {
    if (contents === null || contents.kind !== 'listed' || contents.missing === null) return null;
    return new Set(contents.missing);
  }, [contents]);

  const stateOf = useCallback(
    (id: string): TileState => {
      if (missing === null) return 'unchecked';
      const here = localIds.has(id);
      if (missing.has(id)) return here ? 'repairable' : 'lost';
      return here ? 'present' : 'cloudOnly';
    },
    [localIds, missing],
  );

  const counts = useMemo(() => {
    let repairable = 0;
    let lost = 0;
    for (const entry of entries) {
      const state = stateOf(entry.id);
      if (state === 'repairable') repairable += 1;
      else if (state === 'lost') lost += 1;
    }
    return { repairable, lost };
  }, [entries, stateOf]);

  const toggle = useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  /**
   * Takes the chosen photos out of the cloud. The local copies are not read, not opened, and not
   * touched -- removing a backup is not a statement about the photo on this device.
   */
  const removeSelected = useCallback(() => {
    const ids = [...selectedIds];
    const backup = services.backup;
    setConfirming(false);
    clearSelection();
    if (backup === null || ids.length === 0) return;
    setBusy(true);
    void (async () => {
      try {
        const removed = await backup.removeFromCloud(services.session.requireKeys(), ids);
        if (!mounted.current) return;
        setNotice(`Removed ${plural(removed, 'photo')} from the cloud. Local copies are untouched.`);
        load();
      } catch (cause) {
        if (mounted.current) setNotice(describeCloudError(cause));
      } finally {
        if (mounted.current) setBusy(false);
      }
    })();
  }, [clearSelection, load, selectedIds, services]);

  const renderTile = useCallback(
    ({ item, index }: { item: PhotoEntry; index: number }): React.JSX.Element | null => {
      if (repository === null) return null;
      const state = stateOf(item.id);
      const caption = CAPTIONS[state];
      const fromCloud = state === 'cloudOnly' || state === 'unchecked';
      return (
        <PhotoTile
          entry={item}
          repository={repository}
          size={tileSize}
          selected={selectedIds.has(item.id)}
          selecting={selecting}
          {...(fromCloud ? { fallback: fetchCloudThumbnail } : {})}
          {...(caption === null ? {} : { caption })}
          onPress={() => {
            toggle(item.id);
          }}
          onLongPress={() => {
            toggle(item.id);
          }}
          key={`${item.id}-${String(index)}`}
        />
      );
    },
    [fetchCloudThumbnail, repository, selectedIds, selecting, stateOf, tileSize, toggle],
  );

  const foreign = contents !== null && contents.kind === 'foreign';
  const unchecked = contents !== null && contents.kind === 'listed' && contents.missing === null;

  return (
    <Screen
      testID="cloud-gallery-screen"
      title={selecting ? `${String(selectedIds.size)} selected` : 'Cloud Gallery'}
      {...(selecting ? { onBack: clearSelection } : onBack === undefined ? {} : { onBack })}
    >
      {notice === null ? null : (
        <Text testID="cloud-gallery-notice" style={styles.notice}>
          {notice}
        </Text>
      )}

      {foreign ? (
        <View testID="cloud-gallery-foreign" style={styles.panel}>
          <Paragraph>
            This account&apos;s backup was made by a different vault, so its contents cannot be
            listed here - the index is sealed with that vault&apos;s key. Restore it from the Cloud
            backup screen to bring those photos onto this device; nothing here is changed or
            deleted by doing so.
          </Paragraph>
          {onOpenBackup === undefined ? null : (
            <Button
              testID="cloud-gallery-open-backup"
              label="Open Cloud backup"
              variant="secondary"
              onPress={onOpenBackup}
            />
          )}
        </View>
      ) : null}

      {!foreign && entries.length > 0 ? (
        <Text testID="cloud-gallery-summary" style={styles.summary}>
          {`${plural(entries.length, 'item')} backed up - ${describeSize(totalBytes)}`}
        </Text>
      ) : null}

      {unchecked ? (
        <Text testID="cloud-gallery-unchecked" style={styles.notice}>
          Could not check which files are still in the cloud, so this list shows what the index
          says. Nothing here has been verified against the cloud.
        </Text>
      ) : null}

      {counts.lost > 0 ? (
        <View testID="cloud-gallery-lost" style={styles.panel}>
          <Paragraph>
            {`${plural(counts.lost, 'item')} marked "Lost" cannot be recovered. The cloud no ` +
              'longer has their files and this device has no copy either, so there is nothing ' +
              'left to upload and "Back up now" cannot put them back. They stay listed until you ' +
              'select them and choose "Remove from Cloud".'}
          </Paragraph>
        </View>
      ) : null}

      {counts.repairable > 0 ? (
        <View testID="cloud-gallery-repairable" style={styles.panel}>
          <Paragraph>
            {`${plural(counts.repairable, 'item')} marked "Repair" are missing files in the ` +
              'cloud, but this device still has the photos. "Back up now" will upload them again.'}
          </Paragraph>
          {onOpenBackup === undefined ? null : (
            <Button
              testID="cloud-gallery-repair-open"
              label="Open Cloud backup"
              variant="secondary"
              onPress={onOpenBackup}
            />
          )}
        </View>
      ) : null}

      {selecting ? (
        <Button
          testID="cloud-gallery-remove"
          label="Remove from Cloud"
          variant="secondary"
          busy={busy}
          onPress={() => {
            setConfirming(true);
          }}
        />
      ) : null}

      {!foreign && entries.length === 0 && !busy ? (
        <View testID="cloud-gallery-empty" style={styles.panel}>
          <Paragraph>
            Nothing is in the cloud yet. Your photos stay on this device until you pick some in the
            vault and choose &quot;Back up to Cloud&quot;. The Local Gallery is unlimited and is
            never uploaded on its own.
          </Paragraph>
        </View>
      ) : null}

      {entries.length > 0 ? (
        <FlatList
          testID="cloud-gallery-grid"
          data={entries}
          keyExtractor={(item) => item.id}
          renderItem={renderTile}
          key={`cloud-columns-${String(columns)}`}
          numColumns={columns}
          columnWrapperStyle={columns > 1 ? styles.row : undefined}
          contentContainerStyle={styles.grid}
        />
      ) : null}

      <ConfirmDialog
        testID="cloud-gallery-remove-confirm"
        visible={confirming}
        title="Remove from the cloud?"
        message="These items are taken out of this account's backup. The copies on this device are not deleted and are not changed - only the cloud copies go."
        confirmLabel="Remove from Cloud"
        busy={busy}
        onConfirm={removeSelected}
        onCancel={() => {
          setConfirming(false);
        }}
      />
    </Screen>
  );
}

function makeStyles(colors: Palette): ReturnType<typeof StyleSheet.create> {
  return StyleSheet.create({
    notice: {
      ...typography.body,
      color: colors.textMuted,
      marginBottom: spacing.sm,
    },
    summary: {
      ...typography.label,
      color: colors.textMuted,
      marginBottom: spacing.sm,
    },
    panel: {
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      padding: spacing.md,
      gap: spacing.sm,
      marginBottom: spacing.md,
    },
    grid: {
      paddingHorizontal: EDGE,
      paddingBottom: spacing.xl,
      gap: GAP,
    },
    row: {
      gap: GAP,
    },
  });
}
