// Rolls every snapshot in data/snapshots/ into tidy CSV time-series under
// data/exports/. "Tidy" = one row per observation with a date column, so any
// date range (days, weeks, all-time) pivots cleanly in Excel/Sheets.
import fs from 'node:fs';
import path from 'node:path';
import { EXPORT_DIR, readAllSnapshots, listSnapshotDates, readSnapshot, toCsv, writeFile, ensureDir } from '../src/lib/util.mjs';

function stockxRows(date, sx) {
  return (sx?.items || []).map(it => ({
    date,
    item: it.item,
    low: it.low ?? it.price ?? '',
    high: it.high ?? it.price ?? ''
  }));
}

function build() {
  const snaps = readAllSnapshots();
  if (!snaps.length) { console.log('[export] no snapshots yet'); return; }

  const hunt = [], invPriced = [], supply = [], stockx = [], searchRank = [], retention = [];

  for (const s of snaps) {
    const d = s.date;
    const m = s.sources?.mirror || {};
    for (const h of m.hunt || []) hunt.push({ date: d, brand: h.brand, item: h.item, requesters: h.requesters });
    for (const p of m.inventoryPriced || m.inventory || []) invPriced.push({ date: d, brand: p.brand, item: p.item, price: p.price ?? '' });
    for (const c of m.inventoryCounts || []) supply.push({ date: d, brand: c.brand, listing_count: c.count });
    for (const r of stockxRows(d, s.sources?.stockx_goyard)) stockx.push(r);

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
    ['stockx-goyard.csv', ['date', 'item', 'low', 'high'], stockx],
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
