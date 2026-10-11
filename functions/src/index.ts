/**
 * The SilentSum billing functions (codebase `silentsum` in the root `firebase.json`).
 *
 * Eleven functions, deployed to one region:
 *   silentsumCreateCheckout   callable  -> a hosted PayMongo checkout page for Pro or Cloud
 *   silentsumSyncCheckout     callable  -> reconcile one checkout with PayMongo ("I have paid")
 *   silentsumStartCloudSubscription
 *                             callable  -> a monthly PayMongo subscription for Cloud
 *   silentsumCancelCloud      callable  -> stop Cloud from renewing
 *   silentsumPaymongoWebhook  https     -> PayMongo's signed events
 *   silentsumBillingReturn    https     -> the page the browser lands on after checkout
 *   silentsumSupportReply     callable  -> an operator answers one user (custom claim required)
 *   silentsumSupportRelay     https     -> the app's support form -> one fixed inbox, rate limited
 *   silentsumFindUser         callable  -> one exact e-mail -> one account id (Pro, rate limited)
 *   silentsumPeerEmail        callable  -> one account id -> its e-mail, for a correspondent only
 *   silentsumDeleteConversation
 *                             callable  -> erase one conversation and its media, both sides
 *
 * The PayMongo secret key, the webhook secret and the Resend API key come from Firebase Secret
 * Manager (`firebase functions:secrets:set PAYMONGO_SECRET_KEY` / `PAYMONGO_WEBHOOK_SECRET` /
 * `RESEND_API_KEY`) and are bound only to the functions that need them. Everything else is
 * configuration read from the environment (`functions/.env*`, see `config.ts`).
 *
 * This file is glue: every decision lives in a module with tests. It only maps Firebase's
 * request objects onto those modules and their failures back onto `HttpsError`s.
 */
import { randomUUID } from 'node:crypto';

import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import { logger } from 'firebase-functions';
import { defineSecret } from 'firebase-functions/params';
import {
  HttpsError,
  onCall,
  onRequest,
  type CallableRequest,
  type Request,
} from 'firebase-functions/v2/https';

import { cancelCloud } from './cancel';
import { createCheckout } from './checkout';
import { rerateCloudSubscription, startCloudSubscription } from './subscription';
import { CloudStorageMeter } from './storageMeter';
import { deleteConversation } from './conversations';
import { readConfig, type BillingConfig } from './config';
import { findPeerEmail, findUserByEmail } from './directory';
import { BillingFailure } from './errors';
import { FirestoreDirectoryStore } from './firestoreDirectoryStore';
import { FirestoreConversationStore } from './firestoreConversationStore';
import { FirestoreBillingStore } from './firestoreStore';
import { FirestoreSupportRelayCounters, FirestoreSupportStore } from './firestoreSupportStore';
import { PayMongoClient } from './paymongo/client';
import { ResendMailer } from './resendClient';
import { renderReturnPage } from './returnPage';
import { replyToUser } from './support';
import { relaySupport } from './supportRelay';
import { syncCheckout } from './sync';
import { handleWebhook } from './webhook';

const PAYMONGO_SECRET_KEY = defineSecret('PAYMONGO_SECRET_KEY');
const PAYMONGO_WEBHOOK_SECRET = defineSecret('PAYMONGO_WEBHOOK_SECRET');
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');

/** Static options are read once, at load: region and whether callables demand App Check. */
const STATIC = readConfig(process.env);

setGlobalOptions({ region: STATIC.region, maxInstances: 10 });

if (getApps().length === 0) initializeApp();

function projectId(): string {
  const fromEnv = process.env.GCLOUD_PROJECT;
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
  try {
    const parsed = JSON.parse(process.env.FIREBASE_CONFIG ?? '{}') as { projectId?: unknown };
    return typeof parsed.projectId === 'string' ? parsed.projectId : '';
  } catch {
    return '';
  }
}

