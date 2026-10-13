// Rolls every snapshot in data/snapshots/ into tidy CSV time-series under
// data/exports/. "Tidy" = one row per observation with a date column, so any
// date range (days, weeks, all-time) pivots cleanly in Excel/Sheets.
import fs from 'node:fs';
import path from 'node:path';
import { EXPORT_DIR, readAllSnapshots, listSnapshotDates, readSnapshot, toCsv, writeFile, ensureDir } from '../src/lib/util.mjs';

function build() {
  const snaps = readAllSnapshots();
  if (!snaps.length) { console.log('[export] no snapshots yet'); return; }

  const hunt = [], invPriced = [], supply = [], searchRank = [], retention = [];
  const fp = [], trrClimb = [], vcRank = [], vcSelling = [], ebay = [], searchVol = [], gtrends = [];
  const fpCondition = [], sellThrough = [], shopPrices = [], shopSell = [];

  for (const s of snaps) {
    const d = s.date;
    const m = s.sources?.mirror || {};
    for (const h of m.hunt || []) hunt.push({ date: d, brand: h.brand, item: h.item, requesters: h.requesters });
    for (const p of m.inventoryPriced || m.inventory || []) invPriced.push({ date: d, brand: p.brand, item: p.item, price: p.price ?? '' });
    for (const c of m.inventoryCounts || []) supply.push({ date: d, brand: c.brand, listing_count: c.count });
    // myGemma and Rebag, same shape for both so the two stores sit in one sheet
    // and can be compared against Fashionphile without a join.
    for (const id of ['mygemma', 'rebag']) {
      const st = s.sources?.[id];
      if (!st || st.status === 'error') continue;
      for (const f of st.focus || []) {
        shopPrices.push({ date: d, store: id, brand: f.brand, live: f.live ?? '',
          p10_price: f.price?.p10 ?? '', median_price: f.price?.median ?? '',
          p90_price: f.price?.p90 ?? '', mean_price: f.price?.mean ?? '' });
      }
      for (const [brand, v] of Object.entries(st.sellThrough?.brands || {})) {
        shopSell.push({ date: d, store: id, brand, live: v.live ?? '', arrivals: v.arrivals ?? '',
          departures: v.departures ?? '', turnover_pct: v.turnoverPct ?? '',
          turnover_pct_per_day: v.turnoverPctPerDay ?? '',
          window_hours: st.sellThrough?.windowHours ?? '',
          median_days_to_sell: v.medianDaysToSell ?? '', median_departure_price: v.medianDeparturePrice ?? '' });
      }
    }
    for (const f of s.sources?.ebay?.focus || []) ebay.push({ date: d, brand: f.brand, low_price: f.low ?? '', listings: f.total ?? '' });
    for (const f of s.sources?.search_volume?.focus || []) searchVol.push({ date: d, brand: f.brand, keyword: f.keyword, monthly_searches: f.volume ?? '' });
    for (const f of s.sources?.google_trends?.focus || []) { const last = (f.series || []).slice(-1)[0]; gtrends.push({ date: d, brand: f.brand, interest: last ? last.value : '' }); }
    // Handles both shapes: pre-upgrade rows only carry low/count, current rows
    // carry the segment price distribution. Legacy `low` is retained but is the
    // cheapest object the brand sells, not a bag price.
    for (const f of s.sources?.fashionphile?.focus || []) {
      fp.push({
        date: d, brand: f.brand, segment: f.segment ?? 'All categories',
        listings_all: f.liveAll ?? f.count ?? '', listings_segment: f.live ?? '',
        p10_price: f.price?.p10 ?? '', median_price: f.price?.median ?? '', p90_price: f.price?.p90 ?? '',
        mean_price: f.price?.mean ?? '', legacy_low_price: f.low ?? ''
      });
      for (const [cond, n] of Object.entries(f.condition || {})) fpCondition.push({ date: d, brand: f.brand, condition: cond, count: n });
    }
    for (const [brand, v] of Object.entries(s.sources?.fp_sell_through?.brands || {})) {
      sellThrough.push({ date: d, brand, live: v.live ?? '', arrivals: v.arrivals ?? '', departures: v.departures ?? '',
        turnover_pct: v.turnoverPct ?? '', turnover_pct_per_day: v.turnoverPctPerDay ?? '',
        window_hours: s.sources?.fp_sell_through?.windowHours ?? '',
        median_days_to_sell: v.medianDaysToSell ?? '', median_departure_price: v.medianDeparturePrice ?? '' });
    }

    const trr = s.sources?.therealreal || {};
    (trr.mostSearchedBrands || []).forEach((b, i) => searchRank.push({ date: d, source: 'The RealReal', type: 'brand', rank: i + 1, entity: b }));
    (trr.valueClimbers || []).forEach(c => trrClimb.push({ date: d, item: c.item, yoy_change_pct: c.yoyPct }));

    const vc = s.sources?.vestiaire || {};
    (vc.valueRanking || []).forEach((r, i) => vcRank.push({ date: d, rank: i + 1, brand: r.brand, points: r.points }));
    (vc.fastestSelling || []).forEach(x => vcSelling.push({ date: d, item: x.item, seconds: x.seconds }));

    const idx = s.sources?.indices || {};
    (idx.mygemma?.brands || []).forEach((name, i) => searchRank.push({ date: d, source: 'myGemma', type: 'brand', rank: i + 1, entity: name }));
    (idx.mygemma?.handbags || []).forEach((name, i) => searchRank.push({ date: d, source: 'myGemma', type: 'handbag', rank: i + 1, entity: name }));
    (idx.lyst?.brands || []).forEach(b => searchRank.push({ date: d, source: 'Lyst', type: 'brand', rank: b.rank, entity: b.name }));
    (idx.rebag?.retention || []).forEach(r => retention.push({ date: d, brand: r.brand, retention_pct: r.pct, report_year: r.reportYear, appreciates: r.appreciates }));
  }

  const sheets = [
    ['mirror-hunt.csv', ['date', 'brand', 'item', 'requesters'], hunt],
    ['mirror-inventory-priced.csv', ['date', 'brand', 'item', 'price'], invPriced],
    ['mirror-supply-mix.csv', ['date', 'brand', 'listing_count'], supply],
    ['ebay.csv', ['date', 'brand', 'low_price', 'listings'], ebay],
    ['search-volume.csv', ['date', 'brand', 'keyword', 'monthly_searches'], searchVol],
    ['google-trends.csv', ['date', 'brand', 'interest'], gtrends],
    ['fashionphile.csv', ['date', 'brand', 'segment', 'listings_all', 'listings_segment', 'p10_price', 'median_price', 'p90_price', 'mean_price', 'legacy_low_price'], fp],
    ['fashionphile-condition.csv', ['date', 'brand', 'condition', 'count'], fpCondition],
    ['store-prices.csv', ['date', 'store', 'brand', 'live', 'p10_price', 'median_price', 'p90_price', 'mean_price'], shopPrices],
    ['store-sell-through.csv', ['date', 'store', 'brand', 'live', 'arrivals', 'departures', 'turnover_pct', 'turnover_pct_per_day', 'window_hours', 'median_days_to_sell', 'median_departure_price'], shopSell],
    ['fp-sell-through.csv', ['date', 'brand', 'live', 'arrivals', 'departures', 'turnover_pct', 'turnover_pct_per_day', 'window_hours', 'median_days_to_sell', 'median_departure_price'], sellThrough],
    ['therealreal-value-climbers.csv', ['date', 'item', 'yoy_change_pct'], trrClimb],
    ['vestiaire-value-ranking.csv', ['date', 'rank', 'brand', 'points'], vcRank],
    ['vestiaire-fastest-selling.csv', ['date', 'item', 'seconds'], vcSelling],
    ['indices-search-rank.csv', ['date', 'source', 'type', 'rank', 'entity'], searchRank],
    ['rebag-retention.csv', ['date', 'brand', 'retention_pct', 'report_year', 'appreciates'], retention]
  ];

  ensureDir(EXPORT_DIR);
  const manifest = [];
  for (const [name, headers, rows] of sheets) {
    const csv = toCsv(headers, rows);
    writeFile(path.join(EXPORT_DIR, name), csv);
    manifest.push({ file: name, rows: rows.length, bytes: Buffer.byteLength(csv) });
  }

  // Per-day sheets: data/exports/daily/YYYY-MM-DD/{hunt,inventory}.csv
  for (const date of listSnapshotDates()) {
    const s = readSnapshot(date);
    const m = s.sources?.mirror || {};
    const dir = path.join(EXPORT_DIR, 'daily', date);
    writeFile(path.join(dir, 'hunt.csv'), toCsv(['brand', 'item', 'requesters'], (m.hunt || []).map(h => ({ brand: h.brand, item: h.item, requesters: h.requesters }))));
    writeFile(path.join(dir, 'inventory.csv'), toCsv(['brand', 'item', 'price'], (m.inventoryPriced || m.inventory || []).map(p => ({ brand: p.brand, item: p.item, price: p.price ?? '' }))));
  }

  writeFile(path.join(EXPORT_DIR, 'index.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    firstDate: snaps[0].date,
    lastDate: snaps[snaps.length - 1].date,
    snapshots: snaps.length,
    sheets: manifest
  }, null, 2) + '\n');

  console.log(`[export] ${sheets.length} time-series sheets + ${listSnapshotDates().length} daily folders (${snaps.length} snapshots, from ${snaps[0].date})`);
}

build();
