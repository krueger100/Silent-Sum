/**
 * The app's face: a working calculator, and the only way into the vault.
 *
 * Typing the PIN and pressing `=` unlocks. A wrong PIN produces exactly what a calculator would,
 * so watching the screen tells an observer nothing. Three things are deliberately visible rather
 * than hidden:
 *
 * - On first run a sheet explains that the vault exists and how to open it. Discovery must not
 *   depend on an undocumented gesture, or a user who forgets the gesture has lost their photos.
 * - A result that is a contiguous part of the PIN is answered with how many digits are still
 *   missing, so a user who is close is not left guessing whether the app is working.
 * - A lockout after repeated wrong PINs is reported, because otherwise the app would look broken
 *   to the one person entitled to get in.
 *
 * The menu is one of those visible things, in every mode. "Super secure" changes what is INSIDE
 * it, not whether it exists: an app whose only exit is an undocumented gesture strands the one
 * person entitled to get in, and a menu holding nothing but About says no more about this app
 * than a calculator's About page would.
 */
import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { useServices, useSettings } from '@/app/ServicesProvider';
import { formatDuration, radius, spacing, type Palette, typography, useStyles } from '@/app/theme';
import { ForgotPinDialog } from '@/auth/screens/ForgotPinDialog';
import { WIPE_SCOPE_DETAIL } from '@/auth/wipePin';
import { ConfirmDialog } from '@/components/Dialog';
import { WelcomeSheet } from '@/auth/screens/WelcomeSheet';
import { CalculatorDisplay } from '@/calculator/CalculatorDisplay';
import { CalculatorKeypad } from '@/calculator/CalculatorKeypad';
import { describePartialMatch } from '@/calculator/pinMatching';
import type { CalcKey } from '@/calculator/types';
import { useCalculatorController } from '@/calculator/useCalculatorController';
import { Screen } from '@/components/Screen';

export interface CalculatorScreenProps {
  /** The vault was unlocked; the navigator moves to the gallery. */
  onOpenVault: () => void;
  onSetupVault: () => void;
  onOpenAbout: () => void;
  /**
   * Opens the restore flow. Reached only from the end of an erase, when the device had a cloud
   * backup: it is not a second door into the vault, it is the far side of having destroyed one.
   */
  onRestoreBackup?: () => void;
}

