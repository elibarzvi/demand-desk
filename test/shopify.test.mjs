// Fixtures for the Shopify store capture.
//
// The expensive failure here is not a crash, it is a crawl that stops early and
// still looks like a valid catalogue. Diffing a half-fetched catalogue against
// yesterday records every unfetched page as a departure, which is how the
// 2026-08-10 Fashionphile capture poisoned the baselines for weeks. Most of what
// follows pins that, and the brand normalisation that stops one house splitting
// into two histories.
import assert from 'node:assert/strict';
import { crawlCollection, captureStore, toItems, summarise, normaliseBrand, handlesFor, plausibleBrands } from '../src/lib/shopify.mjs';

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

// An empty collection must be reported, not silently treated as "not carried".
// A 200 with no products looks identical to a store that does not stock the
// brand, and on 2026-10-13 CI got exactly that for brands holding hundreds of
// items. Losing a brand quietly is how its absence later reads as a sellout.
const blank = await captureStore(store, ['Hermès', 'Chanel'], {
  fetchImpl: async (url) => url.includes('/collections/hermes/')
    ? { ok: true, status: 200, json: async () => ({ products: [] }) }
    : server(1)(url),
  delay: 0
});
assert.deepEqual(blank.empty, ['Hermès'], 'an empty collection must be named');
assert.ok(!blank.failed.length, 'but it is not a crawl failure');
assert.ok(blank.brands['Chanel'], 'and the other brands still report');

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

// --- the collapse guard --------------------------------------------------
//
// The real-world case: on 2026-10-13 a capture eight minutes after a healthy one
// returned myGemma Hermès and Louis Vuitton as empty, while both collections
// plainly held 127 and 151 available items. With prior state in place that would
// have booked every missing SKU as a sale.

const skus = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [`s${i}`, { p: 100 }]));
const prev = { 'Hermès': skus(170), 'Louis Vuitton': skus(369), 'Chanel': skus(366) };

// Healthy day: everything within reach of yesterday, nothing held back.
{
  const { diffable, suspect } = plausibleBrands(
    [{ brand: 'Hermès', live: 168 }, { brand: 'Louis Vuitton', live: 372 }, { brand: 'Chanel', live: 366 }], prev);
  assert.equal(diffable.length, 3);
  assert.deepEqual(suspect, [], 'ordinary movement must not be held back');
}

// The actual incident: two brands absent entirely. They never reach `focus`, so
// the filter alone cannot catch them.
{
  const { diffable, suspect } = plausibleBrands([{ brand: 'Chanel', live: 366 }], prev);
  assert.deepEqual(diffable.map(d => d.brand), ['Chanel'], 'only the brand that reported may be diffed');
  assert.equal(suspect.length, 2);
  assert.ok(suspect.some(x => x.startsWith('Hermès: absent')), 'a vanished brand must be named');
  assert.ok(suspect.some(x => x.startsWith('Louis Vuitton: absent')));
}

// A brand that reports a tiny fraction of yesterday is a broken feed, not a
// sellout. 10 against 170 is 6%.
{
  const { diffable, suspect } = plausibleBrands([{ brand: 'Hermès', live: 10 }], prev);
  assert.equal(diffable.length, 0, 'a 94% collapse must not be diffed');
  assert.ok(suspect[0].includes('10 against 170'), 'and must say what it saw');
}

// The boundary is 30%, and it must be inclusive so a real 70% clearance is still
// measured rather than quietly discarded as implausible.
assert.equal(plausibleBrands([{ brand: 'Hermès', live: 51 }], prev).diffable.length, 1, '30% exactly must pass');
assert.equal(plausibleBrands([{ brand: 'Hermès', live: 50 }], prev).diffable.length, 0, 'just under must not');

// A brand with no history cannot be contradicted, so it passes: that is a first
// sighting, not a collapse.
{
  const { diffable, suspect } = plausibleBrands([{ brand: 'Goyard', live: 3 }], {});
  assert.equal(diffable.length, 1);
  assert.deepEqual(suspect, []);
}

// A brand whose stored state is empty must not be reported as vanished.
assert.deepEqual(plausibleBrands([], { 'Rolex': {} }).suspect, [], 'an empty prior brand is not a disappearance');

console.log('[test] shopify: partial-crawl refusal, collapse guard, brand normalisation and flattening passed');
