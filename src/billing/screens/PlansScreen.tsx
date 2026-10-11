/**
 * SilentSum Pro and SilentSum Cloud: what they cost, what the account has, and the way to buy.
 *
 * Nothing is charged from this screen. Pressing Buy or Subscribe asks the backend for a hosted
 * PayMongo page, opens it in the browser, and then WAITS: the entitlement document is written by
 * the server once PayMongo confirms the payment, and this screen simply follows that document.
 * "I have paid" asks the backend to look at PayMongo's own record of the session -- the same
 * source the webhook uses -- for the case where the confirmation is late. There is no path on
 * which the app tells the server what it owns.
 *
 * The backup account is required, because it is the identity entitlements are filed under. It
 * is the same credential as on the cloud-backup screen and it can no more open the vault here
 * than there.
 *
 * Two facts are shown side by side and kept apart on purpose: Pro is permanent, Cloud is a paid
 * term with an end date. Neither line ever implies the other.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, StyleSheet, Text, View } from 'react-native';

import { useEntitlements, useServices } from '@/app/ServicesProvider';
import { radius, spacing, type Palette, typography, useStyles, useTheme } from '@/app/theme';
import { BillingError, type BillingService } from '@/billing/billingService';
import {
  CLOUD_BANDS,
  cloudActive,
  deriveCloudState,
  type Entitlements,
} from '@/billing/entitlements';
import {
  CLOUD_TERM_DAYS,
  PLANS_TITLE,
  PRODUCTS,
  pesoNote,
  usdPrice,
  type ProductId,
} from '@/billing/products';
import { describeBillingError, describeSyncOutcome } from '@/billing/screens/billingErrors';
import { formatDay } from '@/billing/screens/formatDay';
import { Button } from '@/components/Button';
import { ConfirmDialog } from '@/components/Dialog';
import { Field } from '@/components/Field';
import { Paragraph, Screen, SectionLabel } from '@/components/Screen';
import type { CloudBackend, CloudUser } from '@/firebase/types';

export interface PlansScreenProps {
  onBack?: () => void;
  /** Opens the hosted checkout page. Resolves false when no browser could take it. */
  openUrl?: (url: string) => Promise<boolean>;
}

/** The system browser. A page that cannot be opened is shown as an address instead. */
async function openInBrowser(url: string): Promise<boolean> {
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}

/** A checkout in progress: what was bought, where, and what the account had before it. */
interface Waiting {
  readonly product: ProductId;
  /**
   * The PayMongo checkout session, for "I have paid".
   *
   * Null for a SUBSCRIPTION: there is no session to reconcile. A subscription's first charge is
   * confirmed by PayMongo's `subscription.invoice.paid` webhook and reaches the app the only way
   * it ever could -- the entitlement document changing -- so the fallback there is to look
   * again, not to ask the backend about a session that does not exist.
   */
  readonly checkoutId: string | null;
  readonly url: string;
  /** Undefined until the browser has been asked; false when it could not open. */
  readonly opened: boolean | undefined;
  /** Cloud's end date before this purchase, so "it changed" is the signal, not "it is set". */
  readonly accessUntilBefore: number | null;
}

export function PlansScreen({
  onBack,
  openUrl = openInBrowser,
}: PlansScreenProps): React.JSX.Element {
  const styles = useStyles(makeStyles);
  const services = useServices();
  const billing = services.billing;
  const cloud = services.firebase.cloud;

  if (billing === null || cloud === null) {
    return (
      <Screen
        title={PLANS_TITLE}
        scroll
        testID="plans_screen"
        {...(onBack === undefined ? {} : { onBack })}
      >
        <View style={styles.card} testID="plans_unavailable">
          <Text style={styles.cardTitle}>Purchases are not available in this build</Text>
          <Text style={styles.cardLine}>
            This copy of the app was built without a billing backend, so there is nothing to buy and
            nothing to sign in to.
          </Text>
          <Text style={styles.cardLine}>
            Every feature is unlocked, and the vault works exactly as it always does: local,
            encrypted, and opened entirely offline.
          </Text>
        </View>
      </Screen>
    );
  }

  return (
    <PlansBody
      billing={billing}
      cloud={cloud}
      openUrl={openUrl}
      {...(onBack === undefined ? {} : { onBack })}
    />
  );
}

