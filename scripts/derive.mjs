// Turns the append-only snapshot log into a decision layer:
//   data/derived/metrics.json  : every tracked series with baseline, z-score, streaks
//   data/derived/alerts.json   : only what broke out of its own normal range today
//   data/exports/alerts.csv    : the same alerts as a tidy time-series
//   data/exports/fp-sold.csv   : permanent per-item sell-through event log
//
// The daily numbers alone never answered "is this unusual"; every series was shown
// at face value with no sense of its own history. Everything below exists to score
// today against that history instead.
import path from 'node:path';
import crypto from 'node:crypto';
import { EXPORT_DIR, ROOT, readAllSnapshots, writeFile, toCsv } from '../src/lib/util.mjs';
import { describe, median } from '../src/lib/stats.mjs';

const DERIVED_DIR = path.join(ROOT, 'data', 'derived');

// Each extractor pulls one metric per brand out of a snapshot. Returning null or
// omitting a brand simply leaves a gap; describe() ignores gaps.
const SERIES = {
  // Supply. `listingsAll` spans the whole history (all categories, what the
  // original capture recorded); `listings` is the newer single-segment count.
  'fp.listingsAll':   { label: 'Fashionphile listings (all categories)', dir: 'supply',
    get: s => (s.sources?.fashionphile?.focus || []).map(f => [f.brand, f.liveAll ?? f.count ?? null]) },
  'fp.listings':      { label: 'Fashionphile listings (tracked segment)', dir: 'supply',
    get: s => (s.sources?.fashionphile?.focus || []).map(f => [f.brand, f.live ?? null]) },
  'fp.medianPrice':   { label: 'Fashionphile median price', dir: 'price',
    get: s => (s.sources?.fashionphile?.focus || []).map(f => [f.brand, f.price?.median ?? null]) },
  'fp.p90Price':      { label: 'Fashionphile 90th-pct price', dir: 'price',
    get: s => (s.sources?.fashionphile?.focus || []).map(f => [f.brand, f.price?.p90 ?? null]) },
  'fp.turnover':      { label: 'Daily sell-through %', dir: 'demand',
    get: s => Object.entries(s.sources?.fp_sell_through?.brands || {}).map(([b, v]) => [b, v.turnoverPct ?? null]) },
  'fp.daysToSell':    { label: 'Median days to sell', dir: 'demand-inverse',
    get: s => Object.entries(s.sources?.fp_sell_through?.brands || {}).map(([b, v]) => [b, v.medianDaysToSell ?? null]) },
  'ebay.listings':    { label: 'eBay active listings', dir: 'supply',
    get: s => (s.sources?.ebay?.focus || []).map(f => [f.brand, f.total ?? null]) },
  'trends.interest':  { label: 'Google Trends relative interest', dir: 'demand',
    get: s => {
      // Trends values captured before the shared-anchor fix were normalized within
      // their own batch. Batch-one brands were already on the anchor's scale, but
      // the rest were not, so their pre-fix points must not share a baseline with
      // post-fix ones. Drop them rather than splice two different scales.
      // Only the relative index is a valid time series. Raw last-values were
      // renormalized by Google on every request, so points captured before `rel`
      // existed cannot share a baseline with points after it and are dropped
      // rather than spliced onto a different scale.
      return (s.sources?.google_trends?.focus || []).map(f => {
        const rel = (f.rel || []).slice(-1)[0]?.value ?? null;
        return [f.brand, rel];
      });
    } },
  // Captured and charted, but excluded from alerting. Search volume is a monthly
  // average, so its only movement is a bucket rollover, and StockX's "lowest ask"
  // is the cheapest object a brand sells (Chanel reads $35, which is a sticker,
  // not a bag). Alerting on either produces confident noise.
  'search.volume':    { label: 'Monthly search volume', dir: 'demand', alert: false,
    get: s => (s.sources?.search_volume?.focus || []).map(f => [f.brand, f.volume ?? null]) },
  'stockx.low':       { label: 'StockX lowest ask', dir: 'price', alert: false,
    get: s => (s.sources?.stockx_brands?.focus || []).map(f => [f.brand, f.low ?? null]) }
};

