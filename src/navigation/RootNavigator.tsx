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

import {
  useIsUnlocked,
  useRecoveryAuthorized,
  useServices,
  useSettings,
} from '@/app/ServicesProvider';
import { useTheme, type Palette } from '@/app/theme';
import { PinSetupScreen } from '@/auth/screens/PinSetupScreen';
import { RestoreFlowScreen } from '@/backup/screens/RestoreFlowScreen';
import { PlansScreen } from '@/billing/screens/PlansScreen';
import { CloudBackupScreen } from '@/backup/screens/CloudBackupScreen';
import { CalculatorScreen } from '@/calculator/CalculatorScreen';
import { CloudGalleryScreen } from '@/gallery/CloudGalleryScreen';
import { GalleryScreen } from '@/gallery/GalleryScreen';
import { PhotoViewerScreen } from '@/gallery/PhotoViewerScreen';
import { AboutScreen } from '@/settings/screens/AboutScreen';
import { AutoLockScreen } from '@/settings/screens/AutoLockScreen';
import { SecurityScreen } from '@/settings/screens/SecurityScreen';
import { SettingsScreen } from '@/settings/screens/SettingsScreen';
import { SupportScreen } from '@/settings/screens/SupportScreen';
import { ConversationScreen } from '@/messaging/screens/ConversationScreen';
import { ConversationsScreen } from '@/messaging/screens/ConversationsScreen';
import { SupportChatScreen } from '@/support/chat/SupportChatScreen';
import { WipePinScreen } from '@/settings/screens/WipePinScreen';

/**
 * A name in both stacks is a name that can survive a lock -- see the container key at the bottom
 * of this file for why, and keep collisions deliberate. `VaultAbout` is spelled that way rather
 * than `About` for this reason.
 */
export type LockedStackParams = {
  Calculator: undefined;
  PinSetup: undefined;
  Restore: undefined;
  About: undefined;
  /** Reachable only from the restore flow, which has already revealed the vault. */
  Plans: undefined;
};

export type VaultStackParams = {
  Gallery: undefined;
  PhotoViewer: { photoId: string; index: number };
  Settings: undefined;
  ChangePin: undefined;
  AutoLock: undefined;
  Security: undefined;
  WipePin: undefined;
  CloudGallery: undefined;
  CloudBackup: undefined;
  Plans: undefined;
  Support: undefined;
  SupportChat: undefined;
  Messages: undefined;
  Conversation: { conversationId: string };
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
  const { recovery } = useServices();
  // Drives the overwrite power below, and re-renders the stack the instant it is withdrawn.
  const recoveryAuthorized = useRecoveryAuthorized();

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
            // Replacing a vault that is already here is a power the recovery code lends, and
            // only for as long as it is live. Arriving any other way, this is false and
            // `adoptMasterKey` refuses, exactly as it always has.
            allowOverwrite={recoveryAuthorized}
            onDone={() => {
              // Recovered: the code has done its one job.
              recovery.clear();
              if (navigation.canGoBack()) navigation.popToTop();
            }}
            onBack={() => {
              // Backing out spends it too. A code is for one attempt, not for a door left
              // ajar behind whoever walks away from this screen.
              recovery.clear();
              navigation.goBack();
            }}
            onPlans={() => {
              navigation.navigate('Plans');
            }}
          />
        )}
      </LockedStack.Screen>

      <LockedStack.Screen name="Plans">
        {({ navigation }) => (
          <PlansScreen
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
            onRecoveryVerified={() => {
              navigation.navigate('Restore');
            }}
            // Super secure takes "Forgot PIN?" off the calculator menu, so this page is the only
            // remaining way to erase and start again. Wired here and NOT on the unlocked About,
            // where the gallery and settings already offer it in the open.
            onErased={() => {
              navigation.navigate('Calculator');
            }}
            onRestore={() => {
              navigation.navigate('Restore');
            }}
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
            onOpenPlans={() => {
              navigation.navigate('Plans');
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
            onCloudGallery={() => {
              navigation.navigate('CloudGallery');
            }}
            onPlans={() => {
              navigation.navigate('Plans');
            }}
            onSupport={() => {
              navigation.navigate('Support');
            }}
            onMessages={() => {
              navigation.navigate('Messages');
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

      <VaultStack.Screen name="CloudGallery">
        {({ navigation }) => (
          <CloudGalleryScreen
            onBack={() => {
              navigation.goBack();
            }}
            onOpenBackup={() => {
              navigation.navigate('CloudBackup');
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
            onPlans={() => {
              navigation.navigate('Plans');
            }}
          />
        )}
      </VaultStack.Screen>

      <VaultStack.Screen name="Plans">
        {({ navigation }) => (
          <PlansScreen
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
            onSupportChat={() => {
              navigation.navigate('SupportChat');
            }}
          />
        )}
      </VaultStack.Screen>

      <VaultStack.Screen name="Messages">
        {({ navigation }) => (
          <ConversationsScreen
            onBack={() => {
              navigation.goBack();
            }}
            onOpen={(conversationId) => {
              navigation.navigate('Conversation', { conversationId });
            }}
            onPlans={() => {
              navigation.navigate('Plans');
            }}
          />
        )}
      </VaultStack.Screen>

      <VaultStack.Screen name="Conversation">
        {({ navigation, route }) => (
          <ConversationScreen
            conversationId={route.params.conversationId}
            onBack={() => {
              navigation.goBack();
            }}
            onPlans={() => {
              navigation.navigate('Plans');
            }}
          />
        )}
      </VaultStack.Screen>

      <VaultStack.Screen name="SupportChat">
        {({ navigation }) => (
          <SupportChatScreen
            onBack={() => {
              navigation.goBack();
            }}
            onPlans={() => {
              navigation.navigate('Plans');
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
    /**
     * The key is what makes the swap a clean break, and it is load-bearing.
     *
     * A `NavigationContainer` keeps its navigation state when the navigator under it changes, and
     * hands it to the new one to rehydrate. The router then keeps whatever route names the new
     * navigator also declares and drops the rest. `Plans` is declared by both stacks, so locking
     * on it used to leave the LOCKED app showing the plans screen -- the user's billing address,
     * on a locked vault, where the calculator should be -- as the only route in the stack, which
     * is also why going back from it had nowhere to go.
     *
     * Remounting the container on every lock and unlock throws that state away instead. Nothing
     * should survive a lock; that is the whole point of the swap.
     */
    <NavigationContainer key={unlocked ? 'vault' : 'locked'} theme={theme}>
      {unlocked ? <VaultFlow /> : <LockedFlow />}
    </NavigationContainer>
  );
}