function returnUrlFor(config: BillingConfig): (outcome: 'success' | 'cancel') => string {
  const base =
    config.returnUrl ??
    `https://${config.region}-${projectId()}.cloudfunctions.net/silentsumBillingReturn`;
  return (outcome) => `${base}?outcome=${outcome}`;
}

function backend(secretKey: string) {
  const config = readConfig(process.env, secretKey);
  return {
    store: new FirestoreBillingStore(getFirestore()),
    paymongo: new PayMongoClient(secretKey),
    config,
    now: () => Date.now(),
  };
}

/**
 * The extra dependencies a SUBSCRIPTION needs over a one-off checkout: a storage meter, because
 * the price follows what is stored, and the account's e-mail, because PayMongo requires one on
 * a customer. The e-mail comes from Firebase Auth rather than from the request -- a caller must
 * not be able to put somebody else's address on a customer record.
 */
function subscriptionBackend(secretKey: string) {
  const deps = backend(secretKey);
  return {
    ...deps,
    meter: new CloudStorageMeter(deps.config.storageBucket),
    returnUrl: returnUrlFor(deps.config),
    accountEmail: async (uid: string) => {
      try {
        return (await getAuth().getUser(uid)).email ?? null;
      } catch {
        return null;
      }
    },
  };
}

function requireUid(request: CallableRequest<unknown>): string {
  const uid = request.auth?.uid;
  if (typeof uid !== 'string' || uid === '') {
    throw new HttpsError('unauthenticated', 'Sign in to your backup account first.');
  }
  return uid;
}

/**
 * The caller's address, for rate-limit bucketing only.
 *
 * Behind Cloud Run the peer address arrives in `X-Forwarded-For`, and Express's `request.ip` is the
 * front end unless the app trusts the proxy. The leftmost forwarded entry is the closest thing to a
 * client address available -- and a caller can set that header, which is exactly why the relay
 * bounds the TOTAL per window as well and treats this as a hint rather than an identity.
 */
function callerAddress(request: Request): string {
  const forwarded = request.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  if (first !== undefined && first !== '') return first;
  return request.ip ?? '';
}

function field(data: unknown, name: string): unknown {
  return typeof data === 'object' && data !== null
    ? (data as Record<string, unknown>)[name]
    : undefined;
}

function toHttpsError(error: unknown, where: string): HttpsError {
  if (error instanceof HttpsError) return error;
  if (error instanceof BillingFailure) {
    return new HttpsError(error.code, error.message, error.details);
  }
  logger.error(`${where} failed`, { error: String(error) });
  return new HttpsError('internal', 'The billing service could not complete that request.');
}

/**
 * `invoker: 'public'` is the Cloud Run IAM binding, not an application permission. It is the
 * default for HTTPS functions, and callables cannot work without it: the Firebase client sends
 * its ID and App Check tokens in the request, so the request must be allowed to arrive before
 * `enforceAppCheck` and `requireUid` below can judge it. Declaring it here (rather than relying
 * on the default) means the binding is re-applied on every deploy, not only on the first one.
 */
const callableOptions = {
  secrets: [PAYMONGO_SECRET_KEY],
  enforceAppCheck: STATIC.enforceAppCheck,
  invoker: 'public' as const,
};

export const silentsumCreateCheckout = onCall(callableOptions, async (request) => {
  const uid = requireUid(request);
  const deps = backend(PAYMONGO_SECRET_KEY.value());
  try {
    return await createCheckout(
      { ...deps, newRef: () => randomUUID(), returnUrl: returnUrlFor(deps.config) },
      { uid, product: field(request.data, 'product') },
    );
  } catch (error) {
    throw toHttpsError(error, 'createCheckout');
  }
});

export const silentsumSyncCheckout = onCall(callableOptions, async (request) => {
  const uid = requireUid(request);
  const deps = backend(PAYMONGO_SECRET_KEY.value());
  try {
    const outcome = await syncCheckout(deps, {
      uid,
      checkoutId: field(request.data, 'checkoutId'),
    });
    return { outcome };
  } catch (error) {
    throw toHttpsError(error, 'syncCheckout');
  }
});

