/**
 * The bookkeeping around a code: which installation this is, spending a code exactly once, and
 * the authorization ending when it should.
 *
 * Codes here are minted with a real keypair through the real verifier, so "accepted" in these
 * tests means the same thing it means on a phone.
 */
import { crypto_sign_detached, crypto_sign_keypair } from 'react-native-libsodium';

import { SequentialRandom } from '@/crypto/random';
import { InMemorySecureStore, SECURE_STORE_KEYS } from '@/secure-storage/secureStore';
import { RecoveryAccess, SPENT_CODE_HISTORY } from '@/support/recoveryAccess';
import {
  dayNumber,
  encodeRecoveryCode,
  recoveryCodeMessage,
  RECOVERY_CODE_TTL_DAYS,
} from '@/support/recoveryCode';
import { base32Decode } from '@/utils/base32';
import type { Bytes } from '@/utils/bytes';
import { FakeClock } from '@/utils/clock';

const NOW = Date.UTC(2026, 8, 19, 12, 0, 0);

interface Harness {
  readonly access: RecoveryAccess;
  readonly store: InMemorySecureStore;
  readonly clock: FakeClock;
  readonly publicKey: Bytes;
  mint(options?: { ref?: Bytes; days?: number; privateKey?: Bytes }): Promise<string>;
}

function harness(overrides?: { publicKey?: Bytes; store?: InMemorySecureStore }): Harness {
  const pair = crypto_sign_keypair();
  const store = overrides?.store ?? new InMemorySecureStore();
  const clock = new FakeClock(NOW);
  const access = new RecoveryAccess({
    store,
    random: new SequentialRandom(),
    clock,
    publicKey: overrides?.publicKey ?? pair.publicKey,
  });

  return {
    access,
    store,
    clock,
    publicKey: pair.publicKey,
    async mint(options) {
      const ref = options?.ref ?? (await access.installRef());
      const days = dayNumber(clock.now()) + (options?.days ?? RECOVERY_CODE_TTL_DAYS);
      const signature = crypto_sign_detached(
        recoveryCodeMessage(ref, days),
        options?.privateKey ?? pair.privateKey,
      );
      return encodeRecoveryCode(days, signature);
    },
  };
}

