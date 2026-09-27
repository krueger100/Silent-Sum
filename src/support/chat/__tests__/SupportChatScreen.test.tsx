/**
 * The support chat screen against the real composition root, with the in-memory cloud backend
 * standing in for Firestore and the entitlement document written the way the webhook writes it.
 */
import React from 'react';
import { fireEvent, screen } from '@testing-library/react-native';

import { BILLING_PATHS, FREE_ENTITLEMENTS, entitlementsToJson } from '@/billing/entitlements';
import {
  ACCOUNT_PASSWORD,
  EMAIL,
  buildBillingHarness,
  buildOfflineHarness,
  renderWithServices,
} from '@/billing/screens/__tests__/harness';
import { SUPPORT_CHAT_PATHS } from '@/support/chat/supportChat';
import { SupportChatScreen } from '@/support/chat/SupportChatScreen';

const DAY = 86_400_000;

async function signedInHarness(options: { cloudActive: boolean }) {
  const harness = buildBillingHarness();
  const user = await harness.cloud.signUp(EMAIL, ACCOUNT_PASSWORD);
  if (options.cloudActive) {
    harness.cloud.adminPutDocument(
      BILLING_PATHS.entitlements(user.uid),
      entitlementsToJson({
        ...FREE_ENTITLEMENTS,
        cloud: {
          ...FREE_ENTITLEMENTS.cloud,
          status: 'active',
          accessUntil: harness.clock.now() + DAY,
        },
      }),
    );
  }
  await harness.services.entitlements.refresh();
  return { ...harness, uid: user.uid };
}

describe('SupportChatScreen', () => {
  it('says so in a build with no cloud backend', async () => {
    const { services } = buildOfflineHarness();
    await renderWithServices(services, <SupportChatScreen />);
    expect(screen.getByTestId('support_chat_unavailable')).toBeTruthy();
  });

  it('asks a signed-out user to sign in first', async () => {
    const harness = buildBillingHarness();
    await renderWithServices(harness.services, <SupportChatScreen />);
    expect(screen.getByTestId('support_chat_signed_out')).toBeTruthy();
  });

  it('shows the composer and sends a message on an active Cloud term', async () => {
    const harness = await signedInHarness({ cloudActive: true });
    await renderWithServices(harness.services, <SupportChatScreen />);

    expect(screen.getByTestId('support_chat_empty')).toBeTruthy();
    await fireEvent.changeText(screen.getByTestId('support_chat_input'), 'the gallery crashes');
    await fireEvent.press(screen.getByTestId('support_chat_send'));

    expect(screen.getByTestId('support_chat_messages')).toBeTruthy();
    expect(screen.getByText('the gallery crashes')).toBeTruthy();
    expect(screen.queryByTestId('support_chat_error')).toBeNull();
  });

  it('refuses to send a PIN and shows why, without writing anything', async () => {
    const harness = await signedInHarness({ cloudActive: true });
    await renderWithServices(harness.services, <SupportChatScreen />);

    await fireEvent.changeText(screen.getByTestId('support_chat_input'), 'my pin is 4821');
    await fireEvent.press(screen.getByTestId('support_chat_send'));

    expect(screen.getByTestId('support_chat_error')).toHaveTextContent(/never send your pin/i);
    const written = [...harness.cloud.documents.keys()].filter((key) =>
      key.startsWith(SUPPORT_CHAT_PATHS.messages(harness.uid)),
    );
    expect(written).toEqual([]);
  });

  it('offers plans instead of a composer when the Cloud term has lapsed', async () => {
    const harness = await signedInHarness({ cloudActive: false });
    const onPlans = jest.fn();
    await renderWithServices(harness.services, <SupportChatScreen onPlans={onPlans} />);

    expect(screen.getByTestId('support_chat_cloud_required')).toBeTruthy();
    expect(screen.queryByTestId('support_chat_input')).toBeNull();
    await fireEvent.press(screen.getByTestId('support_chat_plans'));
    expect(onPlans).toHaveBeenCalledTimes(1);
  });

  it('shows what support said even though the term has lapsed', async () => {
    const harness = await signedInHarness({ cloudActive: false });
    harness.cloud.adminPutDocument(SUPPORT_CHAT_PATHS.message(harness.uid, 'r1'), {
      v: 1,
      sender: 'support',
      body: 'we are looking into it',
      createdAt: harness.clock.now(),
    });

    await renderWithServices(harness.services, <SupportChatScreen />);
    expect(screen.getByText('we are looking into it')).toBeTruthy();
    expect(screen.getByTestId('support_chat_cloud_required')).toBeTruthy();
  });
});
