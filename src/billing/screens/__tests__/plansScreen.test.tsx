import React from 'react';
import { act, fireEvent, screen, waitFor } from '@testing-library/react-native';

import { BillingError } from '@/billing/billingService';
import { CLOUD_BANDS } from '@/billing/entitlements';
import { PRODUCTS } from '@/billing/products';
import { PlansScreen } from '@/billing/screens/PlansScreen';
import {
  ACCOUNT_PASSWORD,
  EMAIL,
  buildBillingHarness,
  buildOfflineHarness,
  renderWithServices,
  rerenderWithServices,
  startEntitlements,
  type BillingHarness,
} from '@/billing/screens/__tests__/harness';

const DAY = 86_400_000;

async function signIn(harness: BillingHarness): Promise<void> {
  await harness.cloud.signUp(EMAIL, ACCOUNT_PASSWORD);
}

interface Rendered {
  openUrl: jest.Mock<Promise<boolean>, [string]>;
  stop: () => void;
  rerender: () => Promise<void>;
}

async function renderPlans(
  harness: BillingHarness,
  options: { opens?: boolean; onBack?: () => void } = {},
): Promise<Rendered> {
  const openUrl = jest.fn<Promise<boolean>, [string]>(async () => options.opens ?? true);
  const stop = await startEntitlements(harness.services);
  const element = (): React.JSX.Element => (
    <PlansScreen
      openUrl={openUrl}
      {...(options.onBack === undefined ? {} : { onBack: options.onBack })}
    />
  );
  const rendered = await renderWithServices(harness.services, element());
  return {
    openUrl,
    stop,
    rerender: async () => {
      await rerenderWithServices(rendered, harness.services, element);
    },
  };
}

describe('PlansScreen in a build that cannot sell', () => {
  it('says purchases are not available here and offers no button', async () => {
    const { services } = buildOfflineHarness();
    await services.entitlements.load();
    await renderWithServices(services, <PlansScreen />);

    expect(screen.getByTestId('plans_unavailable')).toHaveTextContent(
      /not available in this build/i,
    );
    expect(screen.getByTestId('plans_unavailable')).toHaveTextContent(/every feature is unlocked/i);
    expect(screen.queryByTestId('plans_buy_pro')).toBeNull();
    expect(screen.queryByTestId('plans_subscribe_cloud')).toBeNull();
    expect(screen.queryByTestId('plans_sign_in')).toBeNull();
  });
});

