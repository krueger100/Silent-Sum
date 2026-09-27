import { BILLING_PATHS, entitlementsToJson, FREE_ENTITLEMENTS } from '@/billing/entitlements';
import { EntitlementsController } from '@/billing/entitlementsController';
import { InMemoryCloudBackend } from '@/firebase/cloudBackend';
import { InMemorySecureStore } from '@/secure-storage/secureStore';
import { SUPPORT_CHAT_PATHS } from '@/support/chat/supportChat';
import {
  SupportChatError,
  SupportChatService,
  type SupportChatState,
} from '@/support/chat/supportChatService';
import { FakeClock } from '@/utils/clock';

const DAY = 86_400_000;
const EMAIL = 'owner@example.test';
const PASSWORD = 'account-password';

const RANDOM = {
  bytes: (length: number) => new Uint8Array(length),
  hexId: (() => {
    let n = 0;
    return () => {
      n += 1;
      return `id${String(n).padStart(4, '0')}`;
    };
  })(),
};

interface Rig {
  cloud: InMemoryCloudBackend;
  clock: FakeClock;
  entitlements: EntitlementsController;
  chat: SupportChatService;
}

function build(options: { enforced?: boolean } = {}): Rig {
  const cloud = new InMemoryCloudBackend();
  const clock = new FakeClock();
  const entitlements = new EntitlementsController({
    secureStore: new InMemorySecureStore(),
    clock,
    cloud,
    enforced: options.enforced ?? true,
  });
  const chat = new SupportChatService({ cloud, entitlements, clock, random: RANDOM });
  return { cloud, clock, entitlements, chat };
}

async function signedIn(rig: Rig): Promise<string> {
  const user = await rig.cloud.signUp(EMAIL, PASSWORD);
  return user.uid;
}

function grantCloud(rig: Rig, uid: string, until: number): void {
  rig.cloud.adminPutDocument(
    BILLING_PATHS.entitlements(uid),
    entitlementsToJson({
      ...FREE_ENTITLEMENTS,
      cloud: { ...FREE_ENTITLEMENTS.cloud, status: 'active', accessUntil: until },
    }),
  );
}

/** Support answers with the Admin SDK, exactly as the deployed function does. */
function supportReplies(rig: Rig, uid: string, id: string, body: string, createdAt: number): void {
  rig.cloud.adminPutDocument(SUPPORT_CHAT_PATHS.message(uid, id), {
    v: 1,
    sender: 'support',
    body,
    createdAt,
  });
}

