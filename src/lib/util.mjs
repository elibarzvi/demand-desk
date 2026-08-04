import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Repo root, resolved from this file's location (src/lib/util.mjs -> ../../).
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SNAP_DIR = path.join(ROOT, 'data', 'snapshots');
export const EXPORT_DIR = path.join(ROOT, 'data', 'exports');
export const SITE_DIR = path.join(ROOT, 'site');
export const SITE_DATA_DIR = path.join(SITE_DIR, 'data');

export function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function listSnapshotDates() {
  if (!fs.existsSync(SNAP_DIR)) return [];
  return fs.readdirSync(SNAP_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => f.slice(0, 10))
    .sort();
}

export function readSnapshot(date) {
  return JSON.parse(fs.readFileSync(path.join(SNAP_DIR, `${date}.json`), 'utf8'));
}

export function readAllSnapshots() {
  return listSnapshotDates().map(readSnapshot);
}

export function latestSnapshot() {
  const dates = listSnapshotDates();
  return dates.length ? readSnapshot(dates[dates.length - 1]) : null;
}

// Snapshot immediately before `date` (used for carry-forward and trend deltas).
export function previousSnapshot(date) {
  const dates = listSnapshotDates().filter(d => d < date);
  return dates.length ? readSnapshot(dates[dates.length - 1]) : null;
}

// ---- CSV helpers ----
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map(h => csvCell(row[h])).join(','));
  return lines.join('\n') + '\n';
}

export function writeFile(p, content) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content);
}
