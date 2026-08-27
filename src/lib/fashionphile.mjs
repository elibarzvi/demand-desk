// Fashionphile capture via its public Algolia search index (search-only key).
//
// Why this shape: the old capture asked for a single hit off the price-ascending
// index, so "low price" was literally the cheapest object a brand sells (Chanel's
// $95 cosmetic pouch). That is not a resale price signal. Instead we:
//
//  1. Pull the `price` facet as a histogram. Algolia returns every distinct price
//     with its count, and the counts sum exactly to nbHits, so the percentiles
//     below are computed over the ENTIRE live inventory, not a sample.
//  2. Restrict each brand to one coherent segment (handbags for the bag houses,
//     fine jewelry for Cartier) so we are not averaging keychains into bag prices.
//  3. Collect every live SKU so the day-over-day diff yields real sell-through.
//     A query can only reach 5000 hits, so we split the population into price
//     bands using the histogram we already have, which is exact and complete.
const APP = 'NSJAZ0QG7K';
const KEY = 'e545a3cf82cf7dbc5ff39f49c214863e';
const INDEX = 'shopify_products_price_asc';
const PAGE = 1000;      // Algolia max hitsPerPage
const BAND_MAX = 4500;  // stay under the 5000-hit ceiling per query

// Each brand is captured as ONE comparable segment. `vendor` is Fashionphile's
// own spelling; `facet`/`values` isolate the category. Cartier sells no handbags,
// so it is tracked as fine jewelry (369 of its 457 live pieces) rather than a
// meaningless blend of rings and watches.
export const SEGMENTS = [
  { brand: 'Hermès',        vendor: 'Hermes',         label: 'Handbags', facet: 'meta.custom.filters_bags', values: ['Handbags'] },
  { brand: 'Chanel',        vendor: 'Chanel',         label: 'Handbags', facet: 'meta.custom.filters_bags', values: ['Handbags'] },
  { brand: 'Louis Vuitton', vendor: 'Louis Vuitton',  label: 'Handbags', facet: 'meta.custom.filters_bags', values: ['Handbags'] },
  { brand: 'Goyard',        vendor: 'Goyard',         label: 'Handbags', facet: 'meta.custom.filters_bags', values: ['Handbags'] },
  { brand: 'Dior',          vendor: 'Christian Dior', label: 'Handbags', facet: 'meta.custom.filters_bags', values: ['Handbags'] },
  { brand: 'Fendi',         vendor: 'Fendi',          label: 'Handbags', facet: 'meta.custom.filters_bags', values: ['Handbags'] },
  { brand: 'The Row',       vendor: 'The Row',        label: 'Handbags', facet: 'meta.custom.filters_bags', values: ['Handbags'] },
  { brand: 'Cartier',       vendor: 'Cartier',        label: 'Fine jewelry', facet: 'meta.custom.filters_jewelry', values: ['Rings', 'Bracelets', 'Necklaces', 'Earrings'] }
];

