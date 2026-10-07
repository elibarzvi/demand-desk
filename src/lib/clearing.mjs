// Clearing-time model, and the overdue listings it exposes.
//
// Every other signal here describes a market. This one describes a counterparty.
// We know, per SKU, the day Fashionphile listed it and that it is still live. We
// also know from 18,000 inferred departures how long comparable pieces actually
// took to clear. An item far past that point is not a data point about supply,
// it is a seller whose capital has been dead for months, and that is the moment
// an offer lands.
//
// Two things make this honest rather than a plausible-looking ranking:
//
// Comparables are drawn per brand AND per price band, never per brand alone. A
// $1,200 Hermès accessory and a $25,000 Birkin are not the same market. In fact
// the bands run the opposite way to intuition: across 65 days the top price
// quintile of Hermès cleared in a median of 36 days against 64 for the bottom,
// and Chanel 43 against 76. Scarcity beats affordability at the top of a
// desirable house, so comparing an expensive item to its brand's overall median
// would make nearly every grail look overdue when it is merely expensive.
//
// The threshold is the 75th percentile of observed clearing time, not the
// median. Half of all items are slower than the median by definition, so a
// median threshold would flag half the market and mean nothing.
import crypto from 'node:crypto';

export const MIN_BAND_COMPS = 30;   // below this a band cannot support a threshold
export const OVERDUE_FACTOR = 1.5;  // multiple of p75 before an item is called overdue
const BANDS = 5;

function quantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

export function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// `sold` is [{brand, price, daysToSell}]. Returns price-band clearing stats per
// brand. Bands are quintiles of that brand's own sold prices, so each brand is
// split where its own market actually divides rather than on fixed dollar lines.
export function buildClearingModel(sold) {
  const byBrand = {};
  const grouped = {};
  for (const r of sold) {
    const p = Number(r.price), d = Number(r.daysToSell);
    if (!Number.isFinite(p) || p <= 0) continue;
    if (!Number.isFinite(d) || d < 0 || d > 2000) continue;   // a bad listed date, not a 6-year listing
    (grouped[r.brand] ||= []).push([p, d]);
  }

  for (const [brand, rows] of Object.entries(grouped)) {
    if (rows.length < MIN_BAND_COMPS * BANDS) continue;       // too thin to split at all
    const prices = rows.map(([p]) => p).sort((a, b) => a - b);
    const cuts = [];
    for (let i = 1; i < BANDS; i++) cuts.push(prices[Math.floor(prices.length * i / BANDS)]);

    const edges = [0, ...cuts, Infinity];
    const bands = [];
    for (let i = 0; i < edges.length - 1; i++) {
      const lo = edges[i], hi = edges[i + 1];
      const days = rows.filter(([p]) => p >= lo && p < hi).map(([, d]) => d).sort((a, b) => a - b);
      bands.push({
        lo, hi: hi === Infinity ? null : hi,
        n: days.length,
        medianDays: quantile(days, 0.5),
        p75Days: quantile(days, 0.75),
        usable: days.length >= MIN_BAND_COMPS
      });
    }
    byBrand[brand] = { n: rows.length, bands };
  }
  return { byBrand, builtAt: new Date().toISOString() };
}

export function bandFor(model, brand, price) {
  const b = model.byBrand?.[brand];
  if (!b) return null;
  return b.bands.find(x => price >= x.lo && (x.hi == null || price < x.hi)) || null;
}

function daysBetween(fromIso, to) {
  const a = new Date(fromIso + 'T00:00:00Z'), b = new Date(to + 'T00:00:00Z');
  if (Number.isNaN(+a)) return null;
  return Math.round((b - a) / 86400000);
}

// Walk the live SKU state and return everything past OVERDUE_FACTOR x its band's
// p75. `liveState` is the gzipped state written by src/lib/sellthrough.mjs:
// { date, brands: { [brand]: { [sku]: {f: firstSeen, l: listed, p: price, m: model} } } }.
export function findOverdue(liveState, model, today, { factor = OVERDUE_FACTOR, minPrice = 0 } = {}) {
  const out = [];
  for (const [brand, skus] of Object.entries(liveState?.brands || {})) {
    for (const [sku, r] of Object.entries(skus || {})) {
      const price = Number(r.p);
      if (!Number.isFinite(price) || price < minPrice) continue;
      // `l` is Fashionphile's own published_at and predates our history; `f` is
      // merely the first day we looked. Preferring `l` keeps age honest for an
      // item that was already months old when tracking began.
      const since = r.l || r.f;
      const age = since ? daysBetween(since, today) : null;
      if (age == null || age < 0) continue;

      const band = bandFor(model, brand, price);
      if (!band || !band.usable || !band.p75Days) continue;
      const threshold = band.p75Days * factor;
      if (age <= threshold) continue;

      out.push({
        sku, brand, price,
        model: r.m ?? null,
        listed: r.l ?? null,
        firstSeen: r.f ?? null,
        ageDays: age,
        bandLo: band.lo, bandHi: band.hi,
        bandMedianDays: band.medianDays,
        bandP75Days: band.p75Days,
        comps: band.n,
        overdueRatio: +(age / band.p75Days).toFixed(2)
      });
    }
  }
  out.sort((a, b) => b.overdueRatio - a.overdueRatio);
  return out;
}

// Fashionphile's handle ends with the SKU, so one search by SKU yields the URL,
// the title, and today's asking price. That last one is the point: an item that
// is both long overdue AND marked down since we first saw it is a seller who has
// already started conceding, which is a different conversation from one who has
// not. Bounded and best-effort; enrichment failing must never cost us the list.
const APP = 'NSJAZ0QG7K';
const KEY = 'e545a3cf82cf7dbc5ff39f49c214863e';
const INDEX = 'shopify_products_price_asc';

export async function enrichOverdue(items, { limit = 60, fetchImpl = fetch } = {}) {
  const attrs = encodeURIComponent(JSON.stringify(['sku', 'handle', 'title', 'price']));
  for (const it of items.slice(0, limit)) {
    try {
      const res = await fetchImpl(`https://${APP}-dsn.algolia.net/1/indexes/${INDEX}/query`, {
        method: 'POST',
        headers: { 'X-Algolia-Application-Id': APP, 'X-Algolia-API-Key': KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: `query=${encodeURIComponent(it.sku)}&hitsPerPage=1&attributesToRetrieve=${attrs}` })
      });
      if (!res.ok) continue;
      const hit = (await res.json()).hits?.[0];
      // Guard against a SKU-shaped query matching some other product's text.
      if (!hit || String(hit.sku) !== String(it.sku)) continue;
      it.title = hit.title ?? null;
      it.url = hit.handle ? `https://www.fashionphile.com/products/${hit.handle}` : null;
      const now = Number(hit.price);
      if (Number.isFinite(now)) {
        it.currentPrice = now;
        it.markdownPct = it.price > 0 ? +(((it.price - now) / it.price) * 100).toFixed(1) : null;
      }
    } catch { /* best effort: an unenriched row is still a usable row */ }
  }
  return items;
}

export function fingerprintModel(model) {
  return crypto.createHash('sha1').update(JSON.stringify(model.byBrand)).digest('hex').slice(0, 12);
}
