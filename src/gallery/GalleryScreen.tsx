/**
 * The vault's home: a grid of decrypted thumbnails, multi-select deletion, import and camera.
 *
 * The photo list is read straight from the vault store on every render. It is deliberately not
 * memoised or copied into local state: the repository pushes a new array after every add and
 * delete, and a cached copy here would be a stale list of ids pointing at blobs that no longer
 * exist.
 *
 * The repository is taken from `openRepository(services)` rather than the throwing
 * `useVaultRepository()` hook, because locking nulls the repository a tick before the store flips
 * to closed; during that tick a throwing hook would crash the screen instead of quietly emptying
 * it.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useServices, usePhotos, useVaultState } from '@/app/ServicesProvider';
import { radius, spacing, type Palette, typography, useStyles } from '@/app/theme';
import { wipeLocalVault } from '@/auth/vaultWipe';
import { FREE_TIER, MAX_ITEM_BYTES, type GateReason } from '@/billing/entitlements';
import { describeCloudError } from '@/backup/screens/cloudErrors';
import { VaultUpsellDialog } from '@/billing/screens/VaultUpsellDialog';
import { Button } from '@/components/Button';
import { ConfirmDialog, TypedConfirmDialog } from '@/components/Dialog';
import { ProgressBar } from '@/components/ProgressBar';
import { Paragraph, Screen } from '@/components/Screen';
import { gridColumns } from '@/gallery/gridColumns';
import { ImportService, type ImportReport } from '@/gallery/importService';
import { PhotoTile } from '@/gallery/PhotoTile';
import { openRepository } from '@/gallery/vaultAccess';
import { CameraSheet } from '@/camera/CameraSheet';
import { storedBytesOf, type PhotoEntry } from '@/vault/types';

const GAP = 4;
const EDGE = 4;
/** Clears the floating action buttons. */
const LIST_BOTTOM_INSET = 112;

export interface GalleryScreenProps {
  /** Tapped photo. The index is into the same newest-first list the viewer reads. */
  onOpenPhoto?: (photo: PhotoEntry, index: number) => void;
  onOpenSettings?: () => void;
  /** Where the Pro dialog's "See plans" goes. Without it the dialog only informs. */
  onOpenPlans?: () => void;
}

/**
 * What became of the originals, said plainly.
 *
 * Deleting a gallery original is permanent and there is no system bin to recover it from, so an
 * import that removed nothing must never read like one that did. The shortfall is real: an item
 * the picker could not give a gallery id for cannot be deleted, and the user is entitled to know
 * which of their photos are still out there before they go looking for one that is not.
 */
function describeOriginals(report: ImportReport): string {
  if (report.imported === 0) return '';
  if (report.removed === 0) return ' Originals are still in your gallery.';
  if (report.removed === report.imported) return ' Originals removed from your gallery.';
  const kept = report.imported - report.removed;
  const removedPlural = report.removed === 1 ? '' : 's';
  return ` ${String(report.removed)} original${removedPlural} removed, ${String(kept)} still in your gallery.`;
}

