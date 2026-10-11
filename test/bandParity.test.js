/**
 * The band table exists twice, and this is the guard that makes that safe.
 *
 * `src/billing/entitlements.ts` is what the app RENDERS. `functions/src/bands.ts` is what the
 * server CHARGES. They are separate npm packages with separate tsconfigs, so neither can import
 * the other; the server copy is authoritative and the client copy is a label. A number that
 * drifts between them means the screen advertises one price and the card is charged another --
 * which is the single worst bug this feature could have, and the one nothing else would catch.
 *
 * Read as text on purpose. Importing the server module from the app's Jest project would drag
 * `firebase-admin` into a React Native transform, and a parity check that is hard to run is a
 * parity check that gets deleted.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CLIENT_FILE = path.join(ROOT, 'src', 'billing', 'entitlements.ts');
const SERVER_FILE = path.join(ROOT, 'functions', 'src', 'bands.ts');

/**
 * Pulls `{ maxBytes: N * GIB, ..., priceCentavos: N, ..., label: 'X' }` out of a CLOUD_BANDS
 * array literal, in source order. Deliberately strict: a table this parser cannot read fails
 * the test rather than silently comparing nothing.
 */
function parseBands(source, file) {
  const start = source.indexOf('CLOUD_BANDS');
  expect(start).toBeGreaterThan(-1);
  const open = source.indexOf('[', start);
  const close = source.indexOf('];', open);
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  const body = source.slice(open + 1, close);

  const bands = [];
  for (const entry of body.split('},')) {
    if (!entry.includes('maxBytes')) continue;
    const gib = /maxBytes:\s*(\d+)\s*\*\s*GIB/.exec(entry);
    const centavos = /priceCentavos:\s*(\d+)/.exec(entry);
    const label = /label:\s*'([^']+)'/.exec(entry);
    if (gib === null || centavos === null || label === null) {
      throw new Error(`unparseable band in ${file}: ${entry.trim()}`);
    }
    bands.push({
      gib: Number(gib[1]),
      priceCentavos: Number(centavos[1]),
      label: label[1],
    });
  }
  expect(bands.length).toBeGreaterThan(0);
  return bands;
}

describe('the Cloud band table, in both places', () => {
  const client = parseBands(fs.readFileSync(CLIENT_FILE, 'utf8'), CLIENT_FILE);
  const server = parseBands(fs.readFileSync(SERVER_FILE, 'utf8'), SERVER_FILE);

  it('has the same number of bands on both sides', () => {
    expect(server).toHaveLength(client.length);
  });

  it('agrees on every size, price and label', () => {
    // The whole point: what the screen says and what PayMongo is told are the same numbers.
    expect(server).toEqual(client);
  });

  it('agrees with the peso figures the client renders', () => {
    // `pricePhp` is only on the client side and is what the copy is built from, so it has to
    // match the centavos the server bills.
    const source = fs.readFileSync(CLIENT_FILE, 'utf8');
    const pairs = [...source.matchAll(/pricePhp:\s*(\d+),\s*priceCentavos:\s*(\d+)/g)];
    expect(pairs).toHaveLength(client.length);
    for (const [, php, centavos] of pairs) {
      expect(Number(centavos)).toBe(Number(php) * 100);
    }
  });

  it('catches a drifted table', () => {
    // Proof the comparison is load-bearing rather than vacuous: the same parser, one number
    // changed, must fail. Nothing is written to disk.
    const drifted = fs
      .readFileSync(SERVER_FILE, 'utf8')
      .replace('priceCentavos: 24900', 'priceCentavos: 19900');
    expect(parseBands(drifted, 'drifted')).not.toEqual(client);
  });

  it('catches a band being dropped', () => {
    const shortened = fs
      .readFileSync(SERVER_FILE, 'utf8')
      .replace(/\{ maxBytes: 512 \* GIB[^}]*\},?\n/, '');
    expect(parseBands(shortened, 'shortened')).toHaveLength(client.length - 1);
  });
});
