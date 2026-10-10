/**
 * The two things SilentSum sells, and the words the brief chose for them.
 *
 * Prices here are DISPLAY values. The amount actually charged is set by the backend
 * (`functions/src/config.ts`), which is the only place PayMongo ever hears a number from; the
 * webhook also checks the paid amount against that server-side price before granting anything.
 * A tampered client can therefore change what the screen says, and nothing else.
 */
export type ProductId = 'pro' | 'cloud';

export interface Product {
  readonly id: ProductId;
  readonly name: string;
  /** The price line, exactly as the brief words it. */
  readonly price: string;
  /** What the server charges, in centavos; shown nowhere, kept here so the copy and the number agree. */
  readonly priceCentavos: number;
  readonly tagline: string;
  readonly kind: 'one-time' | 'monthly';
}

export const PRODUCTS: Readonly<Record<ProductId, Product>> = {
  pro: {
    id: 'pro',
    name: 'SilentSum Pro',
    price: '₱299 one-time',
    priceCentavos: 29900,
    tagline: 'Private messaging with other SilentSum users. Pay once, keep it forever.',
    kind: 'one-time',
  },
  cloud: {
    id: 'cloud',
    name: 'SilentSum Cloud',
    price: '₱99/month',
    priceCentavos: 9900,
    tagline: 'An unlimited vault and encrypted cloud backup.',
    kind: 'monthly',
  },
};

/**
 * Mid-market PHP->USD, 2026-10-10. A HINT FOR READERS, never a price.
 *
 * The peso is what is charged, all the way down: `functions/src/config.ts` sets
 * `currency: 'PHP'`, PayMongo is told pesos, and `functions/src/apply.ts` refuses to grant
 * anything unless the currency it was PAID in matches. So this number can never decide what
 * leaves someone's card -- it exists only so a reader who does not think in pesos knows roughly
 * what they are agreeing to before they tap.
 *
 * Hardcoded on purpose. Fetching a live rate would put a network call on the one screen a
 * privacy-first app should be quietest on, to move a figure by a few cents. The cost is that it
 * goes stale, which is why everything built from it is marked approximate and why the real
 * currency stays first and larger on screen.
 *
 * **Revisit when it drifts far enough to mislead** -- a cent or two is noise, a tenth of the
 * price is not. It was 62.8 pesos to the dollar on the day this was written.
 */
export const USD_PER_PHP = 0.01592;

/**
 * The headline price line: "US$4.76 one-time", "US$1.58/month".
 *
 * Derived from `priceCentavos` rather than written out beside each price, so the two cannot
 * drift apart -- the failure where someone edits one number and the screen quietly advertises a
 * discount nobody agreed to. The term rides on this line because this is the line being read as
 * the price; "US$1.58" with the "/month" somewhere else reads as a one-off.
 */
export function usdPrice(product: Product): string {
  const amount = ((product.priceCentavos / 100) * USD_PER_PHP).toFixed(2);
  return product.kind === 'monthly' ? `US$${amount}/month` : `US$${amount} one-time`;
}

/**
 * The peso underneath: "about PH ₱299", "about PH ₱99/month".
 *
 * Said in full, with the country, because this is the currency that actually leaves the card and
 * a reader seeing dollars above needs to know what their statement will say.
 *
 * NOTE THE TENSION, since it is not obvious from the screen: the peso is the EXACT charge and
 * the dollar above it is the estimate, yet "about" sits on this line. That is the requested
 * wording. If the rate ever drifts far enough for the dollar headline to be visibly wrong, this
 * is the pair to revisit -- the firm number is the one down here.
 */
export function pesoNote(product: Product): string {
  const amount = `₱${product.priceCentavos / 100}`;
  return product.kind === 'monthly' ? `about PH ${amount}/month` : `about PH ${amount}`;
}

export const PRODUCT_IDS: readonly ProductId[] = ['pro', 'cloud'];

/** One Cloud payment buys this many days, counted from the later of "now" and the current end. */
export const CLOUD_TERM_DAYS = 30;

/** "Renew" is offered from this many days before Cloud lapses. */
export const CLOUD_RENEWAL_WINDOW_DAYS = 7;

export const PLANS_TITLE = 'SilentSum Pro and Cloud';