async function algolia(params) {
  const r = await fetch(`https://${APP}-dsn.algolia.net/1/indexes/${INDEX}/query`, {
    method: 'POST',
    headers: { 'X-Algolia-Application-Id': APP, 'X-Algolia-API-Key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ params })
  });
  if (!r.ok) throw new Error(`Algolia HTTP ${r.status}`);
  const j = await r.json();
  if (j.message) throw new Error(`Algolia: ${j.message}`);
  return j;
}

function facetFilters(seg) {
  // Inner arrays are ANDed, values within one array are ORed.
  return [[`vendor:${seg.vendor}`], seg.values.map(v => `${seg.facet}:${v}`)];
}

// Exact percentiles straight off the price histogram. `pairs` is [price, count]
// sorted ascending; we walk the cumulative count to the requested quantile.
export function percentiles(pairs, total) {
  const at = p => {
    const target = total * p;
    let cum = 0;
    for (const [price, n] of pairs) { cum += n; if (cum >= target) return price; }
    return pairs.length ? pairs[pairs.length - 1][0] : null;
  };
  return { p10: at(0.10), p25: at(0.25), median: at(0.50), p75: at(0.75), p90: at(0.90) };
}

// Split the price range into contiguous bands each holding < BAND_MAX items, so
// every band can be paged to completion under Algolia's 5000-hit ceiling.
// Bands are half-open [lo, hi): a band closes at the NEXT distinct price above
// the one that tipped it over, so the tipping price stays inside the band it
// filled and no item falls between two bands.
export function priceBands(pairs) {
  const bands = [];
  let lo = null, count = 0;
  for (let i = 0; i < pairs.length; i++) {
    const [price, n] = pairs[i];
    if (lo === null) lo = price;
    count += n;
    const next = pairs[i + 1];
    if (count >= BAND_MAX && next) { bands.push({ lo, hi: next[0] }); lo = null; count = 0; }
  }
  if (lo !== null) bands.push({ lo, hi: null });   // open-ended final band
  return bands.length ? bands : [{ lo: null, hi: null }];
}

async function fetchBandSkus(seg, band) {
  const ff = encodeURIComponent(JSON.stringify(facetFilters(seg)));
  const attrs = encodeURIComponent(JSON.stringify(['sku', 'price', 'published_at']));
  const parts = ['inventory_available=1'];
  if (band.lo != null) parts.push(`price>=${band.lo}`);
  if (band.hi != null) parts.push(`price<${band.hi}`);   // hi is exclusive; next band picks it up
  const filters = encodeURIComponent(parts.join(' AND '));
  const out = [];
  for (let page = 0; ; page++) {
    const j = await algolia(`query=&hitsPerPage=${PAGE}&page=${page}&attributesToRetrieve=${attrs}&facetFilters=${ff}&filters=${filters}`);
    for (const h of j.hits || []) {
      if (h.sku == null) continue;
      out.push({ sku: String(h.sku), price: h.price ?? null, listed: (h.published_at || '').slice(0, 10) || null });
    }
    if (page + 1 >= (j.nbPages || 0)) break;
  }
  return out;
}

// One brand: exact price distribution + condition mix + every live SKU.
export async function captureSegment(seg) {
  const ff = encodeURIComponent(JSON.stringify(facetFilters(seg)));
  const facets = encodeURIComponent(JSON.stringify(['price', 'meta.custom.condition']));
  // `liveAll` is the all-category vendor count the original capture recorded. The
  // segment count below is a different population, so keeping both means the
  // existing listing-count history stays continuous instead of stepping the day
  // the segment filter was introduced.
  const allFf = encodeURIComponent(JSON.stringify([[`vendor:${seg.vendor}`]]));
  const [head, all] = await Promise.all([
    algolia(`query=&hitsPerPage=0&facets=${facets}&maxValuesPerFacet=1000&facetFilters=${ff}&filters=${encodeURIComponent('inventory_available=1')}`),
    algolia(`query=&hitsPerPage=0&facetFilters=${allFf}&filters=${encodeURIComponent('inventory_available=1')}`)
  ]);

  const hist = head.facets?.price || {};
  const pairs = Object.entries(hist).map(([p, n]) => [Number(p), n]).sort((a, b) => a[0] - b[0]);
  const histTotal = pairs.reduce((a, p) => a + p[1], 0);
  const live = head.nbHits ?? 0;

  // The histogram caps at 1000 distinct prices. Every brand currently fits, but
  // if one ever overflows the percentiles would silently skew, so flag it.
  const exact = histTotal === live;

  const stats = pairs.length ? percentiles(pairs, histTotal) : { p10: null, p25: null, median: null, p75: null, p90: null };
  const sum = pairs.reduce((a, [p, n]) => a + p * n, 0);

  // Under the ceiling one unfiltered sweep is enough; above it we must band, or
  // Algolia would stop at 5000 hits and quietly under-report the live set.
  const bands = live > BAND_MAX ? priceBands(pairs) : [{ lo: null, hi: null }];
  const collected = [];
  for (const band of bands) collected.push(...await fetchBandSkus(seg, band));

  // Bands are half-open and disjoint, but de-dupe defensively: a double-counted
  // SKU would corrupt the sell-through diff downstream.
  const seen = new Set();
  const skus = collected.filter(s => (seen.has(s.sku) ? false : (seen.add(s.sku), true)));

  return {
    brand: seg.brand,
    segment: seg.label,
    live,
    liveAll: all.nbHits ?? null,
    exactHistogram: exact,
    price: {
      ...stats,
      min: pairs.length ? pairs[0][0] : null,
      max: pairs.length ? pairs[pairs.length - 1][0] : null,
      mean: histTotal ? Math.round(sum / histTotal) : null
    },
    condition: head.facets?.['meta.custom.condition'] || {},
    skus
  };
}