/**
 * Start a native PayMongo subscription for Cloud: the thing that makes "renews automatically"
 * true. The answer carries a page to authorise on; nothing is charged until the customer does.
 *
 * The request body is ignored entirely. There is nothing for a caller to choose: the band comes
 * from measured storage and the price from the band.
 */
export const silentsumStartCloudSubscription = onCall(callableOptions, async (request) => {
  const uid = requireUid(request);
  try {
    return await startCloudSubscription(subscriptionBackend(PAYMONGO_SECRET_KEY.value()), { uid });
  } catch (error) {
    throw toHttpsError(error, 'startCloudSubscription');
  }
});

export const silentsumCancelCloud = onCall(callableOptions, async (request) => {
  const uid = requireUid(request);
  const deps = backend(PAYMONGO_SECRET_KEY.value());
  try {
    return await cancelCloud(deps, { uid });
  } catch (error) {
    throw toHttpsError(error, 'cancelCloud');
  }
});

export const silentsumPaymongoWebhook = onRequest(
  // PayMongo calls this unauthenticated; the signature check below is the gate.
  { secrets: [PAYMONGO_SECRET_KEY, PAYMONGO_WEBHOOK_SECRET], invoker: 'public' },
  async (request, response) => {
    if (request.method !== 'POST') {
      response.status(405).send('method not allowed');
      return;
    }
    const secretKey = PAYMONGO_SECRET_KEY.value();
    const subscriptions = subscriptionBackend(secretKey);
    const result = await handleWebhook(
      {
        store: subscriptions.store,
        config: subscriptions.config,
        webhookSecret: PAYMONGO_WEBHOOK_SECRET.value(),
        now: () => Date.now(),
        log: (message, data) => {
          logger.info(message, data);
        },
        rerate: (input) => rerateCloudSubscription(subscriptions, input),
      },
      {
        rawBody: request.rawBody ?? Buffer.from(''),
        signatureHeader: request.get('paymongo-signature'),
      },
    );
    response.status(result.status).json(result.body);
  },
);

/**
 * A support operator answering one user.
 *
 * Gated on the `silentsumSupport` custom claim, which only an operator with the Admin SDK can set
 * -- there is no self-service path to it. App Check is enforced exactly as it is for the purchase
 * callables, and the PayMongo secret is deliberately NOT bound here: answering a message has no
 * business holding a payment key.
 */
/**
 * Who to start a conversation with. The Pro check and the per-caller budget live in
 * `directory.ts`; this only carries the request across.
 */
export const silentsumFindUser = onCall(
  { invoker: 'public', enforceAppCheck: STATIC.enforceAppCheck },
  async (request) => {
    const callerUid = requireUid(request);
    try {
      return await findUserByEmail(
        {
          store: new FirestoreDirectoryStore(getFirestore(), getAuth()),
          now: () => Date.now(),
        },
        { callerUid, email: field(request.data, 'email') },
      );
    } catch (error) {
      throw toHttpsError(error, 'findUser');
    }
  },
);

/**
 * Who is writing to you. The membership gate and the budget live in `directory.ts`.
 *
 * Deliberately a separate callable rather than a mode of the one above: the two have different
 * gates -- that one needs Pro because starting a conversation does, this one must not, because
 * reading what you were sent never does -- and a single entry point with two policies is how one
 * of them eventually gets applied to the wrong branch.
 */
export const silentsumPeerEmail = onCall(
  { invoker: 'public', enforceAppCheck: STATIC.enforceAppCheck },
  async (request) => {
    const callerUid = requireUid(request);
    try {
      return await findPeerEmail(
        {
          store: new FirestoreDirectoryStore(getFirestore(), getAuth()),
          now: () => Date.now(),
        },
        { callerUid, uid: field(request.data, 'uid') },
      );
    } catch (error) {
      throw toHttpsError(error, 'peerEmail');
    }
  },
);