// Brands that sat in the second Trends batch and were therefore rescaled by the
// anchor fix; batch-one brands keep a continuous history.
const RESCALED_BRANDS = new Set(['Dior', 'Hermès', 'Fendi', 'The Row']);

function buildSeries(snaps) {
  const out = {};
  for (const [key, def] of Object.entries(SERIES)) {
    const byBrand = {};
    for (const s of snaps) {
      let rows = [];
      try { rows = def.get(s) || []; } catch { rows = []; }
      for (const [brand, value] of rows) {
        if (!brand) continue;
        (byBrand[brand] ||= []).push({ date: s.date, value: typeof value === 'number' ? value : null });
      }
    }
    out[key] = { label: def.label, dir: def.dir, alert: def.alert !== false, brands: byBrand };
  }
  return out;
}


// Sources that publish on their own slow schedule are excluded: they are supposed
// to sit still between editions.
const PERIODIC = new Set(['indices', 'therealreal', 'vestiaire']);

// Walk the snapshot history and count, per source, how many consecutive days its
// payload has been byte-identical up to the most recent day.
function staleness(snaps) {
  const fp = src => {
    if (!src) return null;
    const { status, capturedAt, fetchedOn, carriedFrom, error, errors, segmentErrors, ...rest } = src;
    return crypto.createHash('sha1').update(JSON.stringify(rest)).digest('hex').slice(0, 12);
  };
  const names = new Set();
  snaps.forEach(s => Object.keys(s.sources || {}).forEach(n => names.add(n)));

  const out = [];
  for (const name of names) {
    if (PERIODIC.has(name)) continue;
    const seq = snaps.map(s => ({ date: s.date, h: fp(s.sources?.[name]) })).filter(x => x.h);
    if (seq.length < 2) continue;
    let unchanged = 0, lastChanged = null;
    for (let i = seq.length - 1; i > 0; i--) {
      if (seq[i].h === seq[i - 1].h) unchanged++;
      else { lastChanged = seq[i].date; break; }
    }
    out.push({ source: name, unchangedDays: unchanged, lastChanged, days: seq.length });
  }
  return out.sort((a, b) => b.unchangedDays - a.unchangedDays);
}

// ---- Alerts -------------------------------------------------------------
// Thresholds are deliberately conservative. An alert that fires most days is
// noise, and noise is what makes a dashboard stop being read.
const Z_BREAKOUT = 2;
const MIN_N_FOR_Z = 8;
const STREAK_MIN = 4;
const WOW_MIN = 15;     // percent
const STALE_DAYS = 3;
// A z-score says a move is statistically unusual; it does not say the move is
// worth reading. eBay listing counts are so stable (a standard deviation near 1%
// of the mean) that a 2.3% drift cleared z=2 and was reported as a breakout.
// Requiring real magnitude as well as significance is what separates a signal
// from an arithmetic curiosity.
const MIN_MOVE_PCT = 4;
// Bounded 0-100 index series need a floor too. Goyard's Trends interest sits near
// 21, so one integer point is 4.8% and a routine 4-point wobble looked like a
// -19% collapse. Below this level, percentage moves are granularity, not demand.
const MIN_LEVEL = { 'trends.interest': 0.25 };   // relative index centres on 1.0

