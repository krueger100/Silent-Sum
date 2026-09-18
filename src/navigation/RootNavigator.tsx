/**
 * Session-gated navigation.
 *
 * The vault stack is only *mounted* while the session is unlocked. That is stronger than hiding
 * screens behind a guard: when the vault locks, those screens are unmounted and their component
 * state, including any decoded image, goes with them. There is also no route, no deep link and no
 * back-stack entry that leads into the vault, because those routes do not exist while locked.
 */
import React, { useMemo, useState } from 'react';
import { NavigationContainer, type Theme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { useIsUnlocked, useSettings } from '@/app/ServicesProvider';
import { useTheme, type Palette } from '@/app/theme';
import { PinSetupScreen } from '@/auth/screens/PinSetupScreen';
import { RestoreFlowScreen } from '@/backup/screens/RestoreFlowScreen';
import { CloudBackupScreen } from '@/backup/screens/CloudBackupScreen';
import { CalculatorScreen } from '@/calculator/CalculatorScreen';
import { GalleryScreen } from '@/gallery/GalleryScreen';
import { PhotoViewerScreen } from '@/gallery/PhotoViewerScreen';
import { AboutScreen } from '@/settings/screens/AboutScreen';
import { AutoLockScreen } from '@/settings/screens/AutoLockScreen';
import { SecurityScreen } from '@/settings/screens/SecurityScreen';
import { SettingsScreen } from '@/settings/screens/SettingsScreen';
import { SupportScreen } from '@/settings/screens/SupportScreen';
import { WipePinScreen } from '@/settings/screens/WipePinScreen';

export type LockedStackParams = {
  Calculator: undefined;
  PinSetup: undefined;
  Restore: undefined;
  About: undefined;
};

export type VaultStackParams = {
  Gallery: undefined;
  PhotoViewer: { photoId: string; index: number };
  Settings: undefined;
  ChangePin: undefined;
  AutoLock: undefined;
  Security: undefined;
  WipePin: undefined;
  CloudBackup: undefined;
  Support: undefined;
  VaultAbout: undefined;
};

const LockedStack = createNativeStackNavigator<LockedStackParams>();
const VaultStack = createNativeStackNavigator<VaultStackParams>();

const FONTS: Theme['fonts'] = {
  regular: { fontFamily: 'System', fontWeight: '400' },
  medium: { fontFamily: 'System', fontWeight: '500' },
  bold: { fontFamily: 'System', fontWeight: '600' },
  heavy: { fontFamily: 'System', fontWeight: '700' },
};

/** Only the container background is ever visible; every screen draws its own chrome. */
function navigationThemeFor(colors: Palette): Theme {
  return {
    dark: colors.dark,
    colors: {
      primary: colors.accent,
      background: colors.background,
      card: colors.surface,
      text: colors.text,
      border: colors.border,
      notification: colors.accent,
    },
    fonts: FONTS,
  };
}

// Every screen draws its own header through the shared `Screen` component.
const screenOptions = { headerShown: false, animation: 'slide_from_right' } as const;

function LockedFlow(): React.JSX.Element {
  // Super secure reaches About too: with it on, the only page the calculator's menu opens must
  // read like a calculator's About page and say nothing about a vault.
  const { superSecure } = useSettings();

  return (
    <LockedStack.Navigator screenOptions={screenOptions}>
      <LockedStack.Screen name="Calculator">
        {({ navigation }) => (
          <CalculatorScreen
            // Unlocking swaps the whole navigator, so there is nothing to push here.
            onOpenVault={() => undefined}
            onSetupVault={() => {
              navigation.navigate('PinSetup');
            }}
            onOpenAbout={() => {
              navigation.navigate('About');
            }}
            // The erase flow ends here when a cloud backup existed: wipe, sign out, then straight
            // into the sign-in that leads to the recovery passphrase.
            onRestoreBackup={() => {
              navigation.navigate('Restore');
            }}
          />
        )}
      </LockedStack.Screen>

      <LockedStack.Screen name="PinSetup">
        {({ navigation }) => (
          <PinSetupScreen
            mode="create"
            onDone={() => {
              // Setup unlocks the session, which swaps to the vault flow on its own. Popping
              // keeps the locked stack clean if the session is ever locked again later.
              if (navigation.canGoBack()) navigation.popToTop();
            }}
            onCancel={() => {
              navigation.goBack();
            }}
            onRestoreInstead={() => {
              navigation.navigate('Restore');
            }}
          />
        )}
      </LockedStack.Screen>

      <LockedStack.Screen name="Restore">
        {({ navigation }) => (
          <RestoreFlowScreen
            onDone={() => {
              if (navigation.canGoBack()) navigation.popToTop();
            }}
            onBack={() => {
              navigation.goBack();
            }}
          />
        )}
      </LockedStack.Screen>

      <LockedStack.Screen name="About">
        {({ navigation }) => (
          <AboutScreen
            appName="Calculator"
            disguised={superSecure}
            onBack={() => {
              navigation.goBack();
            }}
          />
        )}
      </LockedStack.Screen>
    </LockedStack.Navigator>
  );
}

function VaultFlow(): React.JSX.Element {
  // Settings stays mounted while the wipe-PIN screen is pushed over it, so it is told when that
  // screen closes. Without this its wipe-PIN row would keep showing the scope that was armed when
  // Settings was first opened, which is the exact confusion that row exists to prevent.
  const [wipePinToken, setWipePinToken] = useState(0);

  return (
    <VaultStack.Navigator screenOptions={screenOptions}>
      <VaultStack.Screen name="Gallery">
        {({ navigation }) => (
          <GalleryScreen
            onOpenPhoto={(photo, index) => {
              navigation.navigate('PhotoViewer', { photoId: photo.id, index });
            }}
            onOpenSettings={() => {
              navigation.navigate('Settings');
            }}
          />
        )}
      </VaultStack.Screen>

      <VaultStack.Screen name="PhotoViewer">
        {({ navigation, route }) => (
          <PhotoViewerScreen
            initialPhotoId={route.params.photoId}
            initialIndex={route.params.index}
            onClose={() => {
              navigation.goBack();
            }}
          />
        )}
      </VaultStack.Screen>

      <VaultStack.Screen name="Settings">
        {({ navigation }) => (
          <SettingsScreen
            onChangePin={() => {
              navigation.navigate('ChangePin');
            }}
            onAutoLock={() => {
              navigation.navigate('AutoLock');
            }}
            onSecurity={() => {
              navigation.navigate('Security');
            }}
            onWipePin={() => {
              navigation.navigate('WipePin');
            }}
            onCloudBackup={() => {
              navigation.navigate('CloudBackup');
            }}
            onSupport={() => {
              navigation.navigate('Support');
            }}
            onAbout={() => {
              navigation.navigate('VaultAbout');
            }}
            onBack={() => {
              navigation.goBack();
            }}
            reloadToken={wipePinToken}
          />
        )}
      </VaultStack.Screen>

      <VaultStack.Screen name="ChangePin">
        {({ navigation }) => (
          <PinSetupScreen
            mode="change"
            onDone={() => {
              navigation.goBack();
            }}
            onCancel={() => {
              navigation.goBack();
            }}
          />
        )}
      </VaultStack.Screen>

      <VaultStack.Screen name="AutoLock">
        {({ navigation }) => (
          <AutoLockScreen
            onBack={() => {
              navigation.goBack();
            }}
          />
        )}
      </VaultStack.Screen>

      <VaultStack.Screen name="Security">
        {({ navigation }) => (
          <SecurityScreen
            onBack={() => {
              navigation.goBack();
            }}
          />
        )}
      </VaultStack.Screen>

      <VaultStack.Screen name="WipePin">
        {({ navigation }) => (
          <WipePinScreen
            onBack={() => {
              setWipePinToken((token) => token + 1);
              navigation.goBack();
            }}
          />
        )}
      </VaultStack.Screen>

      <VaultStack.Screen name="CloudBackup">
        {({ navigation }) => (
          <CloudBackupScreen
            onBack={() => {
              navigation.goBack();
            }}
          />
        )}
      </VaultStack.Screen>

      <VaultStack.Screen name="Support">
        {({ navigation }) => (
          <SupportScreen
            onBack={() => {
              navigation.goBack();
            }}
          />
        )}
      </VaultStack.Screen>

      <VaultStack.Screen name="VaultAbout">
        {({ navigation }) => (
          <AboutScreen
            onBack={() => {
              navigation.goBack();
            }}
          />
        )}
      </VaultStack.Screen>
    </VaultStack.Navigator>
  );
}

export function RootNavigator(): React.JSX.Element {
  // Locking from anywhere flips this and unmounts the vault flow; no screen has to navigate first.
  const unlocked = useIsUnlocked();
  const colors = useTheme();
  const theme = useMemo(() => navigationThemeFor(colors), [colors]);

  return (
    <NavigationContainer theme={theme}>
      {unlocked ? <VaultFlow /> : <LockedFlow />}
    </NavigationContainer>
  );
}