/**
 * Deleting a whole conversation, for both people.
 *
 * The client cannot do this: the rules refuse to delete a conversation or a message, and no
 * client can delete a subcollection at all. So the permission check that would have been a rule
 * lives in `conversations.ts` and runs before anything is touched -- see that module for why
 * EITHER member is allowed to, and why no placeholder is left behind.
 *
 * App Check is enforced exactly as it is for the purchase callables. The PayMongo secret is
 * deliberately NOT bound: ending a conversation has no business holding a payment key.
 */
export const silentsumDeleteConversation = onCall(
  { invoker: 'public', enforceAppCheck: STATIC.enforceAppCheck },
  async (request) => {
    const callerUid = requireUid(request);
    try {
      return await deleteConversation(
        {
          store: new FirestoreConversationStore(getFirestore(), STATIC.storageBucket),
          log: (message, data) => {
            logger.info(message, data);
          },
        },
        { callerUid, conversationId: field(request.data, 'conversationId') },
      );
    } catch (error) {
      throw toHttpsError(error, 'deleteConversation');
    }
  },
);

export const silentsumSupportReply = onCall(
  { invoker: 'public', enforceAppCheck: STATIC.enforceAppCheck },
  async (request) => {
    const callerUid = requireUid(request);
    try {
      return await replyToUser(
        {
          store: new FirestoreSupportStore(getFirestore(), getAuth()),
          now: () => Date.now(),
          newId: () => `m_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
        },
        {
          callerUid,
          isSupport: request.auth?.token.silentsumSupport === true,
          uid: field(request.data, 'uid'),
          body: field(request.data, 'body'),
        },
      );
    } catch (error) {
      throw toHttpsError(error, 'supportReply');
    }
  },
);

/**
 * The support relay: the app's customer-service form, with the mail provider's key held here.
 *
 * Unauthenticated on purpose. It is reachable to a user who is locked out of the vault -- the one
 * who most needs to write in -- and the vault has no account such a user could sign in with. What
 * makes that safe is that it can send to exactly one address, the one this deployment is configured
 * with: see supportRelay.ts. Read `request.ip` rather than trusting it; the module treats the
 * caller's address as a hint and bounds the total regardless.
 */
export const silentsumSupportRelay = onRequest(
  { invoker: 'public', secrets: [RESEND_API_KEY] },
  async (request, response) => {
    response.set('Cache-Control', 'no-store');
    const support = STATIC.support;
    if (support === null) {
      // 403 rather than 503: a deployment with no support addresses is not temporarily unwell, it
      // will never send anything. The app maps 4xx-refused to "this build cannot send support
      // messages, sending again will not help", which is exactly right; a 5xx would tell the user
      // to try later, forever.
      response.status(403).json({ error: 'Support mail is not configured for this deployment.' });
      return;
    }
    const result = await relaySupport(
      {
        mailer: new ResendMailer(RESEND_API_KEY.value()),
        counters: new FirestoreSupportRelayCounters(getFirestore()),
        config: support,
        now: () => Date.now(),
        onFailure: (error) => {
          logger.error('supportRelay delivery failed', { error: String(error) });
        },
      },
      {
        method: request.method,
        contentType: request.get('content-type') ?? null,
        body: request.body,
        // Cloud Run puts the peer address in X-Forwarded-For, which a caller can also set. Taken as
        // a best-effort bucket key, never as an identity.
        clientId: callerAddress(request),
      },
    );
    // `Allow` is required on a 405 and costs nothing; it also makes the refusal self-explanatory to
    // whoever is poking at the URL.
    if (result.status === 405) response.set('Allow', 'POST');
    response.status(result.status).json(result.body);
  },
);

// The browser lands here straight from PayMongo's hosted page, so it carries no credentials.
export const silentsumBillingReturn = onRequest({ invoker: 'public' }, (request, response) => {
  response.set('Cache-Control', 'no-store');
  response.set('Content-Type', 'text/html; charset=utf-8');
  const outcome = request.query.outcome;
  response.status(200).send(renderReturnPage(typeof outcome === 'string' ? outcome : undefined));
});
