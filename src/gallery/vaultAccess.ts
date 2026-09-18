/**
 * One way to reach the live repository from a screen.
 *
 * `useVaultRepository()` throws when the vault is closed, which is right for code that must fail
 * closed but wrong for a screen that is still mounted while the vault locks: the controller nulls
 * its repository a tick before the store reports `isOpen: false`, so a throwing read during that
 * tick would crash the screen instead of quietly emptying it.
 *
 * It is a module-level function rather than an inline `services.vault.current` because the React
 * Compiler treats any `.current` read inside a component as a React ref access and then refuses to
 * compile the surrounding `useCallback`.
 */
import type { Services } from '@/app/services';
import type { VaultRepository } from '@/vault/types';

export function openRepository(services: Services): VaultRepository | null {
  return services.vault.current;
}