function PlansBody({
  billing,
  cloud,
  openUrl,
  onBack,
}: {
  billing: BillingService;
  cloud: CloudBackend;
  openUrl: (url: string) => Promise<boolean>;
  onBack?: () => void;
}): React.JSX.Element {
  const colors = useTheme();
  const styles = useStyles(makeStyles);
  const services = useServices();
  const { entitlements, synced } = useEntitlements();
  const now = services.clock.now();

  const [user, setUser] = useState<CloudUser | null>(cloud.currentUser);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<Waiting | null>(null);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const mounted = useRef(true);

  useEffect(() => cloud.onAuthStateChanged(setUser), [cloud]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * A wait ends the moment the document says the purchase landed: for Pro the flag turning on,
   * for Cloud the end date moving (Cloud may already have been on). It is DERIVED from the store
   * on every render rather than copied into state, so there is no effect to lag a frame behind
   * and no way for the screen to keep waiting for something that has already happened.
   */
  const landed = waiting !== null && purchaseLanded(waiting, entitlements, now);
  const pendingCheckout = landed ? null : waiting;
  const landedLine =
    waiting === null || !landed
      ? null
      : waiting.product === 'pro'
        ? `${PRODUCTS.pro.name} is now active on this account. ${PRODUCTS.pro.tagline}`
        : `${PRODUCTS.cloud.name} is active until ${formatDay(entitlements.cloud.accessUntil ?? now)}.`;

  /**
   * Paying hands the user to a browser, and the vault must not lock while they are in it.
   *
   * It is the same deliberate hand-off the photo picker and the camera permission dialog already
   * suspend for, and it matters more here: locking unmounts this screen with the rest of the
   * vault stack, taking the pending checkout and the "I have paid" fallback with it, so a payment
   * that really was made can end up with no entitlement and no way left to reconcile it.
   *
   * Tied to the pending checkout rather than to the button, so that every way a checkout can end
   * -- it landed, it was abandoned, the screen was closed -- resumes exactly once. The grace is
   * bounded (`AUTO_LOCK_SUSPENSION_GRACE_MS`), so a phone genuinely left alone still locks.
   */
  const awaitingPayment = pendingCheckout !== null;
  useEffect(() => {
    if (!awaitingPayment) return;
    const suspension = services.autoLockSuspension;
    suspension.suspend();
    return () => {
      suspension.resume();
    };
  }, [awaitingPayment, services]);

  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      if (mounted.current) setError(describeBillingError(cause));
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);

  const editCredential =
    (setter: (value: string) => void) =>
    (value: string): void => {
      setter(value);
      setError(null);
    };

  const authenticate = (create: boolean): void => {
    const address = email.trim();
    const secret = password;
    if (address === '') {
      setError('Enter the email address for the backup account.');
      return;
    }
    if (secret === '') {
      setError(
        create
          ? 'Choose a password for the new backup account.'
          : 'Enter the password for the backup account.',
      );
      return;
    }
    void run(async () => {
      setStatus(null);
      const account = create
        ? await cloud.signUp(address, secret)
        : await cloud.signIn(address, secret);
      setPassword('');
      setUser(account);
    });
  };

  const signOut = (): void => {
    void run(async () => {
      await cloud.signOut();
      setUser(null);
      setWaiting(null);
      setStatus(null);
    });
  };

  const refresh = (): void => {
    void run(async () => {
      await services.entitlements.refresh();
      setStatus('Plan status refreshed.');
    });
  };

  /**
   * One hosted checkout, started and opened. NOT wrapped in `run`.
   *
   * `run` refuses to start while another action is in flight, so an action that calls another
   * action through it is silently dropped -- which is exactly what the subscription fallback
   * does. Keeping the work here and the wrapping at the edges means either entry point can
   * reach it, and neither can swallow the other.
   */
  const openCheckout = async (product: ProductId): Promise<void> => {
    const start = await billing.createCheckout(product);
    if (!mounted.current) return;
    setWaiting({
      product,
      checkoutId: start.checkoutId,
      url: start.checkoutUrl,
      opened: undefined,
      accessUntilBefore: entitlements.cloud.accessUntil,
    });
    const opened = await openUrl(start.checkoutUrl);
    if (!mounted.current) return;
    setWaiting((current) =>
      current === null || current.checkoutId !== start.checkoutId ? current : { ...current, opened },
    );
  };

  const buy = (product: ProductId): void => {
    void run(async () => {
      setStatus(null);
      await openCheckout(product);
    });
  };

  /**
   * One monthly Cloud subscription, with the one-off term as the fallback.
   *
   * The fallback is not a nicety. PayMongo enables Subscriptions per merchant account, so a
   * build that only knew how to subscribe would make Cloud unbuyable the moment it met a backend
   * where the feature is off -- which is every deployment today. Which path was taken is said
   * out loud in the status line, because the two charge differently and the user is about to
   * agree to one of them.
   */
  const subscribeCloud = (): void => {
    void run(async () => {
      setStatus(null);
      let start;
      try {
        start = await billing.startCloudSubscription();
      } catch (error) {
        if (!(error instanceof BillingError) || error.code !== 'unsupported') throw error;
        await openCheckout('cloud');
        return;
      }
      if (!mounted.current) return;
      setWaiting({
        product: 'cloud',
        checkoutId: null,
        url: start.authorizeUrl,
        opened: undefined,
        accessUntilBefore: entitlements.cloud.accessUntil,
      });
      setStatus(
        `₱${String(Math.round(start.priceCentavos / 100))} a month for up to ${start.bandLabel}, ` +
          'charged automatically until you cancel.',
      );
      const opened = await openUrl(start.authorizeUrl);
      if (!mounted.current) return;
      setWaiting((current) =>
        current === null || current.checkoutId !== null ? current : { ...current, opened },
      );
    });
  };

  const iHavePaid = (): void => {
    const pending = pendingCheckout;
    if (pending === null) return;
    const checkoutId = pending.checkoutId;
    if (checkoutId === null) {
      // A subscription has no session to reconcile; the document is the only answer there is.
      void run(async () => {
        await services.entitlements.refresh();
      });
      return;
    }
    void run(async () => {
      const outcome = await billing.syncCheckout(checkoutId);
      if (!mounted.current) return;
      if (outcome === 'paid') {
        setStatus('PayMongo confirmed the payment. Your plan updates in a moment.');
        await services.entitlements.refresh();
        return;
      }
      if (outcome === 'pending') {
        setStatus(describeSyncOutcome(outcome));
        return;
      }
      setWaiting(null);
      setError(describeSyncOutcome(outcome));
    });
  };

  const cancelCloud = (): void => {
    setConfirmingCancel(false);
    void run(async () => {
      await billing.cancelCloud();
      const until = entitlements.cloud.accessUntil;
      setStatus(
        until === null
          ? `${PRODUCTS.cloud.name} will not renew.`
          : `${PRODUCTS.cloud.name} will not renew. It stays on until ${formatDay(until)}.`,
      );
    });
  };

  const cloudState = deriveCloudState(entitlements, now);

  /**
   * Whether Renew is on screen at all, which is NOT the same question as whether it would work.
   *
   * Renew is the way back from cancelling, not an action on a healthy plan: while Cloud is on
   * and staying on, the only thing a user can usefully do to it is stop it, so Cancel is the
   * one button there. An inert "Renews automatically" button said the same thing but took up a
   * primary action slot to say it, and the bullet above already says it in words.
   *
   * ONE EXCEPTION, and it is not an oversight. A plan that does NOT renew itself and is inside
   * its last `CLOUD_RENEWAL_WINDOW_DAYS` keeps the button, because the status line says "renew
   * soon" at exactly that point and a prompt with no way to act on it is a dead end -- the user
   * would have to cancel in order to renew, or let Cloud lapse and lose access in between.
   * Every SilentSum account today is a term, so this is the case that actually ships.
   */
  const renewable =
    cloudState.kind === 'active' &&
    (cloudState.cancelAtPeriodEnd || (!cloudState.autoRenews && cloudState.renewalDue));

  const signedIn = user !== null;
  const canAct = signedIn && pendingCheckout === null && !busy;
  const statusLine = landedLine ?? status;

  return (
    <Screen
      title={PLANS_TITLE}
      scroll
      testID="plans_screen"
      {...(onBack === undefined ? {} : { onBack })}
    >
      <Paragraph>
        Two things you can buy, and they are independent of each other. Pro is messaging: paid
        once, never expires. Cloud is storage: paid month by month, and it covers how much the
        vault holds as well as the services that run on a server. Opening the vault needs neither
        — it is local, encrypted and unlocked offline — and nothing already in it can be taken
        away by either.
      </Paragraph>

      {busy ? <ActivityIndicator testID="plans_busy" color={colors.accent} /> : null}
      {error === null ? null : (
        <Text testID="plans_error" style={styles.error}>
          {error}
        </Text>
      )}
      {statusLine === null ? null : (
        <Text testID="plans_status" style={styles.status}>
          {statusLine}
        </Text>
      )}

      <SectionLabel>Your plan</SectionLabel>
      <View style={styles.card} testID="plans_status_card">
        <Text testID="plans_status_pro" style={styles.cardLine}>
          {proLine(entitlements)}
        </Text>
        <Text testID="plans_status_cloud" style={styles.cardLine}>
          {cloudLine(entitlements, now)}
        </Text>
        {signedIn && !synced ? (
          <Text testID="plans_status_checking" style={styles.muted}>
            Checking with the server...
          </Text>
        ) : null}
      </View>

      {pendingCheckout === null ? null : (
        <View style={styles.card} testID="plans_waiting">
          <Text style={styles.cardTitle}>Waiting for PayMongo to confirm your payment</Text>
          <Text style={styles.cardLine}>
            {`Finish paying for ${PRODUCTS[pendingCheckout.product].name} in the browser, then ` +
              'come back here. This screen updates by itself as soon as PayMongo confirms; that ' +
              'can take a moment.'}
          </Text>
          {pendingCheckout.opened === false ? (
            <Text testID="plans_checkout_url" style={styles.muted} selectable>
              {`Your browser could not be opened. Visit this address to pay: ${pendingCheckout.url}`}
            </Text>
          ) : null}
          {/* "I have paid" asks the backend about a session. A subscription has none, so the
              same button says what it can actually do there: look at the document again. */}
          <Button
            testID="plans_i_paid"
            label={pendingCheckout.checkoutId === null ? 'Check again' : 'I have paid'}
            busy={busy}
            onPress={iHavePaid}
          />
          <Button
            testID="plans_stop_waiting"
            label="Cancel"
            variant="ghost"
            disabled={busy}
            onPress={() => {
              setWaiting(null);
              setStatus(null);
              setError(null);
            }}
          />
        </View>
      )}

      <SectionLabel>Plans</SectionLabel>
      <View style={styles.card} testID="plans_product_pro">
        <Text style={styles.productName}>{PRODUCTS.pro.name}</Text>
        {/* The dollar reads as the price and the peso sits under it. Both lines are on this
            screen alone, where the two plans are compared; the inline mentions elsewhere keep
            the peso only, since they are nudges mid-sentence rather than a price list. */}
        <Text testID="plans_pro_price_usd" style={styles.productPrice}>
          {usdPrice(PRODUCTS.pro)}
        </Text>
        <Text testID="plans_pro_price_php" style={styles.priceApprox}>
          {pesoNote(PRODUCTS.pro)}
        </Text>
        <Text style={styles.cardLine}>{PRODUCTS.pro.tagline}</Text>
        <Bullets
          styles={styles}
          testID="plans_pro_features"
          items={[
            'End-to-end encrypted messaging with other SilentSum users',
            'Real-time conversations: send, receive and reply',
            'As many conversations as you like, each with its own history',
            'Permanent. Paid once, on this account, and it never expires',
          ]}
        />
        {entitlements.pro ? (
          <Text testID="plans_pro_owned" style={styles.owned}>
            Purchased. Yours for good.
          </Text>
        ) : !signedIn ? (
          <Text style={styles.muted}>Sign in below to buy.</Text>
        ) : pendingCheckout === null ? (
          <Button
            testID="plans_buy_pro"
            label="Buy Pro"
            disabled={!canAct}
            onPress={() => {
              buy('pro');
            }}
          />
        ) : null}
      </View>

      <View style={styles.card} testID="plans_product_cloud">
        <Text style={styles.productName}>{PRODUCTS.cloud.name}</Text>
        <Text testID="plans_cloud_price_usd" style={styles.productPrice}>
          {usdPrice(PRODUCTS.cloud)}
        </Text>
        <Text testID="plans_cloud_price_php" style={styles.priceApprox}>
          {pesoNote(PRODUCTS.cloud)}
        </Text>
        <Text style={styles.cardLine}>{PRODUCTS.cloud.tagline}</Text>
        <Bullets
          styles={styles}
          testID="plans_cloud_features"
          items={[
            `You pay for what you store: ${CLOUD_BANDS.map((b) => `₱${String(b.pricePhp)} up to ${b.label}`).join(', ')}`,
            'The 50-item limit is lifted; photos and videos both count towards the space',
            'Encrypted cloud backup and restore, and support chat',
            // NOT "a subscription", which this has never been. Nothing is charged automatically
            // -- `CLOUD_TERM_DAYS` of access is bought one payment at a time -- and the muted
            // line below said so while this bullet said the opposite, on the same screen.
            cloudState.kind === 'active' && cloudState.autoRenews
              ? `Renewed automatically every ${String(CLOUD_TERM_DAYS)} days until you cancel`
              : `Paid ${String(CLOUD_TERM_DAYS)} days at a time, by hand: nothing renews on its own`,
          ]}
        />
        {/* The two billing modes make opposite promises, and a screen that states the wrong one
            is the bug this pair exists to prevent: it previously said "nothing is charged
            automatically" directly under a bullet calling Cloud a subscription. */}
        <Text style={styles.muted}>
          {cloudState.kind === 'active' && cloudState.autoRenews
            ? `Each renewal adds ${String(CLOUD_TERM_DAYS)} days and is charged automatically. ` +
              'Cancel whenever you like and it runs to the end of the period already paid for. ' +
              'Everything already in your vault stays, readable offline, and Pro is never affected.'
            : `Each payment adds ${String(CLOUD_TERM_DAYS)} days. Nothing is charged automatically: ` +
              'renew whenever you like, and let it lapse whenever you like. Everything already in ' +
              'your vault stays, readable offline, and Pro is never affected.'}
        </Text>
        {!signedIn ? (
          <Text style={styles.muted}>Sign in below to subscribe.</Text>
        ) : pendingCheckout !== null ? null : cloudState.kind === 'active' ? (
          <>
            {renewable ? (
              <Button
                testID="plans_renew_cloud"
                label="Renew"
                disabled={!canAct}
                onPress={subscribeCloud}
              />
            ) : null}
            {cloudState.cancelAtPeriodEnd ? null : (
              <Button
                testID="plans_cancel_cloud"
                label="Cancel Cloud"
                variant="ghost"
                disabled={!canAct}
                onPress={() => {
                  setConfirmingCancel(true);
                }}
              />
            )}
          </>
        ) : (
          <Button
            testID="plans_subscribe_cloud"
            label="Subscribe"
            disabled={!canAct}
            onPress={subscribeCloud}
          />
        )}
      </View>

      <SectionLabel>Account</SectionLabel>
      {user === null ? (
        <View style={styles.form}>
          <Paragraph>
            Purchases are filed under your backup account, so the same account brings them to a new
            phone. It is a completely separate credential from your vault PIN and cannot open the
            vault.
          </Paragraph>
          <Field
            testID="plans_email"
            label="Email"
            value={email}
            onChangeText={editCredential(setEmail)}
            keyboardType="email-address"
          />
          <Field
            testID="plans_password"
            label="Account password"
            value={password}
            onChangeText={editCredential(setPassword)}
            secure
          />
          <Button
            testID="plans_sign_in"
            label="Sign in"
            busy={busy}
            onPress={() => {
              authenticate(false);
            }}
          />
          <Button
            testID="plans_sign_up"
            label="Create account"
            variant="secondary"
            disabled={busy}
            onPress={() => {
              authenticate(true);
            }}
          />
        </View>
      ) : (
        <>
          <View style={styles.card} testID="plans_account_row">
            <Text style={styles.cardTitle}>{user.email ?? user.uid}</Text>
            <Text style={styles.muted}>
              Purchases belong to this account. This password cannot open your vault.
            </Text>
            <Button
              testID="plans_sign_out"
              label="Sign out"
              variant="ghost"
              disabled={busy}
              onPress={signOut}
            />
          </View>
          <Button
            testID="plans_refresh"
            label="Refresh status"
            variant="secondary"
            disabled={busy}
            onPress={refresh}
          />
        </>
      )}

      <SectionLabel>Good to know</SectionLabel>
      <Paragraph>
        Payments are handled by PayMongo on its own page. This app never sees your card or wallet
        details, and no key is ever attached to a payment.
      </Paragraph>
      <Paragraph>
        Pro is permanent. Cloud is a paid term with an end date; when it lapses, backup, restore
        and adding to the vault pause, and everything already on this phone stays exactly as it is.
      </Paragraph>

      <ConfirmDialog
        testID="plans_cancel_confirm"
        visible={confirmingCancel}
        title="Cancel SilentSum Cloud?"
        message={
          cloudState.kind === 'active'
            ? `Cloud stays on until ${formatDay(cloudState.until)} and is not renewed after that. ` +
              'Nothing in your backup is deleted by this, and Pro is not affected.'
            : 'Cloud will not renew. Nothing in your backup is deleted by this.'
        }
        confirmLabel="Cancel Cloud"
        cancelLabel="Keep it"
        onConfirm={cancelCloud}
        onCancel={() => {
          setConfirmingCancel(false);
        }}
      />
    </Screen>
  );
}

