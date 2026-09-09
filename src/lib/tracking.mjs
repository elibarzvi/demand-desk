// What Demand Desk tracks, resolved from one file.
//
// These lists used to live as six separate literals across two files: the
// Fashionphile segments, the model watchlist, the eBay brands, the search
// keywords, the Trends batches and the StockX brands. Adding a brand meant
// editing all six and keeping them consistent, and nothing checked that they
// agreed. src/data/tracking.json is now the single source of truth and every
// source derives its list from it.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './util.mjs';

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'tracking.json'), 'utf8'));

export const BRANDS = cfg.brands;
export const MODEL_LIST = cfg.models;

// Fashionphile: one comparable segment per brand.
export const SEGMENTS = BRANDS.filter(b => b.fashionphile).map(b => ({
  brand: b.name, vendor: b.fashionphile.vendor, label: b.fashionphile.label,
  facet: b.fashionphile.facet, values: b.fashionphile.values
}));

export const EBAY_BRANDS = BRANDS.filter(b => b.ebay).map(b => b.name);
export const STOCKX_BRANDS = BRANDS.filter(b => b.stockx).map(b => b.name);
export const SEARCH_KEYWORDS = BRANDS.filter(b => b.searchKeyword)
  .map(b => ({ brand: b.name, keyword: b.searchKeyword }));

// Google Trends normalizes within a single request, so every batch carries the
// same anchor brand and is rescaled onto it. Exactly one brand may be the anchor.
const anchors = BRANDS.filter(b => b.trends?.batch === 'anchor');
if (anchors.length !== 1) {
  throw new Error(`tracking.json: expected exactly one Trends anchor, found ${anchors.length}`);
}
export const TREND_ANCHOR = { brand: anchors[0].name, keyword: anchors[0].trends.keyword };

const batched = BRANDS.filter(b => b.trends && b.trends.batch !== 'anchor');
const batchIds = [...new Set(batched.map(b => b.trends.batch))].sort();
export const TREND_BATCHES = batchIds.map(id =>
  batched.filter(b => b.trends.batch === id).map(b => ({ brand: b.name, keyword: b.trends.keyword }))
);

// DataForSEO accepts five keywords per Trends request and the anchor occupies one
// slot, so a batch of more than four would silently drop brands.
for (const [i, batch] of TREND_BATCHES.entries()) {
  if (batch.length > 4) {
    throw new Error(`tracking.json: Trends batch ${batchIds[i]} has ${batch.length} brands; the anchor takes one of five slots, so the limit is 4`);
  }
}