export function GalleryScreen({
  onOpenPhoto,
  onOpenSettings,
  onOpenPlans,
}: GalleryScreenProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const services = useServices();
  const photos = usePhotos();
  const vaultState = useVaultState();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();

  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set());
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmingErase, setConfirmingErase] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * What the operation in flight has finished. Null while something is running that cannot be
   * counted yet -- the picker is open, or the selection has not come back from it -- which is a
   * real phase and shows as an indeterminate bar rather than an invented percentage.
   */
  const [progress, setProgress] = useState<{
    readonly verb: string;
    readonly done: number;
    readonly total: number;
  } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The camera is a sheet over this screen, not a separate route: a capture is reviewed and kept
  // or discarded without ever leaving the gallery.
  const [cameraOpen, setCameraOpen] = useState(false);
  /** Which free-tier gate stopped the last import, while its dialog is up. */
  const [upsell, setUpsell] = useState<GateReason | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const importService = useMemo(() => new ImportService(services), [services]);
  const repository = openRepository(services);
  const selecting = selectedIds.size > 0;
  // `Screen` pads by the horizontal safe area, so the grid gets less than the window in landscape.
  // Sizing from the window there would push the last column under the navigation bar.
  const contentWidth = width - insets.left - insets.right;
  const columns = gridColumns(contentWidth);
  const tileSize = Math.floor((contentWidth - EDGE * 2 - GAP * (columns - 1)) / columns);

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
  }, []);

  const toggle = useCallback((id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedIds(new Set(photos.map((photo) => photo.id)));
  }, [photos]);

  const lock = useCallback(() => {
    services.session.lock();
  }, [services]);

  const runImport = useCallback(() => {
    if (busy) return;
    const target = openRepository(services);
    if (target === null) {
      setNotice('The vault is locked.');
      return;
    }
    // The free tier gates ADDING only, and only in a build that can sell. A full vault gets the
    // dialog instead of the picker; one with room gets a picker capped at exactly that room, so
    // a selection is never half-imported.
    // Zero bytes: nothing has been picked yet, so the size is unknown here. Each picked asset's
    // size is checked inside the import, from the picker's metadata, before it is read.
    const gate = services.entitlements.gate(
      target.photos.length,
      0,
      storedBytesOf(target.photos),
    );
    if (!gate.allowed) {
      setUpsell(gate.reason);
      return;
    }
    const room =
      services.entitlements.enforced && !services.entitlements.isCloudActive()
        ? FREE_TIER.maxItems - target.photos.length
        : undefined;
    setNotice(null);
    setBusy(true);
    void (async () => {
      try {
        const report = await importService.importFromLibrary(target, {
          ...(room === undefined ? {} : { selectionLimit: room }),
          onProgress: (done, total) => {
            if (mounted.current) setProgress({ verb: 'Importing', done, total });
          },
        });
        if (!mounted.current) return;
        if (report.imported + report.failed + report.oversized + report.overLimit > 0) {
          const plural = report.imported === 1 ? '' : 's';
          // Oversized is reported beside failed rather than folded into it: "could not be read"
          // is a broken file, "too large" is a fine file the vault will not take, and a user who
          // is told the wrong one will go looking for the wrong problem.
          const parts: string[] = [];
          if (report.failed > 0) parts.push(`${String(report.failed)} could not be read`);
          if (report.oversized > 0) {
            const mb = String(MAX_ITEM_BYTES / (1024 * 1024));
            parts.push(`${String(report.oversized)} over ${mb} MB`);
          }
          if (report.overLimit > 0) {
            parts.push(`${String(report.overLimit)} over the free limit`);
          }
          const tail = parts.length > 0 ? `, ${parts.join(' and ')}` : '';
          setNotice(
            `Imported ${String(report.imported)} photo${plural}${tail}.${describeOriginals(report)}`,
          );
        }
      } catch {
        // The reason is deliberately not surfaced or logged: it can carry a file path.
        if (mounted.current) setNotice('Import failed.');
      } finally {
        if (mounted.current) {
          setBusy(false);
          setProgress(null);
        }
      }
    })();
  }, [busy, importService, services]);

  const confirmDelete = useCallback(() => {
    const ids = [...selectedIds];
    const target = openRepository(services);
    setConfirmingDelete(false);
    clearSelection();
    if (target === null || ids.length === 0) return;
    // Busy was never set here, so deleting a long selection looked like nothing had happened:
    // secure erasure overwrites every file before unlinking it, and a page of videos takes real
    // seconds. It also stops a second tap starting a second delete across the first.
    setBusy(true);
    void (async () => {
      try {
        await target.deletePhotos(ids, (done, total) => {
          if (mounted.current) setProgress({ verb: 'Deleting', done, total });
        });
      } catch {
        if (mounted.current) setNotice('Some photos could not be deleted.');
      } finally {
        if (mounted.current) {
          setBusy(false);
          setProgress(null);
        }
      }
    })();
  }, [clearSelection, selectedIds, services]);

  /**
   * Puts the chosen photos in the cloud, and nothing else.
   *
   * This is the ONLY way anything reaches the backup. The Local Gallery is unlimited and
   * private: importing a photo, taking one, or opening one never uploads it. A photo is in the
   * cloud because the user named it here, which is why the ids go with the call rather than the
   * service reading the vault for itself.
   *
   * Signed out there is no account to put anything in, and saying so beats a generic failure.
   */
  const backupSelected = useCallback(() => {
    const ids = [...selectedIds];
    const target = openRepository(services);
    const backup = services.backup;
    const cloud = services.firebase.cloud;
    clearSelection();
    if (target === null || ids.length === 0) return;
    if (backup === null || cloud === null) {
      setNotice('Cloud backup is not available in this build.');
      return;
    }
    if (cloud.currentUser === null) {
      setNotice('Sign in under Settings to back photos up. They stay on this device until you do.');
      return;
    }
    setBusy(true);
    void (async () => {
      try {
        const report = await backup.backupNow(target, services.session.requireKeys(), { ids });
        if (!mounted.current) return;
        const plural = report.uploaded === 1 ? '' : 's';
        setNotice(
          report.uploaded === 0
            ? 'Those photos were already in the cloud.'
            : `Backed up ${String(report.uploaded)} photo${plural}.`,
        );
      } catch (cause) {
        if (mounted.current) setNotice(describeCloudError(cause));
      } finally {
        if (mounted.current) setBusy(false);
      }
    })();
  }, [clearSelection, selectedIds, services]);

  /**
   * The unreadable-vault escape hatch -- and deliberately the same erase the forgot-PIN dialog
   * performs, through the same function.
   *
   * Wiping through the repository was wrong twice over. There is no repository to wipe through in
   * this state, because the controller never finished opening one; and two erase paths that
   * destroyed different things was a hole in itself, since this one used to leave the decrypted
   * temporaries, the settings and the cloud session behind.
   *
   * The wipe is local and stops at the device boundary: the Firebase account, the encrypted blobs
   * and the backup envelope are untouched, and this device is only signed out of them.
   */
  const eraseVault = useCallback(() => {
    setConfirmingErase(false);
    setBusy(true);
    void (async () => {
      // Never rejects, and it locks the session itself -- which unmounts this screen in the app.
      await wipeLocalVault(services);
      if (mounted.current) setBusy(false);
    })();
  }, [services]);

  const renderTile = useCallback(
    ({ item, index }: { item: PhotoEntry; index: number }): React.JSX.Element | null => {
      if (repository === null) return null;
      return (
        <PhotoTile
          entry={item}
          repository={repository}
          size={tileSize}
          selected={selectedIds.has(item.id)}
          selecting={selecting}
          onPress={() => {
            if (selecting) toggle(item.id);
            else onOpenPhoto?.(item, index);
          }}
          onLongPress={() => {
            toggle(item.id);
          }}
        />
      );
    },
    [onOpenPhoto, repository, selectedIds, selecting, tileSize, toggle],
  );

  const headerActions = selecting ? (
    <>
      <HeaderAction
        testID="gallery-select-all"
        label="Select all"
        glyph="All"
        onPress={selectAll}
      />
      <HeaderAction
        testID="gallery-backup-cloud"
        label="Back up to Cloud"
        glyph="Cloud"
        onPress={backupSelected}
      />
      <HeaderAction
        testID="gallery-delete"
        label="Delete"
        glyph="Delete"
        destructive
        onPress={() => {
          setConfirmingDelete(true);
        }}
      />
    </>
  ) : (
    <>
      <HeaderAction
        testID="vault-settings"
        label="Settings"
        glyph="Settings"
        onPress={() => onOpenSettings?.()}
      />
      <HeaderAction testID="vault-lock" label="Lock vault" glyph="Lock" onPress={lock} />
    </>
  );

  return (
    <Screen
      testID="gallery-screen"
      title={selecting ? `${String(selectedIds.size)} selected` : 'Vault'}
      {...(selecting ? { onBack: clearSelection } : {})}
      actions={headerActions}
    >
      {notice === null ? null : (
        <Text testID="gallery-notice" style={styles.notice}>
          {notice}
        </Text>
      )}

      {busy ? (
        <ProgressBar
          testID="gallery-progress"
          {...(progress === null
            ? {}
            : { value: progress.total === 0 ? 1 : progress.done / progress.total })}
          {...(progress === null || progress.total === 0
            ? {}
            : {
                label: `${progress.verb} ${String(progress.done)} of ${String(progress.total)}`,
              })}
        />
      ) : null}

      {vaultState.unreadable ? (
        <UnreadableVault
          busy={busy}
          onErase={() => {
            setConfirmingErase(true);
          }}
        />
      ) : repository === null ? (
        <View testID="gallery-locked" style={styles.centered} />
      ) : photos.length === 0 ? (
        <EmptyVault busy={busy} onImport={runImport} />
      ) : (
        <FlatList
          testID="gallery-grid"
          data={photos}
          extraData={selectedIds}
          keyExtractor={(item) => item.id}
          // FlatList refuses to change `numColumns` in place, so the key remounts it on the rare
          // occasions the count actually moves: a rotation or an unfold, not a scroll.
          key={columns}
          numColumns={columns}
          renderItem={renderTile}
          columnWrapperStyle={styles.column}
          contentContainerStyle={styles.grid}
          initialNumToRender={18}
          windowSize={5}
          removeClippedSubviews
        />
      )}

      {selecting || repository === null || vaultState.unreadable ? null : (
        <View style={styles.fabs} pointerEvents="box-none">
          <Pressable
            testID="gallery-import"
            accessibilityRole="button"
            accessibilityLabel="Import photos"
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            onPress={runImport}
            style={[styles.fab, styles.fabSecondary, busy ? styles.fabDisabled : null]}
          >
            <Text style={styles.fabLabel}>Import</Text>
          </Pressable>
          <Pressable
            testID="gallery-camera"
            accessibilityRole="button"
            accessibilityLabel="Take a photo or video"
            onPress={() => {
              setCameraOpen(true);
            }}
            style={[styles.fab, styles.fabPrimary]}
          >
            <Text style={styles.fabLabel}>Camera</Text>
          </Pressable>
        </View>
      )}

      <CameraSheet
        visible={cameraOpen}
        onClose={() => {
          setCameraOpen(false);
        }}
      />

      <VaultUpsellDialog
        visible={upsell !== null}
        reason={upsell}
        {...(onOpenPlans === undefined ? {} : { onPlans: onOpenPlans })}
        onClose={() => {
          setUpsell(null);
        }}
      />

      <ConfirmDialog
        testID="gallery-delete-confirm"
        visible={confirmingDelete}
        title={
          selectedIds.size === 1 ? 'Delete item?' : `Delete ${String(selectedIds.size)} items?`
        }
        message="Deleted photos and videos are securely erased and cannot be recovered."
        confirmLabel="Delete"
        destructive
        onConfirm={confirmDelete}
        onCancel={() => {
          setConfirmingDelete(false);
        }}
      />

      <TypedConfirmDialog
        testID="gallery-erase-confirm"
        visible={confirmingErase}
        phrase="ERASE"
        title="Erase vault?"
        message="Everything in the vault, the vault PIN and every decrypted temporary file will be securely deleted from this device. This cannot be undone. Your cloud backup, if you have one, is not deleted - this device is simply signed out of it."
        confirmLabel="Erase vault"
        destructive
        busy={busy}
        onConfirm={eraseVault}
        onCancel={() => {
          setConfirmingErase(false);
        }}
      />
    </Screen>
  );
}