/**
 * What a plan buys, one line each. A list rather than a paragraph because the two plans are
 * independent and the reader's real question is "which one has the thing I want".
 */
function Bullets({
  items,
  styles,
  testID,
}: {
  items: readonly string[];
  styles: ReturnType<typeof makeStyles>;
  testID: string;
}): React.JSX.Element {
  return (
    <View testID={testID}>
      {items.map((item) => (
        <View key={item} style={styles.bulletRow}>
          <Text style={styles.bulletDot}>•</Text>
          <Text style={styles.bulletText}>{item}</Text>
        </View>
      ))}
    </View>
  );
}

/** Whether the document now reflects the purchase a wait was started for. */
function purchaseLanded(waiting: Waiting, entitlements: Entitlements, now: number): boolean {
  if (waiting.product === 'pro') return entitlements.pro;
  const until = entitlements.cloud.accessUntil;
  return until !== null && until !== waiting.accessUntilBefore && cloudActive(entitlements, now);
}

function proLine(entitlements: Entitlements): string {
  if (!entitlements.pro) return 'Pro: not purchased';
  return entitlements.proSince === null
    ? 'Pro: active'
    : `Pro: active since ${formatDay(entitlements.proSince)}`;
}

function cloudLine(entitlements: Entitlements, now: number): string {
  const state = deriveCloudState(entitlements, now);
  switch (state.kind) {
    case 'inactive':
      return 'Cloud: not subscribed';
    case 'expired':
      return `Cloud: expired on ${formatDay(state.on)}`;
    case 'active': {
      let line = `Cloud: active until ${formatDay(state.until)}`;
      if (state.pastDue) line += ' · payment overdue';
      if (state.cancelAtPeriodEnd) line += ' · cancelled';
      else if (state.renewalDue) line += ' · renew soon';
      return line;
    }
  }
}

const makeStyles = (colors: Palette) =>
  StyleSheet.create({
    card: {
      backgroundColor: colors.surface,
      borderRadius: radius.md,
      padding: spacing.md,
      gap: spacing.sm,
    },
    form: { gap: spacing.md },
    cardTitle: { ...typography.label, color: colors.text, fontSize: 16 },
    cardLine: { ...typography.body, color: colors.textMuted, lineHeight: 22 },
    bulletRow: { flexDirection: 'row', gap: spacing.sm, paddingRight: spacing.sm },
    bulletDot: { ...typography.caption, color: colors.textMuted, lineHeight: 19 },
    bulletText: { ...typography.caption, color: colors.textMuted, lineHeight: 19, flex: 1 },
    productName: { ...typography.title, color: colors.text },
    productPrice: { ...typography.label, color: colors.accent, fontSize: 18 },
    // Muted and small on purpose: an approximation must not read as the price.
    priceApprox: { ...typography.caption, color: colors.textMuted, marginTop: -2 },
    owned: { ...typography.label, color: colors.success, fontSize: 16 },
    muted: { ...typography.caption, color: colors.textMuted, lineHeight: 17 },
    error: { ...typography.label, color: colors.danger },
    status: { ...typography.label, color: colors.success },
  });