describe('recovery access', () => {
  describe('installation reference', () => {
    it('is generated once and then kept', async () => {
      const h = harness();

      const first = await h.access.installRef();
      const second = await h.access.installRef();

      expect(Array.from(second)).toEqual(Array.from(first));
      expect(h.store.snapshot[SECURE_STORE_KEYS.installRef]).toBeDefined();
    });

    it('survives a restart, so a code mailed yesterday still names this phone', async () => {
      const store = new InMemorySecureStore();
      const first = await harness({ store }).access.installRef();

      const afterRestart = await harness({ store }).access.installRef();

      expect(Array.from(afterRestart)).toEqual(Array.from(first));
    });

    it('replaces an unreadable reference rather than failing', async () => {
      const store = new InMemorySecureStore({
        [SECURE_STORE_KEYS.installRef]: 'not a reference',
      });

      const ref = await harness({ store }).access.installRef();

      expect(ref).toHaveLength(10);
    });

    it('prints in groups of four, short enough to read down a phone line', async () => {
      expect(await harness().access.displayRef()).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    });
  });

  describe('redeeming', () => {
    it('accepts a genuine code and opens the door', async () => {
      const h = harness();

      expect(h.access.isAuthorized).toBe(false);
      await expect(h.access.redeem(await h.mint())).resolves.toEqual({ ok: true });
      expect(h.access.isAuthorized).toBe(true);
    });

    it('refuses the same code a second time, even after a restart', async () => {
      const store = new InMemorySecureStore();
      const h = harness({ store });
      const code = await h.mint();

      await expect(h.access.redeem(code)).resolves.toEqual({ ok: true });
      await expect(h.access.redeem(code)).resolves.toEqual({ ok: false, reason: 'used' });

      // A new process, the same phone, the same spent list.
      const restarted = new RecoveryAccess({
        store,
        random: new SequentialRandom(),
        clock: new FakeClock(NOW),
        publicKey: h.publicKey,
      });
      await expect(restarted.redeem(code)).resolves.toEqual({ ok: false, reason: 'used' });
      expect(restarted.isAuthorized).toBe(false);
    });

    it('still accepts a DIFFERENT code afterwards', async () => {
      const h = harness();

      await h.access.redeem(await h.mint());
      h.access.clear();

      await expect(h.access.redeem(await h.mint({ days: 6 }))).resolves.toEqual({ ok: true });
    });

    it('refuses a code minted for another installation', async () => {
      const h = harness();
      const someoneElse = Uint8Array.from([5, 5, 5, 5, 5, 5, 5, 5, 5, 5]);

      await expect(h.access.redeem(await h.mint({ ref: someoneElse }))).resolves.toEqual({
        ok: false,
        reason: 'rejected',
      });
      expect(h.access.isAuthorized).toBe(false);
    });

    it('refuses a code signed by the wrong key', async () => {
      const h = harness();
      const impostor = crypto_sign_keypair();

      await expect(
        h.access.redeem(await h.mint({ privateKey: impostor.privateKey })),
      ).resolves.toEqual({ ok: false, reason: 'rejected' });
      expect(h.access.isAuthorized).toBe(false);
    });

    it('refuses a code once its week is up', async () => {
      const h = harness();
      const code = await h.mint();

      h.clock.advance(RECOVERY_CODE_TTL_DAYS * 24 * 60 * 60 * 1000 + 1);

      await expect(h.access.redeem(code)).resolves.toEqual({ ok: false, reason: 'expired' });
      expect(h.access.isAuthorized).toBe(false);
    });

    it('refuses everything in a build with no public key, and says so', async () => {
      const h = harness({ publicKey: new Uint8Array(0) });

      expect(h.access.available).toBe(false);
      await expect(h.access.redeem(await h.mint())).resolves.toEqual({
        ok: false,
        reason: 'unavailable',
      });
    });

    it('does not spend a code that was refused', async () => {
      const h = harness();
      const good = await h.mint();

      await h.access.redeem('QQQQQQ-QQQQQQ');
      await h.access.redeem(await h.mint({ ref: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 0]) }));

      await expect(h.access.redeem(good)).resolves.toEqual({ ok: true });
    });

    it('bounds the spent list rather than growing it forever', async () => {
      const h = harness();

      for (let i = 0; i < SPENT_CODE_HISTORY + 5; i++) {
        await h.access.redeem(await h.mint({ days: i + 1 }));
        h.access.clear();
      }

      const raw = h.store.snapshot[SECURE_STORE_KEYS.spentRecoveryCodes] ?? '[]';
      expect((JSON.parse(raw) as string[]).length).toBe(SPENT_CODE_HISTORY);
    });
  });

  describe('the authorization ending', () => {
    it('clears on demand, and is idempotent', async () => {
      const h = harness();
      await h.access.redeem(await h.mint());

      h.access.clear();
      h.access.clear();

      expect(h.access.isAuthorized).toBe(false);
    });

    it('is never written down, so a restart starts closed', async () => {
      const store = new InMemorySecureStore();
      const h = harness({ store });
      await h.access.redeem(await h.mint());

      expect(h.access.isAuthorized).toBe(true);
      expect(JSON.stringify(store.snapshot)).not.toContain('authorized');

      const restarted = new RecoveryAccess({
        store,
        random: new SequentialRandom(),
        clock: new FakeClock(NOW),
        publicKey: h.publicKey,
      });
      expect(restarted.isAuthorized).toBe(false);
    });

    it('notifies subscribers, so the UI does not have to poll', async () => {
      const h = harness();
      const seen: boolean[] = [];
      h.access.store.subscribe((state) => seen.push(state.authorized));

      await h.access.redeem(await h.mint());
      h.access.clear();

      expect(seen).toEqual([true, false]);
    });
  });

  it('holds nothing that could open a vault: no key material, no PIN, no passphrase', async () => {
    const h = harness();
    await h.access.redeem(await h.mint());

    // The whole persisted footprint is an address and some spent-code fingerprints.
    const persisted = h.store.snapshot;
    expect(Object.keys(persisted).sort()).toEqual(
      [SECURE_STORE_KEYS.installRef, SECURE_STORE_KEYS.spentRecoveryCodes].sort(),
    );
    // The reference decodes to ten random bytes and nothing else.
    expect(base32Decode(persisted[SECURE_STORE_KEYS.installRef] ?? '')).toHaveLength(10);
    // And the service exposes no way to reach key material at all.
    expect(Object.keys(h.access)).not.toContain('keys');
  });
});
