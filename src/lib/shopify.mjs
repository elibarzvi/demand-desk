// Capture for resale stores running on Shopify's public products.json feed.
//
// myGemma and Rebag both expose their whole catalogue there, with vendor, sku,
// price, availability and published_at. That is everything Fashionphile's Algolia
// index gives us, which means the same one-of-one logic works: resale stock is a
// single physical object, so a SKU that disappears has left the market, and the
// gap between published_at and that day is its time to sell.
//
// Why a second and third retailer matter more than the extra volume: today every
// clearing number comes from Fashionphile alone, so "this bag is slow" and
// "Fashionphile is slow" are indistinguishable. Two independent feeds separate
// them.
//
// THE DANGEROUS PART is partial crawls. A catalogue is tens of pages, and if the
// crawl stops halfway the result still looks like a valid, smaller catalogue.
// Diffing that against yesterday would record thousands of departures that are
// really unfetched pages, which is precisely how the 2026-08-10 Fashionphile
// capture poisoned the baselines for weeks. So a crawl is only `complete` when it
// has seen a genuinely empty page, and callers must refuse to diff anything else.

const PAGE = 250;          // Shopify's maximum
const MAX_PAGES = 60;      // 15,000 per collection; a brand ending is expected far sooner
const DELAY_MS = 150;      // polite, and well under any sane rate limit

// Shopify stops paginating products.json at page 100 and answers 400 beyond it,
// and since_id is ignored on these storefronts, so a whole catalogue of 25,000+
// is simply not reachable in one sweep. It does not need to be. Crawling one
// brand collection at a time keeps every slice far under the cap, makes
// completeness verifiable per brand instead of per store, and cuts the request
// count to a fraction of a full sweep.

export const STORES = [
  { id: 'mygemma', label: 'myGemma', base: 'https://mygemma.com' },
  { id: 'rebag', label: 'Rebag', base: 'https://shop.rebag.com' }
];

// Collection handles are the brand slugified, with the handful of exceptions the
// stores actually use. Tried in order; the first that returns stock wins.
const HANDLE_ALIASES = { 'Dior': ['dior', 'christian-dior'] };

