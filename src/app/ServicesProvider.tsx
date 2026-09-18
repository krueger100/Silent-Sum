/**
 * Makes the composition root available to the tree, and nothing else.
 *
 * Screens call the hooks in this file instead of importing adapters, so the same screens run in
 * tests against in-memory fakes. There is no module-level singleton: each provider owns its own
 * services, which is what keeps tests isolated from one another.
 */
import React, { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useStore } from 'zustand';

import type { Services } from '@/app/services';
import type { VaultControllerState } from '@/app/vaultController';
import type { VaultSessionState } from '@/auth/vaultSession';
import type { AppSettings } from '@/settings/appSettings';
import type { PhotoEntry, VaultRepository } from '@/vault/types';

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({
  services,
  children,
}: {
  services: Services;
  children: ReactNode;
}): React.JSX.Element {
  // The services object is stable for the life of the provider; memoising guards against a caller
  // rebuilding it inline on every render, which would recreate the vault on every frame.
  const value = useMemo(() => services, [services]);
  return <ServicesContext.Provider value={value}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (services === null) {
    throw new Error('useServices must be used inside a ServicesProvider');
  }
  return services;
}

export function useVaultSession(): VaultSessionState {
  const { session } = useServices();
  return useStore(session.store);
}

export function useIsUnlocked(): boolean {
  const { session } = useServices();
  return useStore(session.store, (s) => s.isUnlocked);
}

export function useVaultState(): VaultControllerState {
  const { vault } = useServices();
  return useStore(vault.store);
}

export function usePhotos(): readonly PhotoEntry[] {
  const { vault } = useServices();
  return useStore(vault.store, (s) => s.photos);
}

export function useSettings(): AppSettings {
  const { settings } = useServices();
  return useStore(settings.store);
}

/**
 * The repository for the current session. Throws when locked, which is deliberate: a screen that
 * is still mounted after a lock must fail rather than render stale plaintext.
 */
export function useVaultRepository(): VaultRepository {
  const { vault } = useServices();
  return vault.requireRepository();
}
