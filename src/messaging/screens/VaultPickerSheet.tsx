/**
 * Pick one vault item to send, and explain what that means the first time.
 *
 * Deliberately NOT `GalleryScreen`. That screen carries multi-select and Delete, and a picker
 * must not put a destructive action one mis-tap away from a routine one. This renders the same
 * tiles over the same repository and does nothing else.
 *
 * The notice is the whole reason this route is separate from the other two. Sending a vault item
 * uploads a copy and ends the "never leaves this device" property for that copy -- the original
 * is untouched, but it must not happen silently.
 *
 * Three steps, and each one fills the screen rather than floating a card at the top:
 *
 *   grid     every item, sized from the window so the tiles reach both edges
 *   confirm  the chosen item, large enough to check it is actually the right one
 *   notice   the same preview with the explanation, shown once per conversation
 *
 * The actions are docked at the bottom in every step. The top of a tall phone is not somewhere a
 * thumb reaches, and the first version of this screen put its only button up there with the rest
 * of the screen empty underneath.
 */
import React, { useState } from 'react';
import {
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useServices } from '@/app/ServicesProvider';
import { radius, spacing, typography, useStyles, type Palette } from '@/app/theme';
import { Button } from '@/components/Button';
import { openRepository } from '@/gallery/vaultAccess';
import { PhotoTile } from '@/gallery/PhotoTile';
import { isVideo } from '@/vault/mediaKind';
import type { PhotoEntry, VaultRepository } from '@/vault/types';

export interface VaultPickerSheetProps {
  visible: boolean;
  /** True when this conversation has already been shown the explanation. */
  noticeSeen: boolean;
  onCancel: () => void;
  onSend: (entry: PhotoEntry) => void;
}

const COLUMNS = 3;
const GUTTER = spacing.xs;
/** Big enough to recognise the picture, small enough to leave room for the actions. */
const MAX_PREVIEW = 320;

export function VaultPickerSheet({
  visible,
  noticeSeen,
  onCancel,
  onSend,
}: VaultPickerSheetProps): React.JSX.Element {
  const services = useServices();
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const repository = openRepository(services);
  const [chosen, setChosen] = useState<PhotoEntry | null>(null);

  // Tiles are sized from the window rather than fixed, so three columns reach both edges on a
  // small phone and on a tablet without a second layout.
  const tile = Math.floor((width - spacing.md * 2 - GUTTER * (COLUMNS - 1)) / COLUMNS);
  const items: readonly PhotoEntry[] = repository?.photos ?? [];
  const noun = chosen !== null && isVideo(chosen) ? 'video' : 'photo';

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
      <View style={[styles.screen, { paddingTop: insets.top }]} testID="vault_picker">
        <View style={styles.header}>
          {chosen === null ? (
            <View style={styles.headerSide} />
          ) : (
            <Pressable
              testID="vault_picker_back"
              accessibilityRole="button"
              accessibilityLabel="Choose another"
              onPress={() => {
                setChosen(null);
              }}
              hitSlop={8}
              style={styles.headerSide}
            >
              <Text style={styles.action}>‹ Back</Text>
            </Pressable>
          )}
          <Text style={styles.title} numberOfLines={1}>
            {chosen === null ? 'Send from the vault' : `Send this ${noun}?`}
          </Text>
          <Pressable
            testID="vault_picker_cancel"
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            onPress={onCancel}
            hitSlop={8}
            style={[styles.headerSide, styles.headerRight]}
          >
            <Text style={styles.action}>Cancel</Text>
          </Pressable>
        </View>

        {chosen === null ? (
          repository === null || items.length === 0 ? (
            <View style={styles.centred} testID="vault_picker_empty">
              <Text style={styles.emptyGlyph}>▤</Text>
              <Text style={styles.emptyTitle}>Nothing in the vault yet</Text>
              <Text style={styles.emptyBody}>
                Photos and videos you add to the vault can be sent from here.
              </Text>
            </View>
          ) : (
            <FlatList
              testID="vault_picker_grid"
              data={items}
              numColumns={COLUMNS}
              keyExtractor={(entry) => entry.id}
              contentContainerStyle={[styles.grid, { paddingBottom: insets.bottom + spacing.md }]}
              columnWrapperStyle={styles.gridRow}
              renderItem={({ item }) => (
                <View testID={`vault_picker_item_${item.id}`}>
                  <PhotoTile
                    entry={item}
                    size={tile}
                    repository={repository}
                    selected={false}
                    selecting={false}
                    onPress={() => {
                      setChosen(item);
                    }}
                    onLongPress={() => {
                      // Nothing: a picker has no destructive action to reach for.
                    }}
                  />
                </View>
              )}
            />
          )
        ) : (
          <Chosen
            entry={chosen}
            repository={repository}
            styles={styles}
            noun={noun}
            preview={Math.min(width - spacing.md * 2, MAX_PREVIEW)}
            showNotice={!noticeSeen}
            bottomInset={insets.bottom}
            onSend={() => {
              onSend(chosen);
            }}
            onCancel={onCancel}
            onBack={() => {
              setChosen(null);
            }}
          />
        )}
      </View>
    </Modal>
  );
}