export function handlesFor(brand) {
  if (HANDLE_ALIASES[brand]) return HANDLE_ALIASES[brand];
  return [String(brand).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')];
}

// Retailers spell the same house differently: Rebag writes "Hermes", Fashionphile
// "Hermès", and a brand that does not normalise is a brand whose history silently
// splits in two. Compared accent- and case-insensitively rather than by a lookup
// table, so a new retailer with another spelling needs no code change.
const CANON = ['Hermès', 'Chanel', 'Louis Vuitton', 'The Row', 'Goyard', 'Dior',
  'Cartier', 'Rolex', 'Prada', 'Bottega Veneta', 'Celine', 'Fendi', 'Gucci',
  'Saint Laurent', 'Van Cleef & Arpels', 'Tiffany & Co.', 'Chrome Hearts'];

const fold = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

const CANON_BY_FOLD = new Map(CANON.map(c => [fold(c), c]));
// "Christian Dior" and "Dior" are one house; so are "YSL" and "Saint Laurent".
const ALIAS = new Map(Object.entries({
  'christian dior': 'Dior', 'ysl': 'Saint Laurent', 'yves saint laurent': 'Saint Laurent',
  'louis vuitton paris': 'Louis Vuitton', 'van cleef arpels': 'Van Cleef & Arpels',
  'tiffany co': 'Tiffany & Co.', 'tiffany and co': 'Tiffany & Co.', 'celine paris': 'Celine'
}));

export function normaliseBrand(vendor) {
  const f = fold(vendor);
  if (!f) return null;
  return CANON_BY_FOLD.get(f) ?? ALIAS.get(f) ?? vendor.trim();
}

async function getJson(url, fetchImpl) {
  const r = await fetchImpl(url, { headers: { 'User-Agent': 'demand-desk/1.0 (+https://github.com/elibarzvi/demand-desk)' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Walk the whole catalogue. Returns { complete, products, pages }. `complete` is
// the only field callers should trust before diffing.
export async function crawlCollection(store, handle, { fetchImpl = fetch, maxPages = MAX_PAGES, delay = DELAY_MS } = {}) {
  const products = [];
  let pages = 0, complete = false, error = null;
  for (let page = 1; page <= maxPages; page++) {
    let batch;
    try {
      batch = (await getJson(`${store.base}/collections/${handle}/products.json?limit=${PAGE}&page=${page}`, fetchImpl)).products;
    } catch (e) {
      error = `page ${page}: ${e.message}`;
      break;                              // partial; `complete` stays false
    }
    pages = page;
    if (!batch || batch.length === 0) { complete = true; break; }
    products.push(...batch);
    if (delay) await sleep(delay);
  }
  return { complete, pages, products, error };
}

// Flatten to one row per sellable variant. Resale variants are one-of-one, so a
// variant is an item; `available: false` means it has gone, which Rebag reports
// directly and is worth keeping rather than discarding.
export function toItems(products) {
  const out = [];
  for (const p of products) {
    const brand = normaliseBrand(p.vendor);
    if (!brand) continue;
    const listed = (p.published_at || p.created_at || '').slice(0, 10) || null;
    for (const v of p.variants || []) {
      const price = Number(v.price);
      if (!Number.isFinite(price) || price <= 0) continue;
      const sku = String(v.sku || v.id || '').trim();
      if (!sku) continue;
      out.push({
        sku, brand, price, listed,
        available: v.available !== false,
        title: p.title ?? null,
        type: p.product_type ?? null,
        handle: p.handle ?? null
      });
    }
  }
  return out;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

// Per-brand price distribution, over the full captured population rather than a
// sample, so these are exact in the same sense the Fashionphile percentiles are.
export function summarise(items) {
  const byBrand = {};
  for (const it of items) {
    if (!it.available) continue;          // distribution describes what is buyable
    (byBrand[it.brand] ||= []).push(it.price);
  }
  const brands = {};
  for (const [brand, prices] of Object.entries(byBrand)) {
    const s = prices.sort((a, b) => a - b);
    brands[brand] = {
      live: s.length,
      price: {
        min: s[0], max: s[s.length - 1],
        p10: quantile(s, 0.10), p25: quantile(s, 0.25), median: quantile(s, 0.50),
        p75: quantile(s, 0.75), p90: quantile(s, 0.90),
        mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length)
      }
    };
  }
  return brands;
}

// One store, one brand at a time.
//
// Each brand stands or falls alone: a collection that cannot be crawled to its
// end is dropped for the day rather than diffed, because a half-fetched brand
// looks exactly like that brand selling out. The rest of the store still
// reports, so one bad collection costs one brand rather than the whole store.
export async function captureStore(store, brands, opts = {}) {
  const kept = [], failed = [];
  let pages = 0, products = 0;

  for (const brand of brands) {
    let got = null;
    for (const handle of handlesFor(brand)) {
      const r = await crawlCollection(store, handle, opts);
      pages += r.pages;
      if (!r.complete) { got = { error: r.error || 'hit the page cap' }; continue; }
      if (!r.products.length) { got = got || { empty: true }; continue; }   // try the next alias
      got = { products: r.products };
      break;
    }
    if (got?.error) { failed.push(`${brand}: ${got.error}`); continue; }
    if (!got?.products) continue;          // this store simply does not carry it
    products += got.products.length;
    // A collection can contain the odd cross-listed vendor, so trust the item's
    // own vendor rather than the collection it was found in.
    kept.push(...toItems(got.products).filter(i => i.brand === brand));
  }

  const live = kept.filter(i => i.available);
  return {
    status: failed.length ? 'partial' : 'ok',
    store: store.id,
    label: store.label,
    pages, products,
    live: live.length,
    failed,
    brands: summarise(kept),
    skus: live.map(({ sku, brand, price, listed }) => ({ sku, brand, price, listed }))
  };
}