function buildAlerts(series, latest, snaps) {
  const alerts = [];
  const push = (a) => alerts.push({ date: latest.date, ...a });

  for (const [key, def] of Object.entries(series)) {
    if (!def.alert) continue;
    for (const [brand, points] of Object.entries(def.brands)) {
      const d = describe(points);
      if (!d || d.lastDate !== latest.date) continue;

      // Series whose level is too low for percentages to mean anything are skipped
      // entirely rather than alerted on with a caveat.
      const floor = MIN_LEVEL[key] ?? 0;
      if (d.baselineMean != null && d.baselineMean < floor) continue;

      const moved = d.baselinePct != null && Math.abs(d.baselinePct) >= MIN_MOVE_PCT;
      if (d.z != null && Math.abs(d.z) >= Z_BREAKOUT && d.n >= MIN_N_FOR_Z && moved) {
        push({ type: 'breakout', severity: Math.abs(d.z) >= 3 ? 'high' : 'medium', series: key, metric: def.label, brand,
          value: d.last, z: d.z, baseline: d.baselineMean, changePct: d.baselinePct,
          message: `${brand} ${def.label} at ${d.last} is ${d.baselinePct > 0 ? '+' : ''}${d.baselinePct}% vs its ${d.n}-day normal of ${d.baselineMean} (z=${d.z}).` });
      }
      if (Math.abs(d.streak) >= STREAK_MIN && moved) {
        push({ type: 'streak', severity: 'low', series: key, metric: def.label, brand,
          value: d.last, streak: d.streak,
          message: `${brand} ${def.label} has ${d.streak > 0 ? 'risen' : 'fallen'} ${Math.abs(d.streak)} days straight to ${d.last}.` });
      }
      if (d.wowPct != null && Math.abs(d.wowPct) >= WOW_MIN) {
        push({ type: 'weekly-move', severity: Math.abs(d.wowPct) >= 30 ? 'medium' : 'low', series: key, metric: def.label, brand,
          value: d.last, wowPct: d.wowPct,
          message: `${brand} ${def.label} moved ${d.wowPct > 0 ? '+' : ''}${d.wowPct}% in 7 days to ${d.last}.` });
      }
    }
  }

  // A source that stops changing is the failure mode this log actually suffered:
  // Mirror's request feed sat identical for weeks while being presented as live.
  // Computed from the snapshot history rather than a stored counter, so it is
  // correct for days captured before freshness tracking existed.
  for (const f of staleness(snaps)) {
    if (f.unchangedDays >= STALE_DAYS) {
      push({ type: 'stale-source', severity: f.unchangedDays >= 7 ? 'high' : 'medium', series: f.source, brand: null,
        unchangedDays: f.unchangedDays, lastChanged: f.lastChanged,
        message: `Source "${f.source}" has returned identical data for ${f.unchangedDays} consecutive days (last change ${f.lastChanged || 'before this log began'}).` });
    }
  }

  const rank = { high: 0, medium: 1, low: 2 };

  // One condition, one alert. A single move in Louis Vuitton's Trends interest was
  // reported three times over on 2026-08-30 (breakout, streak and weekly-move),
  // which pads the count and makes a quiet day look busy. Keep the most
  // informative alert per series and brand: a breakout states the size of the
  // move, a weekly move states its direction over time, a streak only its length.
  const TYPE_RANK = { 'breakout': 0, 'weekly-move': 1, 'streak': 2 };
  const best = new Map();
  const passthrough = [];
  for (const a of alerts) {
    if (!(a.type in TYPE_RANK)) { passthrough.push(a); continue; }   // stale-source etc.
    const k = `${a.series}|${a.brand ?? ''}`;
    const cur = best.get(k);
    if (!cur || TYPE_RANK[a.type] < TYPE_RANK[cur.type]) best.set(k, a);
  }
  const merged = [...passthrough, ...best.values()];
  return merged.sort((a, b) => rank[a.severity] - rank[b.severity] || Math.abs(b.z ?? 0) - Math.abs(a.z ?? 0));
}

// ---- Signals ------------------------------------------------------------
// The one number worth acting on: demand rising while supply falls. Both sides
// are expressed as z-scores against each series' own history, so a brand with
// 5000 listings and one with 150 are directly comparable.
function buildSignals(series) {
  const brands = new Set();
  for (const def of Object.values(series)) Object.keys(def.brands).forEach(b => brands.add(b));

  const rows = [];
  for (const brand of brands) {
    const z = key => {
      const pts = series[key]?.brands?.[brand];
      if (!pts) return null;
      const d = describe(pts);
      return (d && d.n >= MIN_N_FOR_Z) ? d.z : null;
    };
    const val = key => {
      const pts = series[key]?.brands?.[brand];
      const d = pts && describe(pts);
      return d ? d.last : null;
    };

    const demandZ = z('trends.interest');
    const supplyZ = z('fp.listingsAll') ?? z('ebay.listings');
    const turnover = val('fp.turnover');

    // Scarcity = demand momentum minus supply momentum. Positive means demand is
    // running ahead of the supply arriving to meet it.
    const scarcity = (demandZ != null && supplyZ != null) ? +(demandZ - supplyZ).toFixed(2) : null;

    rows.push({
      brand, demandZ, supplyZ, scarcity, turnoverPct: turnover,
      medianPrice: val('fp.medianPrice'),
      medianDaysToSell: val('fp.daysToSell'),
      listings: val('fp.listingsAll'),
      interest: val('trends.interest')
    });
  }
  return rows.filter(r => r.scarcity != null).sort((a, b) => b.scarcity - a.scarcity)
    .concat(rows.filter(r => r.scarcity == null));
}