export function CalculatorScreen({
  onOpenVault,
  onSetupVault,
  onOpenAbout,
  onRestoreBackup,
}: CalculatorScreenProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const { settings: settingsController } = useServices();
  const settings = useSettings();
  const { width, height } = useWindowDimensions();
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [forgotOpen, setForgotOpen] = useState(false);

  const controller = useCalculatorController({
    onOpened: useCallback(() => {
      setNotice(null);
      onOpenVault();
    }, [onOpenVault]),
    onPartial: useCallback((digits: string, missingDigits: number) => {
      setNotice(describePartialMatch(digits, missingDigits));
    }, []),
    onBlocked: useCallback((remainingMs: number) => {
      setNotice(`Too many incorrect attempts. Try again in ${formatDuration(remainingMs)}.`);
    }, []),
    onUnavailable: useCallback(() => {
      setNotice('The vault data on this device cannot be read.');
    }, []),
  });

  const { press: pressKey, refreshStatus } = controller;

  // A notice answers one calculation. The next keypress begins another, so it goes: leaving "1214
  // is correct" above a display that now reads 49 would be both wrong and worth reading over a
  // shoulder. Anything the new calculation deserves is set again when it is evaluated.
  const handleKey = useCallback(
    (key: CalcKey) => {
      setNotice(null);
      pressKey(key);
    },
    [pressKey],
  );

  const startSetup = useCallback(() => {
    setMenuOpen(false);
    void settingsController.update({ onboardingDone: true });
    onSetupVault();
  }, [onSetupVault, settingsController]);

  const dismissWelcome = useCallback(() => {
    void settingsController.update({ onboardingDone: true });
  }, [settingsController]);

  const { configured, unreadable } = controller.status;

  /**
   * Whether the menu must name nothing but About.
   *
   * Inert in two states, both for the same reason -- there is no PIN to protect and the menu is
   * the only way forward:
   *  - no vault is configured, so the only item is the invitation to create one;
   *  - the credential record cannot be decoded, so NO PIN can open anything and erasing is the
   *    only remaining exit. Offering it there is not a bypass of a working PIN.
   */
  const hideVaultItems = settings.superSecure && configured && !unreadable;

  // First run: explain the vault once, instead of hiding it behind a secret gesture.
  const showWelcome = !settings.onboardingDone && !configured;
  const landscape = width > height;

  return (
    <Screen testID="calculator-screen">
      <View style={styles.topBar}>
        <Pressable
          testID="calc_menu"
          accessibilityRole="button"
          accessibilityLabel="Menu"
          hitSlop={12}
          onPress={() => {
            setMenuOpen((open) => !open);
          }}
          style={styles.menuButton}
        >
          <Text style={styles.menuGlyph}>⋮</Text>
        </Pressable>
      </View>

      {menuOpen ? (
        <View style={styles.menu} testID="calc_menu_sheet">
          {!configured ? (
            <Pressable
              testID="menu_setup_vault"
              accessibilityRole="button"
              onPress={startSetup}
              style={styles.menuItem}
            >
              <Text style={styles.menuItemText}>Set up private vault</Text>
            </Pressable>
          ) : hideVaultItems ? null : (
            <Pressable
              testID="menu_forgot_pin"
              accessibilityRole="button"
              onPress={() => {
                setMenuOpen(false);
                setForgotOpen(true);
              }}
              style={styles.menuItem}
            >
              <Text style={styles.menuItemText}>Forgot PIN?</Text>
            </Pressable>
          )}
          <Pressable
            testID="menu_about"
            accessibilityRole="button"
            onPress={() => {
              setMenuOpen(false);
              onOpenAbout();
            }}
            style={styles.menuItem}
          >
            <Text style={styles.menuItemText}>About</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={landscape ? styles.bodyLandscape : styles.body}>
        <View style={landscape ? styles.displayLandscape : undefined}>
          <CalculatorDisplay state={controller.state} />
          {notice === null ? null : (
            <View style={styles.notice} testID="calc_notice">
              <Text style={styles.noticeText} accessibilityRole="alert">
                {notice}
              </Text>
              {/* The same rule as the menu: while super secure is on, nothing on this screen
                  offers a route to the vault, including this shortcut. */}
              {hideVaultItems ? null : (
                <Pressable
                  testID="calc_notice_forgot"
                  accessibilityRole="button"
                  onPress={() => {
                    setForgotOpen(true);
                  }}
                >
                  <Text style={styles.noticeAction}>Forgot PIN?</Text>
                </Pressable>
              )}
            </View>
          )}
        </View>
        <View style={styles.keypad}>
          <CalculatorKeypad onPress={handleKey} />
        </View>
      </View>

      {showWelcome ? <WelcomeSheet onSetup={startSetup} onLater={dismissWelcome} /> : null}

      {/* The wipe PIN asks before it destroys anything. The wording names what goes, because a
          prompt that said only "are you sure?" would be no safer than no prompt at all. */}
      <ConfirmDialog
        testID="wipe_confirm_dialog"
        visible={controller.pendingWipe !== null}
        title="Erase everything?"
        message={
          controller.pendingWipe === null
            ? ''
            : `${WIPE_SCOPE_DETAIL[controller.pendingWipe]}\n\nThis cannot be undone.`
        }
        confirmLabel="Erase now"
        cancelLabel="Cancel"
        destructive
        onConfirm={controller.confirmWipe}
        onCancel={controller.cancelWipe}
      />

      <ForgotPinDialog
        visible={forgotOpen}
        onDismiss={() => {
          setForgotOpen(false);
        }}
        onErased={() => {
          setForgotOpen(false);
          setNotice(null);
          void refreshStatus();
        }}
        {...(onRestoreBackup === undefined ? {} : { onRestore: onRestoreBackup })}
      />
    </Screen>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    topBar: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: spacing.sm },
    menuButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
    menuGlyph: { color: colors.textMuted, fontSize: 24 },
    menu: {
      position: 'absolute',
      top: 48,
      right: spacing.md,
      zIndex: 10,
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      paddingVertical: spacing.xs,
      minWidth: 200,
    },
    menuItem: { paddingHorizontal: spacing.md, paddingVertical: spacing.md - 4 },
    menuItemText: { ...typography.body, color: colors.text },
    body: { flex: 1 },
    bodyLandscape: { flex: 1, flexDirection: 'row' },
    displayLandscape: { flex: 1, justifyContent: 'center' },
    keypad: { flex: 1 },
    notice: {
      marginHorizontal: spacing.md,
      padding: spacing.md,
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      gap: spacing.xs,
    },
    noticeText: { ...typography.body, color: colors.text },
    noticeAction: { ...typography.label, color: colors.accent },
  });
