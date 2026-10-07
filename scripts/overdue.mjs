// Overdue listings: Fashionphile stock that has sat far longer than comparable
// pieces took to clear.
//
// Kept out of derive.mjs on purpose. Derive is a pure function of the snapshot
// log, which is what makes it safe to re-run and cheap to reason about. This
// reads the live SKU state as well and makes network calls to resolve titles and
// today's asking price, so it is its own step. If it fails the day's statistics
// are unaffected.
//
// Reads : data/exports/fp-sold.csv       the permanent departure log
//         data/state/fp-live.json.gz     what is live right now, with listing dates
// Writes: data/derived/overdue.json
//         data/exports/overdue.csv
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT, ensureDir, toCsv, writeFile } from '../src/lib/util.mjs';
import { buildClearingModel, findOverdue, enrichOverdue, MIN_BAND_COMPS, OVERDUE_FACTOR } from '../src/lib/clearing.mjs';

const EXPORT_DIR = path.join(ROOT, 'data', 'exports');
const DERIVED_DIR = path.join(ROOT, 'data', 'derived');
const ENRICH_LIMIT = 60;

function readSoldCsv(file) {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  const head = lines.shift().split(',');
  const iBrand = head.indexOf('brand'), iPrice = head.indexOf('price'), iDays = head.indexOf('days_to_sell');
  return lines.map(l => {
    const c = l.split(',');
    return { brand: c[iBrand], price: c[iPrice], daysToSell: c[iDays] };
  });
}

async function main() {
  const offline = process.argv.includes('--offline');
  const sold = readSoldCsv(path.join(EXPORT_DIR, 'fp-sold.csv'));
  if (!sold.length) { console.log('[overdue] no sell-through log yet, nothing to do'); return; }

  const statePath = path.join(ROOT, 'data', 'state', 'fp-live.json.gz');
  if (!fs.existsSync(statePath)) { console.log('[overdue] no live state yet, nothing to do'); return; }
  const live = JSON.parse(zlib.gunzipSync(fs.readFileSync(statePath)).toString('utf8'));

  const model = buildClearingModel(sold);
  const brands = Object.keys(model.byBrand);
  if (!brands.length) {
    console.log(`[overdue] no brand has ${MIN_BAND_COMPS * 5}+ departures yet, skipping`);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const items = findOverdue(live, model, today);
  if (!offline) await enrichOverdue(items, { limit: ENRICH_LIMIT });

  ensureDir(DERIVED_DIR); ensureDir(EXPORT_DIR);
  const payload = {
    generatedAt: new Date().toISOString(),
    asOf: live.date,
    factor: OVERDUE_FACTOR,
    minBandComps: MIN_BAND_COMPS,
    enriched: offline ? 0 : Math.min(items.length, ENRICH_LIMIT),
    model: model.byBrand,
    items
  };
  fs.writeFileSync(path.join(DERIVED_DIR, 'overdue.json'), JSON.stringify(payload, null, 2) + '\n');

  const cols = ['brand', 'sku', 'title', 'price', 'current_price', 'markdown_pct', 'age_days',
    'band_p75_days', 'overdue_ratio', 'model', 'listed', 'url'];
  writeFile(path.join(EXPORT_DIR, 'overdue.csv'), toCsv(cols, items.map(i => ({
    brand: i.brand, sku: i.sku, title: i.title ?? '', price: i.price,
    current_price: i.currentPrice ?? '', markdown_pct: i.markdownPct ?? '',
    age_days: i.ageDays, band_p75_days: i.bandP75Days, overdue_ratio: i.overdueRatio,
    model: i.model ?? '', listed: i.listed ?? '', url: i.url ?? ''
  }))));

  const marked = items.filter(i => (i.markdownPct ?? 0) > 0).length;
  const high = items.filter(i => i.price >= 5000).length;
  console.log(`[overdue] ${items.length} overdue across ${brands.length} brands `
    + `(${high} at $5k+, ${marked} already marked down) · threshold ${OVERDUE_FACTOR}x band p75`);
  for (const i of items.slice(0, 5)) {
    console.log(`   ${i.overdueRatio}x  ${i.brand} $${i.price.toLocaleString('en-US')} `
      + `· ${i.ageDays}d vs ${Math.round(i.bandP75Days)}d${i.markdownPct > 0 ? ` · -${i.markdownPct}%` : ''}`
      + `${i.title ? ` · ${i.title.slice(0, 48)}` : ''}`);
  }
}

main().catch(e => { console.error('[overdue] failed:', e.message); process.exitCode = 1; });