function Chosen({
  entry,
  repository,
  styles,
  noun,
  preview,
  showNotice,
  bottomInset,
  onSend,
  onCancel,
  onBack,
}: {
  entry: PhotoEntry;
  repository: VaultRepository | null;
  styles: ReturnType<typeof makeStyles>;
  noun: string;
  preview: number;
  showNotice: boolean;
  bottomInset: number;
  onSend: () => void;
  onCancel: () => void;
  onBack: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.flex}>
      <ScrollView contentContainerStyle={styles.chosenBody} showsVerticalScrollIndicator={false}>
        {repository === null ? null : (
          <View style={styles.previewFrame} testID="vault_picker_preview">
            <PhotoTile
              entry={entry}
              size={preview}
              repository={repository}
              selected={false}
              selecting={false}
              onPress={onBack}
              onLongPress={() => undefined}
            />
          </View>
        )}

        {showNotice ? (
          <View style={styles.notice} testID="vault_send_notice">
            <Text style={styles.noticeTitle}>This sends a copy</Text>
            <Text style={styles.noticeBody}>
              {`The copy leaves the vault and goes to the other person, who keeps it. The copy on the server is deleted after 30 days. Your own ${noun} stays in the vault, unchanged.`}
            </Text>
          </View>
        ) : null}
      </ScrollView>

      {/* Docked, because the top of a tall phone is not where a thumb goes. */}
      <View style={[styles.actions, { paddingBottom: bottomInset + spacing.md }]}>
        {showNotice ? (
          <>
            <Button testID="vault_send_notice_send" label="Send a copy" onPress={onSend} />
            <Button
              testID="vault_send_notice_cancel"
              label="Not now"
              variant="ghost"
              onPress={onCancel}
            />
          </>
        ) : (
          <>
            <Button testID="vault_send_confirm" label={`Send this ${noun}`} onPress={onSend} />
            <Button
              testID="vault_picker_choose_another"
              label="Choose another"
              variant="ghost"
              onPress={onBack}
            />
          </>
        )}
      </View>
    </View>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    flex: { flex: 1 },
    screen: { flex: 1, backgroundColor: colors.background },

    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
    },
    /** Equal sides keep the title optically centred whichever affordance is showing. */
    headerSide: { minWidth: 64 },
    headerRight: { alignItems: 'flex-end' },
    title: { ...typography.label, color: colors.text, flex: 1, textAlign: 'center' },
    action: { ...typography.body, color: colors.accent },

    grid: { padding: spacing.md, gap: GUTTER },
    gridRow: { gap: GUTTER },

    centred: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.lg,
      gap: spacing.sm,
    },
    emptyGlyph: { fontSize: 40, color: colors.textMuted, opacity: 0.6 },
    emptyTitle: { ...typography.title, color: colors.text, textAlign: 'center' },
    emptyBody: { ...typography.body, color: colors.textMuted, textAlign: 'center' },

    chosenBody: {
      flexGrow: 1,
      alignItems: 'center',
      justifyContent: 'center',
      padding: spacing.md,
      gap: spacing.md,
    },
    previewFrame: { borderRadius: radius.md, overflow: 'hidden' },
    notice: {
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      padding: spacing.md,
      gap: spacing.xs,
    },
    noticeTitle: { ...typography.label, color: colors.text },
    noticeBody: { ...typography.body, color: colors.textMuted },

    actions: {
      paddingHorizontal: spacing.md,
      paddingTop: spacing.sm,
      gap: spacing.sm,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
      backgroundColor: colors.background,
    },
  });