describe('PlansScreen', () => {
  it('shows both products with the exact copy from the brief', async () => {
    const harness = buildBillingHarness();
    const { stop } = await renderPlans(harness);

    const pro = screen.getByTestId('plans_product_pro');
    expect(pro).toHaveTextContent('SilentSum Pro', { exact: false });
    expect(pro).toHaveTextContent('₱299', { exact: false });
    expect(pro).toHaveTextContent(PRODUCTS.pro.tagline, { exact: false });
    expect(pro).toHaveTextContent('End-to-end encrypted messaging', { exact: false });

    const cloud = screen.getByTestId('plans_product_cloud');
    expect(cloud).toHaveTextContent('SilentSum Cloud', { exact: false });
    expect(cloud).toHaveTextContent('₱99/month', { exact: false });
    expect(cloud).toHaveTextContent(PRODUCTS.cloud.tagline, { exact: false });
    // The two plans must not claim each other's features.
    // Every band's price and size has to be on the screen before anyone is asked to buy one.
    expect(cloud).toHaveTextContent('You pay for what you store', { exact: false });
    for (const band of CLOUD_BANDS) {
      expect(cloud).toHaveTextContent(`₱${String(band.pricePhp)} up to ${band.label}`, {
        exact: false,
      });
    }
    expect(pro).not.toHaveTextContent('You pay for what you store', { exact: false });
    expect(cloud).not.toHaveTextContent('End-to-end encrypted messaging', { exact: false });

    // The dollar reads as the price now, but the peso is what PayMongo is told and what
    // `apply.ts` checks, so it must never leave the screen.
    expect(pro).toHaveTextContent('US$4.76 one-time', { exact: false });
    expect(pro).toHaveTextContent('about PH ₱299', { exact: false });
    expect(cloud).toHaveTextContent('US$1.58/month', { exact: false });
    expect(cloud).toHaveTextContent('about PH ₱99/month', { exact: false });
    expect(screen.getByTestId('plans_pro_price_php')).toBeTruthy();
    expect(screen.getByTestId('plans_cloud_price_php')).toBeTruthy();
    stop();
  });

  // Video is a free-tier feature now, so selling it here would be selling something the user
  /**
   * The screen used to contradict itself: a bullet reading "A subscription: renewed monthly,
   * for as long as you want it" sat directly above a line reading "Nothing is charged
   * automatically". Cloud has never auto-renewed -- `CLOUD_TERM_DAYS` of access is bought one
   * payment at a time -- so the bullet was simply false, and no test looked at it.
   *
   * This fails the day the copy claims automatic renewal again. If Cloud ever DOES become a
   * PayMongo subscription, this test is the right place to find out that the copy has to change
   * with it, rather than a customer finding out from their card statement.
   */
  it('never claims Cloud renews on its own, because it does not', async () => {
    const harness = buildBillingHarness();
    const { stop } = await renderPlans(harness);

    const cloud = screen.getByTestId('plans_product_cloud');
    expect(cloud).toHaveTextContent(/nothing renews on its own/i);
    expect(cloud).toHaveTextContent(/nothing is charged automatically/i);
    expect(cloud).not.toHaveTextContent(/renewed monthly/i);
    expect(cloud).not.toHaveTextContent(/automatically renew/i);
    stop();
  });

  // already has. What Cloud actually removes is the 50-item limit.
  it('does not sell video, which the free vault already has', async () => {
    const harness = buildBillingHarness();
    const { stop } = await renderPlans(harness);

    const features = screen.getByTestId('plans_cloud_features');
    expect(features).not.toHaveTextContent(/video alongside/i);
    // What Cloud removes is the 50-item limit, and what it puts there instead is a real number.
    // "Unlimited" is gone on purpose: it was the promise the cost problem was made of.
    expect(features).toHaveTextContent(/the 50-item limit is lifted/i);
    expect(features).not.toHaveTextContent(/unlimited/i);
    expect(PRODUCTS.cloud.tagline).not.toMatch(/video/i);
    expect(PRODUCTS.cloud.tagline).not.toMatch(/unlimited/i);
    stop();
  });

  it('asks for the backup account before it will sell anything', async () => {
    const harness = buildBillingHarness();
    const { stop } = await renderPlans(harness);

    expect(screen.getByTestId('plans_sign_in')).toBeTruthy();
    expect(screen.getByTestId('plans_sign_up')).toBeTruthy();
    expect(screen.queryByTestId('plans_buy_pro')).toBeNull();
    expect(screen.queryByTestId('plans_subscribe_cloud')).toBeNull();
    expect(screen.getByText(/separate credential from your vault PIN/)).toBeTruthy();

    await fireEvent.changeText(screen.getByTestId('plans_email'), EMAIL);
    await fireEvent.changeText(screen.getByTestId('plans_password'), ACCOUNT_PASSWORD);
    await fireEvent.press(screen.getByTestId('plans_sign_up'));

    await waitFor(() => {
      expect(screen.getByTestId('plans_buy_pro')).toBeTruthy();
    });
    expect(screen.getByTestId('plans_status_pro')).toHaveTextContent('Pro: not purchased');
    expect(screen.getByTestId('plans_status_cloud')).toHaveTextContent('Cloud: not subscribed');
    expect(screen.getByTestId('plans_account_row')).toHaveTextContent(EMAIL, { exact: false });
    stop();
  });

  it('refuses an empty credential without calling anyone', async () => {
    const harness = buildBillingHarness();
    const signIn = jest.spyOn(harness.cloud, 'signIn');
    const { stop } = await renderPlans(harness);

    await fireEvent.press(screen.getByTestId('plans_sign_in'));
    expect(screen.getByTestId('plans_error')).toHaveTextContent(/email address/i);
    expect(signIn).not.toHaveBeenCalled();
    stop();
  });

  it('buys Pro: opens the hosted page, waits, and reflects the confirmed payment', async () => {
    const harness = buildBillingHarness();
    await signIn(harness);
    const { openUrl, stop } = await renderPlans(harness);

    await fireEvent.press(screen.getByTestId('plans_buy_pro'));

    await waitFor(() => {
      expect(openUrl).toHaveBeenCalledTimes(1);
    });
    const [checkoutId, checkout] = [...harness.billing.checkouts.entries()][0] ?? [];
    expect(checkout?.product).toBe('pro');
    expect(openUrl).toHaveBeenCalledWith(`https://checkout.paymongo.test/${String(checkoutId)}`);
    expect(screen.getByTestId('plans_waiting')).toHaveTextContent(/waiting for PayMongo/i);
    expect(screen.queryByTestId('plans_buy_pro')).toBeNull();

    harness.billing.completePayment(String(checkoutId));

    await waitFor(() => {
      expect(screen.getByTestId('plans_status_pro')).toHaveTextContent(/Pro: active since/);
    });
    expect(screen.queryByTestId('plans_waiting')).toBeNull();
    expect(screen.getByTestId('plans_status')).toHaveTextContent(/SilentSum Pro is now active/);
    expect(screen.queryByTestId('plans_buy_pro')).toBeNull();
    expect(screen.getByTestId('plans_pro_owned')).toHaveTextContent(/Purchased/);
    // Buying Pro says nothing about Cloud.
    expect(screen.getByTestId('plans_status_cloud')).toHaveTextContent('Cloud: not subscribed');
    expect(screen.getByTestId('plans_subscribe_cloud')).toBeTruthy();
    stop();
  });

  it('subscribes to Cloud, shows the paid-until date, and renews on top of it', async () => {
    const harness = buildBillingHarness();
    // The one-off term path: what every deployment does today, because PayMongo has not enabled
    // Subscriptions on the merchant account. The screen falls back to it, and must keep working.
    harness.billing.subscriptionsSupported = false;
    await signIn(harness);
    const { rerender, stop } = await renderPlans(harness);

    await fireEvent.press(screen.getByTestId('plans_subscribe_cloud'));
    await waitFor(() => {
      expect(screen.getByTestId('plans_waiting')).toBeTruthy();
    });
    const first = [...harness.billing.checkouts.keys()][0] ?? '';
    harness.billing.completePayment(first);

    await waitFor(() => {
      expect(screen.getByTestId('plans_status_cloud')).toHaveTextContent(/Cloud: active until/);
    });
    expect(screen.getByTestId('plans_status')).toHaveTextContent(/SilentSum Cloud is active until/);
    expect(screen.queryByTestId('plans_subscribe_cloud')).toBeNull();
    expect(screen.getByTestId('plans_cancel_cloud')).toBeTruthy();
    // Freshly paid, with a month to run: there is nothing useful to do but stop it, so Renew
    // is not on screen at all.
    expect(screen.queryByTestId('plans_renew_cloud')).toBeNull();
    // Subscribing says nothing about Pro.
    expect(screen.getByTestId('plans_status_pro')).toHaveTextContent('Pro: not purchased');

    // Near the end of the term it comes back, because this is the point the status line starts
    // saying "renew soon" and the user has to be able to act on that.
    harness.clock.advance(25 * DAY);
    await rerender();
    expect(screen.getByTestId('plans_status_cloud')).toHaveTextContent(/renew soon/);
    await fireEvent.press(screen.getByTestId('plans_renew_cloud'));
    await waitFor(() => {
      expect(harness.billing.checkouts.size).toBe(2);
    });
    const second = [...harness.billing.checkouts.keys()][1] ?? '';
    harness.billing.completePayment(second);
    await waitFor(() => {
      expect(screen.queryByTestId('plans_waiting')).toBeNull();
    });
    // The second payment stacked on top of the first rather than restarting it: 5 days were
    // left, and 30 more were added.
    expect(harness.services.entitlements.cloudState()).toMatchObject({
      kind: 'active',
      daysLeft: 35,
    });
    stop();
  });

  it('cancels Cloud only after confirmation, and keeps access to the end of the period', async () => {
    const harness = buildBillingHarness();
    await signIn(harness);
    harness.billing.completePayment((await harness.billing.createCheckout('cloud')).checkoutId);
    const cancel = jest.spyOn(harness.billing, 'cancelCloud');
    const { stop } = await renderPlans(harness);

    await fireEvent.press(screen.getByTestId('plans_cancel_cloud'));
    expect(cancel).not.toHaveBeenCalled();
    expect(screen.getByTestId('plans_cancel_confirm')).toHaveTextContent(/until/);
    await fireEvent.press(screen.getByTestId('plans_cancel_confirm-cancel'));
    expect(cancel).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByTestId('plans_cancel_cloud'));
    await fireEvent.press(screen.getByTestId('plans_cancel_confirm-confirm'));

    await waitFor(() => {
      expect(cancel).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId('plans_status_cloud')).toHaveTextContent(/cancelled/);
    });
    expect(screen.getByTestId('plans_status_cloud')).toHaveTextContent(/Cloud: active until/);
    expect(screen.queryByTestId('plans_cancel_cloud')).toBeNull();
    expect(harness.services.entitlements.isCloudActive()).toBe(true);
    stop();
  });

  it('reports an expired term and offers to subscribe again', async () => {
    const harness = buildBillingHarness();
    await signIn(harness);
    harness.billing.completePayment((await harness.billing.createCheckout('cloud')).checkoutId);
    const { rerender, stop } = await renderPlans(harness);
    expect(screen.getByTestId('plans_status_cloud')).toHaveTextContent(/Cloud: active until/);

    harness.clock.advance(31 * DAY);
    await rerender();

    expect(screen.getByTestId('plans_status_cloud')).toHaveTextContent(/Cloud: expired on/);
    expect(screen.getByTestId('plans_subscribe_cloud')).toBeTruthy();
    expect(screen.queryByTestId('plans_cancel_cloud')).toBeNull();
    stop();
  });

  it('flags the renewal window', async () => {
    const harness = buildBillingHarness();
    await signIn(harness);
    harness.billing.completePayment((await harness.billing.createCheckout('cloud')).checkoutId);
    harness.clock.advance(25 * DAY);
    const { stop } = await renderPlans(harness);
    expect(screen.getByTestId('plans_status_cloud')).toHaveTextContent(/renew soon/);
    stop();
  });

  it('explains a refused purchase in plain words', async () => {
    const harness = buildBillingHarness();
    await signIn(harness);
    jest
      .spyOn(harness.billing, 'createCheckout')
      .mockRejectedValueOnce(new BillingError('already-owned'));
    const { openUrl, stop } = await renderPlans(harness);

    await fireEvent.press(screen.getByTestId('plans_buy_pro'));

    await waitFor(() => {
      expect(screen.getByTestId('plans_error')).toHaveTextContent(/already own SilentSum Pro/);
    });
    expect(openUrl).not.toHaveBeenCalled();
    expect(screen.queryByTestId('plans_waiting')).toBeNull();
    stop();
  });

  it.each([
    ['unavailable', /connection/i],
    ['app-check', /genuine/i],
    ['internal', /could not start the payment/i],
  ] as const)('has copy for a %s failure', async (code, expected) => {
    const harness = buildBillingHarness();
    await signIn(harness);
    jest
      .spyOn(harness.billing, 'startCloudSubscription')
      .mockRejectedValueOnce(new BillingError(code));
    const { stop } = await renderPlans(harness);
    await fireEvent.press(screen.getByTestId('plans_subscribe_cloud'));
    await waitFor(() => {
      expect(screen.getByTestId('plans_error')).toHaveTextContent(expected);
    });
    stop();
  });

  it('starts a monthly subscription, then hides Renew because it renews itself', async () => {
    const harness = buildBillingHarness();
    harness.billing.storedBytes = 10 * 1024 * 1024 * 1024;
    await signIn(harness);
    const { openUrl, stop } = await renderPlans(harness);

    await fireEvent.press(screen.getByTestId('plans_subscribe_cloud'));
    await waitFor(() => {
      expect(screen.getByTestId('plans_waiting')).toBeTruthy();
    });
    // No one-off session was created, and the band that was measured is what is quoted.
    expect(harness.billing.checkouts.size).toBe(0);
    expect(harness.billing.subscriptions.size).toBe(1);
    expect(screen.getByTestId('plans_status')).toHaveTextContent(/₱99 a month for up to 64 GB/);
    expect(openUrl).toHaveBeenCalledWith(expect.stringContaining('https://'));
    // There is no checkout session to reconcile, so the fallback button says what it can do.
    expect(screen.getByTestId('plans_i_paid')).toHaveTextContent('Check again');

    const subscriptionId = [...harness.billing.subscriptions.keys()][0] ?? '';
    harness.billing.completeSubscription(subscriptionId);

    await waitFor(() => {
      expect(screen.getByTestId('plans_status_cloud')).toHaveTextContent(/Cloud: active until/);
    });
    // No Renew button at all while the provider is charging on its own. The bullet is where the
    // screen says so; a permanently inert button said the same thing and took a primary slot.
    expect(screen.queryByTestId('plans_renew_cloud')).toBeNull();
    expect(screen.getByTestId('plans_cancel_cloud')).toBeTruthy();
    expect(screen.getByTestId('plans_cloud_features')).toHaveTextContent(
      /Renewed automatically every 30 days until you cancel/,
    );
    stop();
  });

  it('brings Renew back the moment the subscription is cancelled', async () => {
    const harness = buildBillingHarness();
    await signIn(harness);
    const { stop } = await renderPlans(harness);
    await fireEvent.press(screen.getByTestId('plans_subscribe_cloud'));
    await waitFor(() => {
      expect(harness.billing.subscriptions.size).toBe(1);
    });
    harness.billing.completeSubscription([...harness.billing.subscriptions.keys()][0] ?? '');
    await waitFor(() => {
      expect(screen.getByTestId('plans_cancel_cloud')).toBeTruthy();
    });
    expect(screen.queryByTestId('plans_renew_cloud')).toBeNull();

    await fireEvent.press(screen.getByTestId('plans_cancel_cloud'));
    await fireEvent.press(screen.getByTestId('plans_cancel_confirm-confirm'));

    await waitFor(() => {
      expect(screen.getByTestId('plans_renew_cloud')).toBeTruthy();
    });
    // It appears AND it leads somewhere: a cancelled subscriber can subscribe again. Cancel is
    // gone, because there is nothing left to cancel.
    expect(screen.getByTestId('plans_renew_cloud')).toHaveTextContent('Renew');
    expect(screen.queryByTestId('plans_cancel_cloud')).toBeNull();
    expect(screen.getByTestId('plans_cloud_features')).toHaveTextContent(/nothing renews on its own/);
    await fireEvent.press(screen.getByTestId('plans_renew_cloud'));
    await waitFor(() => {
      expect(harness.billing.subscriptions.size).toBe(2);
    });
    stop();
  });

  it('falls back to a one-off term where the backend cannot take a subscription', async () => {
    // PayMongo enables Subscriptions per merchant account. A build that only knew how to
    // subscribe would make Cloud unbuyable against every backend that exists today.
    const harness = buildBillingHarness();
    harness.billing.subscriptionsSupported = false;
    await signIn(harness);
    const { stop } = await renderPlans(harness);

    await fireEvent.press(screen.getByTestId('plans_subscribe_cloud'));

    await waitFor(() => {
      expect(harness.billing.checkouts.size).toBe(1);
    });
    expect(harness.billing.subscriptions.size).toBe(0);
    expect(screen.queryByTestId('plans_error')).toBeNull();
    // And it is a one-off, so the screen keeps promising a one-off.
    expect(screen.getByTestId('plans_i_paid')).toHaveTextContent('I have paid');
    stop();
  });

  it('refuses to start a second subscription on an account that already renews', async () => {
    const harness = buildBillingHarness();
    await signIn(harness);
    const { stop } = await renderPlans(harness);
    await fireEvent.press(screen.getByTestId('plans_subscribe_cloud'));
    await waitFor(() => {
      expect(harness.billing.subscriptions.size).toBe(1);
    });
    harness.billing.completeSubscription([...harness.billing.subscriptions.keys()][0] ?? '');
    await waitFor(() => {
      expect(screen.queryByTestId('plans_renew_cloud')).toBeNull();
    });

    await expect(harness.billing.startCloudSubscription()).rejects.toMatchObject({
      code: 'already-subscribed',
    });
    stop();
  });

  it.each([
    [10 * 1024 * 1024 * 1024, /₱99 a month for up to 64 GB/],
    [100 * 1024 * 1024 * 1024, /₱249 a month for up to 160 GB/],
    [300 * 1024 * 1024 * 1024, /₱799 a month for up to 512 GB/],
  ])('quotes the band the SERVER measured for %p bytes', async (bytes, expected) => {
    // The price is never computed on this side. The screen repeats what the backend measured,
    // which is the only figure PayMongo will actually be told.
    const harness = buildBillingHarness();
    harness.billing.storedBytes = bytes;
    await signIn(harness);
    const { stop } = await renderPlans(harness);

    await fireEvent.press(screen.getByTestId('plans_subscribe_cloud'));

    await waitFor(() => {
      expect(screen.getByTestId('plans_status')).toHaveTextContent(expected);
    });
    stop();
  });

  it('shows the address when the browser cannot be opened', async () => {
    const harness = buildBillingHarness();
    await signIn(harness);
    const { stop } = await renderPlans(harness, { opens: false });

    await fireEvent.press(screen.getByTestId('plans_buy_pro'));

    await waitFor(() => {
      expect(screen.getByTestId('plans_checkout_url')).toHaveTextContent(
        /https:\/\/checkout\.paymongo\.test\//,
      );
    });
    expect(screen.getByTestId('plans_waiting')).toBeTruthy();
    stop();
  });

  it('"I have paid" asks the backend, and says so when PayMongo has not confirmed yet', async () => {
    const harness = buildBillingHarness();
    await signIn(harness);
    const { stop } = await renderPlans(harness);
    await fireEvent.press(screen.getByTestId('plans_buy_pro'));
    await waitFor(() => {
      expect(screen.getByTestId('plans_i_paid')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('plans_i_paid'));
    await waitFor(() => {
      expect(screen.getByTestId('plans_status')).toHaveTextContent(
        /not confirmed the payment yet/i,
      );
    });
    expect(screen.getByTestId('plans_waiting')).toBeTruthy();

    const id = [...harness.billing.checkouts.keys()][0] ?? '';
    harness.billing.failPayment(id);
    await fireEvent.press(screen.getByTestId('plans_i_paid'));
    await waitFor(() => {
      expect(screen.getByTestId('plans_error')).toHaveTextContent(/did not go through/i);
    });
    expect(screen.queryByTestId('plans_waiting')).toBeNull();
    expect(screen.getByTestId('plans_buy_pro')).toBeTruthy();
    stop();
  });

  it('stops waiting on request and offers the button again', async () => {
    const harness = buildBillingHarness();
    await signIn(harness);
    const { stop } = await renderPlans(harness);
    await fireEvent.press(screen.getByTestId('plans_subscribe_cloud'));
    await waitFor(() => {
      expect(screen.getByTestId('plans_stop_waiting')).toBeTruthy();
    });

    await fireEvent.press(screen.getByTestId('plans_stop_waiting'));

    expect(screen.queryByTestId('plans_waiting')).toBeNull();
    expect(screen.getByTestId('plans_subscribe_cloud')).toBeTruthy();
    stop();
  });

  it('re-reads the entitlements on request and signs out', async () => {
    const harness = buildBillingHarness();
    await signIn(harness);
    const refresh = jest.spyOn(harness.services.entitlements, 'refresh');
    const { stop } = await renderPlans(harness);

    await fireEvent.press(screen.getByTestId('plans_refresh'));
    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(1);
    });

    await fireEvent.press(screen.getByTestId('plans_sign_out'));
    await waitFor(() => {
      expect(screen.getByTestId('plans_sign_in')).toBeTruthy();
    });
    expect(harness.cloud.currentUser).toBeNull();
    stop();
  });

  it('keeps saying Pro is active on a device that is signed out, from the cache', async () => {
    const harness = buildBillingHarness();
    await signIn(harness);
    harness.billing.completePayment((await harness.billing.createCheckout('pro')).checkoutId);
    const stop = await startEntitlements(harness.services);
    await harness.services.entitlements.flush();
    await harness.cloud.signOut();
    stop();

    await renderWithServices(harness.services, <PlansScreen />);
    expect(screen.getByTestId('plans_status_pro')).toHaveTextContent(/Pro: active since/);
    expect(screen.getByTestId('plans_sign_in')).toBeTruthy();
  });

  it('wires the back affordance', async () => {
    const harness = buildBillingHarness();
    const onBack = jest.fn();
    const { stop } = await renderPlans(harness, { onBack });
    await fireEvent.press(screen.getByTestId('screen-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
    stop();
  });
});