describe('availability and sign-in', () => {
  it('is unavailable without a cloud backend, and says so rather than throwing', async () => {
    const clock = new FakeClock();
    const entitlements = new EntitlementsController({
      secureStore: new InMemorySecureStore(),
      clock,
      cloud: null,
      enforced: false,
    });
    const chat = new SupportChatService({ cloud: null, entitlements, clock, random: RANDOM });
    expect(chat.available).toBe(false);

    const seen: SupportChatState[] = [];
    const stop = chat.watch((state) => seen.push(state));
    expect(seen.at(-1)?.signedIn).toBe(false);
    expect(seen.at(-1)?.canSend).toBe(false);
    await expect(chat.send('hello')).rejects.toBeInstanceOf(SupportChatError);
    stop();
  });

  it('refuses to send while signed out', async () => {
    const rig = build();
    await expect(rig.chat.send('hello')).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

describe('cloud gating', () => {
  it('refuses a new message when the term has lapsed, and allows it once active', async () => {
    const rig = build({ enforced: true });
    const uid = await signedIn(rig);
    await rig.entitlements.refresh();
    expect(rig.chat.canSend()).toBe(false);
    await expect(rig.chat.send('help')).rejects.toMatchObject({ code: 'cloud-required' });

    grantCloud(rig, uid, rig.clock.now() + DAY);
    await rig.entitlements.refresh();
    expect(rig.chat.canSend()).toBe(true);
    await expect(rig.chat.send('help')).resolves.toMatchObject({ sender: 'user', body: 'help' });
  });

  it('stops sending again when the term expires, and the history stays readable', async () => {
    const rig = build({ enforced: true });
    const uid = await signedIn(rig);
    grantCloud(rig, uid, rig.clock.now() + DAY);
    await rig.entitlements.refresh();
    await rig.chat.send('first');

    rig.clock.advance(2 * DAY);
    await rig.entitlements.refresh();
    expect(rig.chat.canSend()).toBe(false);
    await expect(rig.chat.send('second')).rejects.toMatchObject({ code: 'cloud-required' });

    const seen: SupportChatState[] = [];
    const stop = rig.chat.watch((state) => seen.push(state));
    await Promise.resolve();
    expect(seen.at(-1)?.messages.map((m) => m.body)).toEqual(['first']);
    stop();
  });

  it('gates nothing in a build that sells nothing', async () => {
    const rig = build({ enforced: false });
    await signedIn(rig);
    await rig.entitlements.refresh();
    expect(rig.chat.canSend()).toBe(true);
    await expect(rig.chat.send('hello')).resolves.toMatchObject({ body: 'hello' });
  });
});

describe('sending', () => {
  it('refuses text that must never leave the device, before writing anything', async () => {
    const rig = build({ enforced: false });
    const uid = await signedIn(rig);
    await expect(rig.chat.send('my pin is 4821')).rejects.toMatchObject({
      code: 'rejected',
      problem: 'pin',
    });
    const written = [...rig.cloud.documents.keys()].filter((key) =>
      key.startsWith(SUPPORT_CHAT_PATHS.messages(uid)),
    );
    expect(written).toEqual([]);
  });

  it('writes the message under the owner and nowhere else', async () => {
    const rig = build({ enforced: false });
    const uid = await signedIn(rig);
    const message = await rig.chat.send('  the gallery crashes  ');
    expect(message.body).toBe('the gallery crashes');
    const path = SUPPORT_CHAT_PATHS.message(uid, message.id);
    expect(rig.cloud.documents.get(path)).toEqual({
      v: 1,
      sender: 'user',
      body: 'the gallery crashes',
      createdAt: message.createdAt,
    });
  });
});

describe('watching, unread and read state', () => {
  it('delivers both sides in time order and counts what support said', async () => {
    const rig = build({ enforced: false });
    const uid = await signedIn(rig);
    const seen: SupportChatState[] = [];
    const stop = rig.chat.watch((state) => seen.push(state));

    await rig.chat.send('question');
    rig.clock.advance(1000);
    supportReplies(rig, uid, 'r1', 'answer', rig.clock.now());

    const last = seen.at(-1);
    expect(last?.messages.map((m) => [m.sender, m.body])).toEqual([
      ['user', 'question'],
      ['support', 'answer'],
    ]);
    expect(last?.unread).toBe(1);
    stop();
  });

  it('clears unread on markRead and keeps the history', async () => {
    const rig = build({ enforced: false });
    const uid = await signedIn(rig);
    const seen: SupportChatState[] = [];
    const stop = rig.chat.watch((state) => seen.push(state));
    supportReplies(rig, uid, 'r1', 'answer', rig.clock.now());
    expect(seen.at(-1)?.unread).toBe(1);

    rig.clock.advance(50);
    await rig.chat.markRead();
    expect(seen.at(-1)?.unread).toBe(0);
    expect(seen.at(-1)?.messages).toHaveLength(1);
    stop();
  });

  it('stops delivering after unsubscribe', async () => {
    const rig = build({ enforced: false });
    const uid = await signedIn(rig);
    const seen: SupportChatState[] = [];
    const stop = rig.chat.watch((state) => seen.push(state));
    const before = seen.length;
    stop();
    supportReplies(rig, uid, 'r1', 'answer', rig.clock.now());
    expect(seen.length).toBe(before);
  });
});

describe('isolation between accounts', () => {
  it('never reads another account, because the backend refuses the path', async () => {
    const rig = build({ enforced: false });
    const mine = await signedIn(rig);
    rig.cloud.adminPutDocument(SUPPORT_CHAT_PATHS.message('someone-else', 'x'), {
      v: 1,
      sender: 'support',
      body: 'not yours',
      createdAt: 1,
    });

    const seen: SupportChatState[] = [];
    const stop = rig.chat.watch((state) => seen.push(state));
    expect(seen.at(-1)?.messages).toEqual([]);
    stop();

    expect(() =>
      rig.cloud.watchCollection(
        SUPPORT_CHAT_PATHS.messages('someone-else'),
        { orderBy: 'createdAt' },
        () => undefined,
      ),
    ).toThrow();
    expect(mine).not.toBe('someone-else');
  });
});
