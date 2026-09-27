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

export const PRODUCT_IDS: readonly ProductId[] = ['pro', 'cloud'];

/** One Cloud payment buys this many days, counted from the later of "now" and the current end. */
export const CLOUD_TERM_DAYS = 30;

/** "Renew" is offered from this many days before Cloud lapses. */
export const CLOUD_RENEWAL_WINDOW_DAYS = 7;

export const PLANS_TITLE = 'SilentSum Pro and Cloud';
