import { priceFor, productFrom, readConfig } from '../config';

describe('readConfig', () => {
  it('has the prices, term and copy from the brief as defaults', () => {
    const config = readConfig({});
    expect(config.proPriceCentavos).toBe(29900);
    expect(config.cloudPriceCentavos).toBe(9900);
    expect(config.cloudTermDays).toBe(30);
    expect(config.currency).toBe('PHP');
    expect(config.paymentMethods).toEqual(['gcash', 'paymaya', 'card', 'grab_pay', 'qrph']);
    expect(config.names).toEqual({ pro: 'SilentSum Pro', cloud: 'SilentSum Cloud' });
    expect(config.taglines).toEqual({
      pro: 'Pay once. Keep Pro forever.',
      cloud: 'Encrypted backup, restore, support chat and cloud services.',
    });
    expect(config.returnUrl).toBeNull();
    expect(config.enforceAppCheck).toBe(true);
    expect(config.livemode).toBe(false);
    expect(config.region).toBe('us-central1');
  });

  it('reads overrides from the environment', () => {
    const config = readConfig({
      SILENTSUM_PRO_PRICE_CENTAVOS: '39900',
      SILENTSUM_CLOUD_PRICE_CENTAVOS: '12900',
      SILENTSUM_CLOUD_TERM_DAYS: '31',
      SILENTSUM_PAYMENT_METHODS: ' gcash , card ',
      SILENTSUM_BILLING_RETURN_URL: 'https://example.test/return',
      SILENTSUM_ENFORCE_APP_CHECK: 'false',
      PAYMONGO_LIVEMODE: 'true',
      SILENTSUM_REGION: 'asia-southeast1',
    });
    expect(config.proPriceCentavos).toBe(39900);
    expect(config.cloudPriceCentavos).toBe(12900);
    expect(config.cloudTermDays).toBe(31);
    expect(config.paymentMethods).toEqual(['gcash', 'card']);
    expect(config.returnUrl).toBe('https://example.test/return');
    expect(config.enforceAppCheck).toBe(false);
    expect(config.livemode).toBe(true);
    expect(config.region).toBe('asia-southeast1');
  });

  it('falls back to the defaults for values it cannot use', () => {
    const config = readConfig({
      SILENTSUM_PRO_PRICE_CENTAVOS: 'free',
      SILENTSUM_CLOUD_PRICE_CENTAVOS: '-5',
      SILENTSUM_CLOUD_TERM_DAYS: '0',
      SILENTSUM_PAYMENT_METHODS: ' , ',
      SILENTSUM_BILLING_RETURN_URL: 'http://plain.example/return',
    });
    expect(config.proPriceCentavos).toBe(29900);
    expect(config.cloudPriceCentavos).toBe(9900);
    expect(config.cloudTermDays).toBe(30);
    expect(config.paymentMethods).toEqual(['gcash', 'paymaya', 'card', 'grab_pay', 'qrph']);
    expect(config.returnUrl).toBeNull();
  });

  it('infers live mode from the secret key when the environment does not say', () => {
    expect(readConfig({}, 'sk_live_abc').livemode).toBe(true);
    expect(readConfig({}, 'sk_test_abc').livemode).toBe(false);
    expect(readConfig({ PAYMONGO_LIVEMODE: 'false' }, 'sk_live_abc').livemode).toBe(false);
  });
});

describe('products', () => {
  it('accepts only the two product ids', () => {
    expect(productFrom('pro')).toBe('pro');
    expect(productFrom('cloud')).toBe('cloud');
    expect(productFrom('PRO')).toBeNull();
    expect(productFrom(1)).toBeNull();
    expect(productFrom(undefined)).toBeNull();
  });

  it('prices each product from the server config', () => {
    const config = readConfig({ SILENTSUM_CLOUD_PRICE_CENTAVOS: '12900' });
    expect(priceFor(config, 'pro')).toBe(29900);
    expect(priceFor(config, 'cloud')).toBe(12900);
  });
});
