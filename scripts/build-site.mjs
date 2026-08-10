// Prepares the static site payload the dashboard reads at runtime. Writes
// site/data/{latest,history,index}.json and copies the CSV exports in for
// download. site/data/ is regenerated every build (gitignored); data/ is the
// permanent source of truth.
import fs from 'node:fs';
import path from 'node:path';
import { EXPORT_DIR, SITE_DATA_DIR, readAllSnapshots, listSnapshotDates, writeFile, ensureDir } from '../src/lib/util.mjs';

function build() {
  const snaps = readAllSnapshots();
  if (!snaps.length) { console.log('[build] no snapshots'); return; }
  const latest = snaps[snaps.length - 1];

  // Per-item requester history for sparklines + trend arrows.
  const huntSeries = {};
  for (const s of snaps) {
    for (const h of s.sources?.mirror?.hunt || []) {
      const key = `${h.brand} — ${h.item}`;
      (huntSeries[key] ||= []).push({ date: s.date, requesters: h.requesters });
    }
  }

  // Previous-day search volume per brand (for the day-over-day comp on the card).
  const prevSnap = snaps.length >= 2 ? snaps[snaps.length - 2] : null;
  const searchVolPrev = {};
  (prevSnap?.sources?.search_volume?.focus || []).forEach(f => { if (f.volume != null) searchVolPrev[f.brand] = f.volume; });

  // 7-day trend series — Fashionphile is the cleanest daily-varying supply signal.
  const fpBrands = [...new Set(snaps.flatMap(s => (s.sources?.fashionphile?.focus || []).map(f => f.brand)))];
  const fpDates = [], fpTotal = [], fpByBrand = {};
  fpBrands.forEach(b => { fpByBrand[b] = []; });
  for (const s of snaps) {
    const foc = s.sources?.fashionphile?.focus || [];
    if (!foc.length) continue;
    fpDates.push(s.date);
    fpTotal.push(foc.reduce((a, f) => a + (f.count || 0), 0));
    const map = {}; foc.forEach(f => { map[f.brand] = f.count; });
    fpBrands.forEach(b => fpByBrand[b].push(map[b] ?? null));
  }
  const trends = { fp: { dates: fpDates, total: fpTotal, byBrand: fpByBrand } };

  ensureDir(SITE_DATA_DIR);
  writeFile(path.join(SITE_DATA_DIR, 'latest.json'), JSON.stringify(latest) + '\n');
  writeFile(path.join(SITE_DATA_DIR, 'history.json'), JSON.stringify({
    firstDate: snaps[0].date,
    lastDate: latest.date,
    count: snaps.length,
    dates: listSnapshotDates(),
    huntSeries,
    searchVolPrev,
    searchVolPrevDate: prevSnap?.date || null,
    trends
  }) + '\n');
  writeFile(path.join(SITE_DATA_DIR, 'index.json'), JSON.stringify({ dates: listSnapshotDates() }) + '\n');

  // Copy CSV exports for download links.
  const expDir = path.join(SITE_DATA_DIR, 'exports');
  if (fs.existsSync(EXPORT_DIR)) {
    fs.cpSync(EXPORT_DIR, expDir, { recursive: true });
  }

  // Complete raw archive: every snapshot in one file (build artifact, not committed).
  ensureDir(expDir);
  const allJson = JSON.stringify(snaps, null, 2) + '\n';
  writeFile(path.join(expDir, 'all-snapshots.json'), allJson);
  const manPath = path.join(expDir, 'index.json');
  if (fs.existsSync(manPath)) {
    const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
    man.raw = { file: 'all-snapshots.json', snapshots: snaps.length, bytes: Buffer.byteLength(allJson) };
    writeFile(manPath, JSON.stringify(man, null, 2) + '\n');
  }

  console.log(`[build] site/data ready — ${snaps.length} snapshots, latest ${latest.date}`);
}

build();
