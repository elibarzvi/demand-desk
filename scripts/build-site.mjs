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

  ensureDir(SITE_DATA_DIR);
  writeFile(path.join(SITE_DATA_DIR, 'latest.json'), JSON.stringify(latest) + '\n');
  writeFile(path.join(SITE_DATA_DIR, 'history.json'), JSON.stringify({
    firstDate: snaps[0].date,
    lastDate: latest.date,
    count: snaps.length,
    dates: listSnapshotDates(),
    huntSeries
  }) + '\n');
  writeFile(path.join(SITE_DATA_DIR, 'index.json'), JSON.stringify({ dates: listSnapshotDates() }) + '\n');

  // Copy CSV exports for download links.
  if (fs.existsSync(EXPORT_DIR)) {
    fs.cpSync(EXPORT_DIR, path.join(SITE_DATA_DIR, 'exports'), { recursive: true });
  }

  console.log(`[build] site/data ready — ${snaps.length} snapshots, latest ${latest.date}`);
}

build();
