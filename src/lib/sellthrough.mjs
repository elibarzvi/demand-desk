// Sell-through tracking for Fashionphile.
//
// Resale inventory is one-of-one: each SKU is a single physical object. So a SKU
// that was live yesterday and is gone today has left the market, and the number
// of days between its listing date and its departure is its time to sell. That
// is the closest thing to a transaction feed available without private data.
//
// Departures are recorded permanently in each day's snapshot. The full live SKU
// set is far too large to append daily, so it lives in a single gzipped state
// file that is rewritten each run and committed for continuity between CI runs.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { ROOT, ensureDir } from './util.mjs';

export const STATE_DIR = path.join(ROOT, 'data', 'state');
const STATE_FILE = path.join(STATE_DIR, 'fp-live.json.gz');
const PREV_FILE = path.join(STATE_DIR, 'fp-live-prev.json.gz');

function readGz(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));
  } catch (e) {
    console.warn(`[sellthrough] ${path.basename(file)} unreadable, ignoring:`, e.message);
    return null;
  }
}

function writeGz(file, data) {
  ensureDir(STATE_DIR);
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(JSON.stringify(data)), { level: 9 }));
}

// The daily workflow fires three times a day on purpose, and the scrape is meant
// to be idempotent: re-running overwrites the day rather than appending to it.
// A single state file would break that, because the second run of a day would
// diff today against today and record zero departures, silently erasing the day's
// sell-through. Keeping the previous day's state alongside the current one makes
// a re-run reproduce the same answer instead of destroying it.
export function readLiveState(date) {
  const current = readGz(STATE_FILE);
  const previous = readGz(PREV_FILE);
  // Re-run of a day already captured: compare against the day before it.
  if (current && date && current.date === date) return previous;
  return current;
}

export function writeLiveState(state) {
  const current = readGz(STATE_FILE);
  // Rotate only when moving to a new day, so repeat runs cannot shift the baseline.
  if (current && current.date !== state.date) writeGz(PREV_FILE, current);
  writeGz(STATE_FILE, state);
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

// Diff today's live SKUs against the stored state.
//
// `firstSeen` is the first day WE observed the SKU; `listed` is Fashionphile's own
// published_at. We prefer `listed` for days-to-sell because it predates our own
// history, and fall back to firstSeen when it is missing. Departures for SKUs we
// have never seen before cannot happen, so the first run only establishes state.
export function diffLive(prev, captures, date) {
  const brands = {};
  const nextState = { date, brands: {} };

  for (const cap of captures) {
    const prevBrand = prev?.brands?.[cap.brand] || null;
    const todaySkus = new Map(cap.skus.map(s => [s.sku, s]));
    const stateBrand = {};

    let arrivals = 0;
    for (const [sku, s] of todaySkus) {
      const before = prevBrand?.[sku];
      if (before) {
        stateBrand[sku] = before;                                  // carry original dates
      } else {
        arrivals++;
        stateBrand[sku] = { f: date, l: s.listed || date, p: s.price ?? null };
      }
    }

    const departures = [];
    if (prevBrand) {
      for (const [sku, rec] of Object.entries(prevBrand)) {
        if (todaySkus.has(sku)) continue;
        const listed = rec.l || rec.f;
        departures.push({
          sku,
          price: rec.p ?? null,
          listed,
          firstSeen: rec.f,
          days: daysBetween(listed, date),
          observedDays: daysBetween(rec.f, date)
        });
      }
    }

    nextState.brands[cap.brand] = stateBrand;
    brands[cap.brand] = {
      live: cap.live,
      arrivals,
      departures: departures.length,
      // Turnover is departures measured against yesterday's live pool: the share
      // of standing inventory that cleared in a day.
      turnoverPct: prevBrand && Object.keys(prevBrand).length
        ? +(departures.length / Object.keys(prevBrand).length * 100).toFixed(2)
        : null,
      medianDaysToSell: median(departures.map(d => d.days).filter(d => d != null)),
      medianDeparturePrice: median(departures.map(d => d.price).filter(p => p != null)),
      events: departures
    };
  }

  return { brands, nextState, baseline: !prev };
}

export function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}
