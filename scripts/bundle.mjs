// Bundles the entire raw dataset (every daily snapshot + every CSV export) into a
// single downloadable ZIP for the dashboard's "Download everything" button.
// Build artifact only — written into site/data/exports/, never committed.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, SITE_DATA_DIR, ensureDir } from '../src/lib/util.mjs';

const outDir = path.join(SITE_DATA_DIR, 'exports');
const zipName = 'demand-desk-data.zip';
const zipPath = path.join(outDir, zipName);

ensureDir(outDir);
if (fs.existsSync(zipPath)) fs.rmSync(zipPath);

let zipped = false;
try {
  // Zip the committed data/ tree (snapshots + CSV exports) with repo-relative paths.
  execFileSync('zip', ['-r', '-q', zipPath, 'data'], { cwd: ROOT });
  zipped = true;
} catch (e) {
  console.warn(`[bundle] 'zip' unavailable, skipping ZIP (${e.message}). The individual CSVs and all-snapshots.json still download fine.`);
}

// Record the bundle in the manifest so the site can link it with a size.
const manPath = path.join(outDir, 'index.json');
if (fs.existsSync(manPath)) {
  const man = JSON.parse(fs.readFileSync(manPath, 'utf8'));
  if (zipped) man.bundle = { file: zipName, bytes: fs.statSync(zipPath).size };
  fs.writeFileSync(manPath, JSON.stringify(man, null, 2) + '\n');
}

console.log(`[bundle] ${zipped ? `${zipName} (${(fs.statSync(zipPath).size / 1024).toFixed(1)} KB)` : 'no zip'}`);
