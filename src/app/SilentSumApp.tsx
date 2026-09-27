/**
 * The app shell.
 *
 * Takes a ready-made services object so tests can boot the real screens against in-memory fakes,
 * while `App.tsx` builds the production one. Nothing here reaches a native module directly.
 */
import React, { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, StatusBar, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ServicesProvider } from '@/app/ServicesProvider';
import { ThemeProvider } from '@/app/ThemeProvider';
import type { Services } from '@/app/services';
import { type Palette, useStyles, useTheme } from '@/app/theme';
import { RootNavigator } from '@/navigation/RootNavigator';
import { AppLifecycleGuard } from '@/privacy/AppLifecycleGuard';

export function SilentSumApp({ services }: { services: Services }): React.JSX.Element {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let stopEntitlements: (() => void) | null = null;
    void (async () => {
      const settings = await services.settings.load();
      // Telemetry follows the stored preference: crash reports default on, analytics off.
      await services.firebase.crash.setEnabled(settings.crashReportsEnabled);
      await services.firebase.analytics.setEnabled(settings.analyticsEnabled);
      // The cached tier is read before the first screen paints, so Pro is never a flicker away
      // on a phone with no network; the live document then follows the signed-in account.
      await services.entitlements.load();
      if (cancelled) return;
      stopEntitlements = services.entitlements.start();
      setReady(true);
    })().catch(() => {
      // A failed settings read must never block the calculator; defaults already apply.
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
      stopEntitlements?.();
    };
  }, [services]);

  // The providers wrap the shell rather than the other way round: the shell paints the window
  // background and the status bar, and those follow the chosen palette too.
  return (
    <ServicesProvider services={services}>
      <ThemeProvider>
        <Shell>
          {ready ? (
            <AppLifecycleGuard>
              <RootNavigator />
            </AppLifecycleGuard>
          ) : (
            <Booting />
          )}
        </Shell>
      </ThemeProvider>
    </ServicesProvider>
  );
}

function Booting(): React.JSX.Element {
  const colors = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.loading} testID="app-loading">
      <ActivityIndicator color={colors.textMuted} />
    </View>
  );
}

function Shell({ children }: { children: ReactNode }): React.JSX.Element {
  const colors = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <StatusBar
          barStyle={colors.dark ? 'light-content' : 'dark-content'}
          backgroundColor={colors.background}
        />
        {children}
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    root: { flex: 1, backgroundColor: colors.background },
    loading: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  });