// ---- Sell-through event log --------------------------------------------
function sellThroughRows(snaps) {
  const rows = [];
  for (const s of snaps) {
    for (const [brand, v] of Object.entries(s.sources?.fp_sell_through?.brands || {})) {
      for (const e of v.events || []) {
        rows.push({ date: s.date, brand, sku: e.sku, price: e.price ?? '', listed: e.listed ?? '',
          days_to_sell: e.days ?? '', observed_days: e.observedDays ?? '' });
      }
    }
  }
  return rows;
}

function build() {
  const snaps = readAllSnapshots();
  if (!snaps.length) { console.log('[derive] no snapshots'); return; }
  const latest = snaps[snaps.length - 1];

  const series = buildSeries(snaps);
  const alerts = buildAlerts(series, latest, snaps);
  const signals = buildSignals(series);

  // Collapse each series to its metric bundle for the site payload.
  const metrics = {};
  for (const [key, def] of Object.entries(series)) {
    metrics[key] = { label: def.label, dir: def.dir, alert: def.alert, brands: {} };
    for (const [brand, points] of Object.entries(def.brands)) {
      const d = describe(points);
      if (d) metrics[key].brands[brand] = { ...d, points };
    }
  }

  const soldRows = sellThroughRows(snaps);
  const daysToSell = soldRows.map(r => Number(r.days_to_sell)).filter(n => Number.isFinite(n));

  writeFile(path.join(DERIVED_DIR, 'metrics.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    firstDate: snaps[0].date, lastDate: latest.date, days: snaps.length,
    metrics, signals, freshness: staleness(snaps)
  }, null, 2) + '\n');

  writeFile(path.join(DERIVED_DIR, 'alerts.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), date: latest.date, count: alerts.length, alerts
  }, null, 2) + '\n');

  writeFile(path.join(EXPORT_DIR, 'alerts.csv'),
    toCsv(['date', 'type', 'severity', 'series', 'brand', 'value', 'z', 'message'],
      alerts.map(a => ({ date: a.date, type: a.type, severity: a.severity, series: a.series,
        brand: a.brand ?? '', value: a.value ?? '', z: a.z ?? '', message: a.message }))));

  writeFile(path.join(EXPORT_DIR, 'fp-sold.csv'),
    toCsv(['date', 'brand', 'sku', 'price', 'listed', 'days_to_sell', 'observed_days'], soldRows));

  writeFile(path.join(EXPORT_DIR, 'signals.csv'),
    toCsv(['brand', 'scarcity', 'demand_z', 'supply_z', 'turnover_pct', 'median_price', 'median_days_to_sell', 'listings', 'interest'],
      signals.map(s => ({ brand: s.brand, scarcity: s.scarcity ?? '', demand_z: s.demandZ ?? '', supply_z: s.supplyZ ?? '',
        turnover_pct: s.turnoverPct ?? '', median_price: s.medianPrice ?? '', median_days_to_sell: s.medianDaysToSell ?? '',
        listings: s.listings ?? '', interest: s.interest ?? '' }))));

  console.log(`[derive] ${Object.keys(metrics).length} series · ${alerts.length} alerts `
    + `(${alerts.filter(a => a.severity === 'high').length} high) · ${signals.length} brands scored · `
    + `${soldRows.length} sell-through events${daysToSell.length ? ` (median ${median(daysToSell)}d to sell)` : ''}`);
}

build();
