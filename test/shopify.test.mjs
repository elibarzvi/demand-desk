// Fixtures for the Shopify store capture.
//
// The expensive failure here is not a crash, it is a crawl that stops early and
// still looks like a valid catalogue. Diffing a half-fetched catalogue against
// yesterday records every unfetched page as a departure, which is how the
// 2026-08-10 Fashionphile capture poisoned the baselines for weeks. Most of what
// follows pins that, and the brand normalisation that stops one house splitting
// into two histories.
import assert from 'node:assert/strict';
import { crawlCollection, captureStore, toItems, summarise, normaliseBrand, handlesFor } from '../src/lib/shopify.mjs';

const store = { id: 'test', label: 'Test', base: 'https://example.test' };

// A fake Shopify that serves `pages` pages then an empty one, failing at
// `failAt` if asked to.
const VENDOR_FOR = { hermes: 'Hermes', chanel: 'Chanel', dior: 'Dior', 'christian-dior': 'Dior' };
const server = (pages, { failAt = null, perPage = 2 } = {}) => async (url) => {
  const page = Number(new URL(url).searchParams.get('page'));
  if (failAt && page === failAt) return { ok: false, status: 503, json: async () => ({}) };
  // Vendor follows the collection, as a real store's does.
  const handle = url.match(/\/collections\/([^/]+)\//)?.[1] ?? 'hermes';
  const products = page > pages ? [] : Array.from({ length: perPage }, (_, i) => ({
    id: page * 100 + i,
    title: `Bag ${page}-${i}`,
    vendor: VENDOR_FOR[handle] ?? 'Hermes',
    handle: `bag-${page}-${i}`,
    product_type: 'Top handle',
    published_at: '2026-01-01T00:00:00-05:00',
    variants: [{ sku: `S${page}-${i}`, price: '1000.00', available: true }]
  }));
  return { ok: true, status: 200, json: async () => ({ products }) };
};

// --- the partial-crawl guard ----------------------------------------------

const full = await crawlCollection(store, 'hermes', { fetchImpl: server(3), delay: 0 });
assert.equal(full.complete, true, 'a crawl that reaches an empty page is complete');
assert.equal(full.products.length, 6);

// Mid-crawl HTTP failure: products were collected, but the catalogue is partial.
const broke = await crawlCollection(store, 'hermes', { fetchImpl: server(5, { failAt: 3 }), delay: 0 });
assert.equal(broke.complete, false, 'a failed page must leave the crawl incomplete');
assert.ok(broke.products.length > 0, 'and it will still be holding partial products');
assert.ok(broke.error, 'with the reason recorded');

// Hitting the page cap is also not an ending.
const capped = await crawlCollection(store, 'hermes', { fetchImpl: server(99), maxPages: 2, delay: 0 });
assert.equal(capped.complete, false, 'hitting the page cap is not a complete catalogue');

// captureStore is the gate. A brand whose collection cannot be crawled to the
// end must be dropped rather than diffed, because a half-fetched brand looks
// exactly like that brand selling out. Crucially the OTHER brands still report:
// one bad collection should cost one brand, not the whole store.
const mixed = await captureStore(store, ['Hermès', 'Chanel'], {
  fetchImpl: async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    const failing = url.includes('/collections/hermes/');
    if (failing && page === 2) return { ok: false, status: 503, json: async () => ({}) };
    return server(1)(url);
  },
  delay: 0
});
assert.equal(mixed.status, 'partial', 'a failed brand must mark the capture partial');
assert.ok(mixed.failed.some(f => f.startsWith('Hermès')), 'and name the brand that failed');
assert.ok(!mixed.brands['Hermès'], 'the partial brand must be absent, never half-reported');
assert.ok(mixed.brands['Chanel'], 'the healthy brand must still report');

// Dior is the one house these stores disagree on: myGemma uses `dior`, Rebag
// `christian-dior`. Aliases are tried in order until one carries stock.
assert.deepEqual(handlesFor('Dior'), ['dior', 'christian-dior']);
assert.deepEqual(handlesFor('Bottega Veneta'), ['bottega-veneta']);
assert.deepEqual(handlesFor('Hermès'), ['hermes'], 'accents must not reach a URL');

const ok = await captureStore(store, ['Hermès'], { fetchImpl: server(2), delay: 0 });
assert.equal(ok.status, 'ok');
assert.equal(ok.live, 4);
assert.equal(ok.skus.length, 4, 'live SKUs must be carried for the diff');

// --- brand normalisation ---------------------------------------------------

// Rebag writes "Hermes", Fashionphile "Hermès". Splitting those is a brand whose
// history quietly becomes two half-histories.
assert.equal(normaliseBrand('Hermes'), 'Hermès');
assert.equal(normaliseBrand('HERMÈS'), 'Hermès');
assert.equal(normaliseBrand('  hermes  '), 'Hermès');
assert.equal(normaliseBrand('Christian Dior'), 'Dior');
assert.equal(normaliseBrand('YSL'), 'Saint Laurent');
assert.equal(normaliseBrand('Tiffany & Co.'), 'Tiffany & Co.');
assert.equal(normaliseBrand('tiffany and co'), 'Tiffany & Co.');
// An unknown house passes through rather than being dropped or guessed at.
assert.equal(normaliseBrand('Some New Label'), 'Some New Label');
assert.equal(normaliseBrand(''), null);
assert.equal(normaliseBrand(null), null);

// --- item flattening -------------------------------------------------------

const items = toItems([{
  title: 'Birkin', vendor: 'Hermes', handle: 'h', product_type: 'Top handle',
  published_at: '2026-03-04T10:00:00-05:00',
  variants: [
    { sku: 'A', price: '6060.00', available: false },   // gone, but still an item
    { sku: 'B', price: '0', available: true },          // no price, not an item
    { sku: '', price: '500', available: true },         // no sku, cannot be tracked
    { sku: 'C', price: '500.00', available: true }
  ]
}]);
assert.deepEqual(items.map(i => i.sku), ['A', 'C'], 'only priced, identifiable variants');
assert.equal(items[0].brand, 'Hermès', 'brand normalised on the way in');
assert.equal(items[0].listed, '2026-03-04', 'listing date kept as a plain day');
assert.equal(items[0].available, false);

// The price distribution describes what is buyable, so sold stock is excluded.
const s = summarise(items);
assert.equal(s['Hermès'].live, 1, 'unavailable items must not enter the distribution');
assert.equal(s['Hermès'].price.median, 500);

console.log('[test] shopify: partial-crawl refusal, brand normalisation and flattening passed');