/**
 * Paying means leaving the app for a browser. If the vault auto-locks during that, the plans
 * screen is unmounted with the rest of the vault stack and the "I have paid" fallback goes with
 * it -- which is exactly how a real payment ends up with no entitlement and nothing to press.
 */
describe('auto-lock while paying', () => {
  it('holds auto-lock off for a pending checkout and lets go when the payment lands', async () => {
    const harness = buildBillingHarness();
    await signIn(harness);
    const { stop } = await renderPlans(harness);
    const suspension = harness.services.autoLockSuspension;
    expect(suspension.isSuspended).toBe(false);

    await fireEvent.press(screen.getByTestId('plans_buy_pro'));
    await waitFor(() => {
      expect(screen.getByTestId('plans_waiting')).toBeTruthy();
    });
    expect(suspension.isSuspended).toBe(true);

    const checkoutId = [...harness.billing.checkouts.keys()][0] ?? '';
    harness.billing.completePayment(String(checkoutId));

    await waitFor(() => {
      expect(screen.queryByTestId('plans_waiting')).toBeNull();
    });
    expect(suspension.isSuspended).toBe(false);
    stop();
  });

  it('lets go when the payment is abandoned', async () => {
    const harness = buildBillingHarness();
    await signIn(harness);
    const { stop } = await renderPlans(harness);

    await fireEvent.press(screen.getByTestId('plans_buy_pro'));
    await waitFor(() => {
      expect(screen.getByTestId('plans_stop_waiting')).toBeTruthy();
    });
    expect(harness.services.autoLockSuspension.isSuspended).toBe(true);

    await fireEvent.press(screen.getByTestId('plans_stop_waiting'));
    await waitFor(() => {
      expect(screen.queryByTestId('plans_waiting')).toBeNull();
    });
    expect(harness.services.autoLockSuspension.isSuspended).toBe(false);
    stop();
  });

  it('lets go when the screen closes with a checkout still pending', async () => {
    const harness = buildBillingHarness();
    await signIn(harness);
    const rendered = await renderPlans(harness);

    await fireEvent.press(screen.getByTestId('plans_buy_pro'));
    await waitFor(() => {
      expect(screen.getByTestId('plans_waiting')).toBeTruthy();
    });
    expect(harness.services.autoLockSuspension.isSuspended).toBe(true);

    await act(async () => {
      screen.unmount();
    });
    expect(harness.services.autoLockSuspension.isSuspended).toBe(false);
    rendered.stop();
  });
});
