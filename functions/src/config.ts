/**
 * Everything the backend can be told through the environment, with the brief's numbers and
 * words as defaults. Prices live HERE and nowhere else: the app shows them, PayMongo is told
 * them, and the webhook checks paid amounts against them.
 *
 * Secrets (the PayMongo secret key and webhook secret) are NOT read here. They come from
 * Firebase Secret Manager through `index.ts`; only the key's prefix is consulted, to know whether
 * this deployment is live or test.
 */
import type { ProductId } from './store';

export interface BillingConfig {
  readonly proPriceCentavos: number;
  readonly cloudPriceCentavos: number;
  readonly cloudTermDays: number;
  readonly currency: string;
  readonly paymentMethods: readonly string[];
  readonly names: Readonly<Record<ProductId, string>>;
  readonly taglines: Readonly<Record<ProductId, string>>;
  /** An https base for the return page; null means the deployed return function is used. */
  readonly returnUrl: string | null;
  /**
   * Who support mail is from and where it goes. The relay reads these and nothing else: a `to` in a
   * request body is discarded, which is what keeps a public endpoint from being an open mail relay.
   * Null means this deployment does not relay support mail, and the endpoint refuses every request.
   */
  readonly support: { readonly from: string; readonly to: string } | null;
  readonly enforceAppCheck: boolean;
  /** Which PayMongo mode this deployment accepts events from. */
  readonly livemode: boolean;
  readonly region: string;
}

export const DEFAULT_PAYMENT_METHODS: readonly string[] = [
  'gcash',
  'paymaya',
  'card',
  'grab_pay',
  'qrph',
];

export const PRODUCT_NAMES: Readonly<Record<ProductId, string>> = {
  pro: 'SilentSum Pro',
  cloud: 'SilentSum Cloud',
};

export const PRODUCT_TAGLINES: Readonly<Record<ProductId, string>> = {
  pro: 'Pay once. Keep Pro forever.',
  cloud: 'Encrypted backup, restore, support chat and cloud services.',
};

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const n = Number(trimmed);
  return n > 0 ? n : fallback;
}

function flag(value: string | undefined): boolean | null {
  if (value === undefined) return null;
  const v = value.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

export function readConfig(
  env: Readonly<Record<string, string | undefined>>,
  secretKey?: string,
): BillingConfig {
  const methods = (env.SILENTSUM_PAYMENT_METHODS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const returnUrl = env.SILENTSUM_BILLING_RETURN_URL?.trim() ?? '';
  const region = env.SILENTSUM_REGION?.trim() ?? '';
  const supportFrom = env.SILENTSUM_SUPPORT_FROM?.trim() ?? '';
  const supportTo = env.SILENTSUM_SUPPORT_TO?.trim() ?? '';
  return {
    proPriceCentavos: positiveInteger(env.SILENTSUM_PRO_PRICE_CENTAVOS, 29900),
    cloudPriceCentavos: positiveInteger(env.SILENTSUM_CLOUD_PRICE_CENTAVOS, 9900),
    cloudTermDays: positiveInteger(env.SILENTSUM_CLOUD_TERM_DAYS, 30),
    currency: 'PHP',
    paymentMethods: methods.length === 0 ? DEFAULT_PAYMENT_METHODS : methods,
    names: PRODUCT_NAMES,
    taglines: PRODUCT_TAGLINES,
    returnUrl: /^https:\/\/[^/?#\s]+/i.test(returnUrl) ? returnUrl : null,
    // Both or neither: a from with no to, or the reverse, cannot send anything, and a half-set
    // deployment should say "not configured" rather than fail on every message.
    support: supportFrom === '' || supportTo === '' ? null : { from: supportFrom, to: supportTo },
    enforceAppCheck: flag(env.SILENTSUM_ENFORCE_APP_CHECK) !== false,
    livemode: flag(env.PAYMONGO_LIVEMODE) ?? (secretKey ?? '').startsWith('sk_live_'),
    region: region === '' ? 'us-central1' : region,
  };
}

export function productFrom(value: unknown): ProductId | null {
  return value === 'pro' || value === 'cloud' ? value : null;
}

export function priceFor(config: BillingConfig, product: ProductId): number {
  return product === 'pro' ? config.proPriceCentavos : config.cloudPriceCentavos;
}