function HeaderAction({
  testID,
  label,
  glyph,
  destructive = false,
  onPress,
}: {
  testID: string;
  label: string;
  glyph: string;
  destructive?: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={10}
      style={({ pressed }) => [styles.headerAction, pressed ? styles.pressed : null]}
    >
      <Text style={[styles.headerActionLabel, destructive ? styles.destructive : null]}>
        {glyph}
      </Text>
    </Pressable>
  );
}

function EmptyVault({
  busy,
  onImport,
}: {
  busy: boolean;
  onImport: () => void;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  return (
    <View testID="gallery-empty" style={styles.centered}>
      <Text style={styles.emptyTitle}>Your vault is empty</Text>
      <Paragraph>
        Photos and videos you capture or import are encrypted on this device and never appear in
        your regular gallery.
      </Paragraph>
      <Button
        testID="gallery-empty-import"
        label="Import photos"
        variant="secondary"
        busy={busy}
        onPress={onImport}
        style={styles.centeredButton}
      />
    </View>
  );
}

function UnreadableVault({
  busy,
  onErase,
}: {
  busy: boolean;
  onErase: () => void;
}): React.JSX.Element {
  const styles = useStyles(makeStyles);
  return (
    <View testID="gallery-unreadable" style={styles.centered}>
      <Text style={styles.errorTitle}>Vault data cannot be read</Text>
      <Paragraph>
        The encrypted files on this device do not match your PIN. They may belong to a previous
        installation. Erasing the vault lets you start over.
      </Paragraph>
      <Button
        testID="gallery-erase-vault"
        label="Erase vault"
        variant="danger"
        busy={busy}
        onPress={onErase}
        style={styles.centeredButton}
      />
    </View>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    grid: { padding: EDGE, paddingBottom: LIST_BOTTOM_INSET, gap: GAP },
    column: { gap: GAP },
    centered: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: spacing.lg,
      gap: spacing.sm,
    },
    centeredButton: { marginTop: spacing.md, alignSelf: 'stretch' },
    emptyTitle: { ...typography.title, color: colors.text, textAlign: 'center' },
    errorTitle: { ...typography.title, color: colors.danger, textAlign: 'center' },
    notice: {
      ...typography.label,
      color: colors.text,
      backgroundColor: colors.surface,
      marginHorizontal: spacing.md,
      marginBottom: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.sm,
    },
    headerAction: {
      paddingHorizontal: spacing.sm,
      paddingVertical: spacing.xs,
      minHeight: 40,
      justifyContent: 'center',
    },
    headerActionLabel: { ...typography.label, color: colors.text },
    destructive: { color: colors.danger },
    pressed: { opacity: 0.6 },
    fabs: {
      position: 'absolute',
      right: spacing.md,
      bottom: spacing.lg,
      alignItems: 'flex-end',
      gap: spacing.sm,
    },
    fab: {
      minHeight: 48,
      paddingHorizontal: spacing.lg,
      borderRadius: radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
    },
    fabPrimary: { backgroundColor: colors.accent },
    fabSecondary: { backgroundColor: colors.surfaceAlt },
    fabDisabled: { opacity: 0.45 },
    fabLabel: { ...typography.label, color: colors.accentText, fontSize: 16 },
  });
