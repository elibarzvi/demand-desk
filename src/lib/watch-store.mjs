// Lifecycle tracking for watched listings: the part that turns a list of matches
// into the three things worth being told about.
//
//   new    an eligible listing appeared that was not there before
//   drop   a tracked listing fell to a new low price
//   gone   a tracked listing left the market, confirmed per source as sold or
//          merely no longer listed
//
// Kept free of network calls so every transition can be tested against synthetic
// runs before it is trusted with live alerts.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './util.mjs';

const STORE_FILE = path.join(ROOT, 'data', 'state', 'watch-items.json');

export function readStore() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')); } catch { return {}; }
}
export function writeStore(store) {
  fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
  store._meta = { updatedAt: new Date().toISOString() };
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2) + '\n');
}

// Keys beginning with an underscore hold metadata, not listings.
const isListing = ([k, r]) => !k.startsWith('_') && r && r.watch;

export const keyOf = m => `${m.source}:${m.id}`;

// A listing can drop out of one search without leaving the market: it slides
// below the price floor, falls outside the result page, or the API has a bad
// minute. Requiring it to be absent twice before checking avoids reporting a
// sale that never happened.
const MISSES_BEFORE_CHECK = 2;

// Reconcile one watch's matches for this run against what is already known.
// Returns alerts that need no further lookup, plus the listings that went
// missing and must be confirmed with their source before anything is said.
export function reconcile(store, watch, matches, date) {
  const events = [];
  const present = new Set();
  const dropPct = watch.dropPct ?? 5;

  // The first time a watch runs, every standing listing is unseen, but none of
  // them is newly listed. Record them silently rather than calling a month-old
  // listing "new".
  const seeding = !Object.entries(store).filter(isListing).some(([, r]) => r.watch === watch.id);

  for (const m of matches) {
    const k = keyOf(m);
    present.add(k);
    const rec = store[k];

    if (!rec) {
      store[k] = {
        watch: watch.id, source: m.source, id: m.id, title: m.title, url: m.url,
        image: m.image ?? null, condition: m.condition ?? null,
        seller: m.seller ?? null, sellerPct: m.sellerPct ?? null, sellerScore: m.sellerScore ?? null,
        listed: m.listed ?? null, firstSeen: date, lastSeen: date, missedRuns: 0,
        price: m.price, firstPrice: m.price, lowPrice: m.price, status: 'live'
      };
      if (!seeding) events.push({ type: 'new', watch: watch.id, ...m, underTarget: underTarget(watch, m.price) });
      continue;
    }

    observe(rec, m, date);
    const ev = maybeDrop(rec, watch, m.price, dropPct);
    if (ev) events.push({ ...ev, ...m });
  }

  const missing = [];
  for (const [k, rec] of Object.entries(store).filter(isListing)) {
    if (rec.watch !== watch.id || rec.status !== 'live' || present.has(k)) continue;
    rec.missedRuns = (rec.missedRuns || 0) + 1;
    if (rec.missedRuns >= MISSES_BEFORE_CHECK) missing.push(k);
  }

  return { events, missing, seeding };
}

// Apply the source's verdict on a missing listing. `still-live` with a price
// covers the listing that only fell outside the search, for instance by
// dropping below the watch's floor, which is itself worth reporting as a drop.
export function settle(store, watch, k, verdict, date) {
  const rec = store[k];
  if (!rec) return null;

  if (verdict.state === 'still-live') {
    rec.missedRuns = 0;
    rec.lastSeen = date;
    if (verdict.price != null) {
      const ev = maybeDrop(rec, watch, verdict.price, watch.dropPct ?? 5);
      rec.price = verdict.price;
      if (ev) return { ...ev, source: rec.source, id: rec.id, title: rec.title, url: rec.url, price: verdict.price };
    }
    return null;
  }
  if (verdict.state === 'unknown') return null;   // try again next run, say nothing

  rec.status = verdict.state;                     // 'sold' or 'gone'
  rec.endedOn = date;
  const since = rec.listed || rec.firstSeen;
  return {
    type: verdict.state, watch: watch.id, source: rec.source, id: rec.id,
    title: rec.title, url: rec.url, price: rec.price, firstPrice: rec.firstPrice,
    daysOnMarket: since ? Math.round((new Date(date) - new Date(since)) / 86400000) : null
  };
}

function observe(rec, m, date) {
  rec.lastSeen = date;
  rec.missedRuns = 0;
  rec.title = m.title;
  rec.url = m.url;
  // Records written before images were captured get filled in on their next sighting.
  if (m.image) rec.image = m.image;
  if (m.condition) rec.condition = m.condition;
  if (m.seller) { rec.seller = m.seller; rec.sellerPct = m.sellerPct ?? rec.sellerPct; rec.sellerScore = m.sellerScore ?? rec.sellerScore; }
  if (rec.status !== 'live') rec.status = 'live';
}

// Alert only on a new LOW, not on any decrease. A seller who raises a price and
// then trims it back has not produced a better deal than was already on offer.
function maybeDrop(rec, watch, price, dropPct) {
  const low = rec.lowPrice ?? rec.price;
  rec.price = price;
  if (price == null || low == null) return null;
  if (price <= low * (1 - dropPct / 100)) {
    rec.lowPrice = price;
    return { type: 'drop', watch: watch.id, from: low, to: price,
             dropPct: +(((low - price) / low) * 100).toFixed(1), underTarget: underTarget(watch, price) };
  }
  if (price < low) rec.lowPrice = price;          // small drift down still moves the floor
  return null;
}

const underTarget = (watch, price) => watch.targetPrice != null && price != null && price <= watch.targetPrice;

// Keep ended listings for a while so a relist is recognised, then forget them.
export function prune(store, date, keepDays = 90) {
  const cutoff = new Date(new Date(date) - keepDays * 86400000).toISOString().slice(0, 10);
  for (const [k, r] of Object.entries(store).filter(isListing)) {
    if (r.status !== 'live' && (r.endedOn || r.lastSeen) < cutoff) delete store[k];
  }
}
