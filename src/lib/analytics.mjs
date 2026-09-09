// Second-order analytics: the questions the raw series cannot answer on their own.
//
// A daily turnover percentage tells you what cleared yesterday. It does not tell
// you how long the shelf lasts at that rate, whether the market is paying above or
// below the asking midpoint, or whether velocity is improving. Those are the
// numbers a buying decision actually turns on, and they are all derivable from
// data already captured.
import { median, mean } from './stats.mjs';
import { BRANDS } from './tracking.mjs';

const pct = (from, to) => (from == null || to == null || from === 0) ? null : +(((to - from) / Math.abs(from)) * 100).toFixed(1);

// Pool departure events across a window. A single day's sales are too few per
// brand to read a median price from, so anything price-based uses the pool.
function poolEvents(snaps, pick) {
  const out = [];
  for (const s of snaps) {
    for (const [brand, v] of Object.entries(s.sources?.fp_sell_through?.brands || {})) {
      for (const e of v.events || []) out.push({ brand, date: s.date, ...e });
    }
  }
  return pick ? out.filter(pick) : out;
}

export function buildAnalytics(snaps, windowDays = 14) {
  const live = snaps.filter(s => s.sources?.fp_sell_through?.status === 'ok');
  if (!live.length) return null;

  const win = live.slice(-windowDays);
  const latest = snaps[snaps.length - 1];
  const events = poolEvents(win);
  const fpNow = latest.sources?.fashionphile?.focus || [];
  const modelsNow = latest.sources?.fashionphile?.models || [];

  const brands = {};
  for (const f of fpNow) {
    const b = f.brand;
    const daily = win.map(s => s.sources.fp_sell_through.brands[b]?.departures).filter(n => n != null);
    if (!daily.length) continue;

    const perDay = mean(daily);
    const liveCount = f.live ?? null;
    const mine = events.filter(e => e.brand === b);
    const soldMedian = median(mine.map(e => e.price).filter(p => p != null));
    const daysMedian = median(mine.map(e => e.days).filter(d => d != null));

    // Velocity direction: compare the two halves of the window rather than two
    // single days, which would be mostly noise at these volumes.
    const half = Math.floor(daily.length / 2);
    const early = mean(daily.slice(0, half)), late = mean(daily.slice(half));

    const arrivals = win.map(s => s.sources.fp_sell_through.brands[b]?.arrivals).filter(n => n != null);

    brands[b] = {
      live: liveCount,
      soldPerDay: perDay != null ? +perDay.toFixed(1) : null,
      // How long the current shelf lasts at the current clearing rate. The single
      // most useful framing of turnover: 32 days of supply is a tight market,
      // 48 days is a slack one, and the raw percentages hide that difference.
      daysOfSupply: (perDay && liveCount != null) ? Math.round(liveCount / perDay) : null,
      velocityPct: pct(early, late),
      medianDaysToSell: daysMedian,
      soldMedianPrice: soldMedian,
      liveMedianPrice: f.price?.median ?? null,
      // Where the market actually transacts relative to the middle of the shelf.
      // Negative means buyers are clearing the cheaper end; strongly positive
      // means the expensive end is what moves and cheap stock is what lingers.
      clearingGapPct: pct(f.price?.median, soldMedian),
      arrivalsPerDay: arrivals.length ? +mean(arrivals).toFixed(1) : null,
      netFlowPerDay: (arrivals.length && perDay != null) ? +(mean(arrivals) - perDay).toFixed(1) : null,
      sampleSold: mine.length
    };
  }

  const models = {};
  for (const m of modelsNow) {
    const sold = win.reduce((a, s) => a + (s.sources.fp_sell_through?.byModel?.[m.model]?.sold || 0), 0);
    const mine = events.filter(e => e.model === m.model);
    const perDay = sold / win.length;
    models[m.model] = {
      brand: m.brand,
      live: m.live ?? null,
      sold,
      soldPerDay: +perDay.toFixed(2),
      daysOfSupply: (perDay > 0 && m.live != null) ? Math.round(m.live / perDay) : null,
      medianDaysToSell: median(mine.map(e => e.days).filter(d => d != null)),
      medianPrice: m.price?.median ?? null,
      soldMedianPrice: median(mine.map(e => e.price).filter(p => p != null))
    };
  }

  return {
    window: { from: win[0].date, to: win[win.length - 1].date, days: win.length },
    totalSold: events.length,
    brands, models
  };
}

// ---- Core affinity ---------------------------------------------------------
// The question behind the brand tiers is "what else are our customers buying".
// Nothing here can answer that literally: Fashionphile's index exposes listings
// and departures, never a buyer, so there is no basket and no way to know that
// one person bought both a Kelly and a Cassette.
//
// What IS measurable is co-movement. If a candidate brand's demand rises and
// falls in step with the core basket day after day, that is evidence the same
// population is driving both. If it moves independently, it is a different
// audience however well it sells. That is an inference from correlation, not an
// observation of customers, and it should be read as such.
function pearson(a, b) {
  const pairs = a.map((v, i) => [v, b[i]]).filter(([x, y]) => x != null && y != null);
  if (pairs.length < 5) return null;
  const xs = pairs.map(p => p[0]), ys = pairs.map(p => p[1]);
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < xs.length; i++) {
    const a1 = xs[i] - mx, b1 = ys[i] - my;
    num += a1 * b1; dx += a1 * a1; dy += b1 * b1;
  }
  if (!dx || !dy) return null;
  return { r: +(num / Math.sqrt(dx * dy)).toFixed(2), n: pairs.length };
}

// Correlation needs a lot more history than a level does. Below this, report the
// number but mark it provisional rather than letting it drive a decision.
const RELIABLE_N = 21;

export function coreAffinity(snaps) {
  const core = BRANDS.filter(b => b.tier === 'core').map(b => b.name);
  const all = BRANDS.map(b => b.name);
  if (core.length < 2) return null;

  // Only turnover is usable here. The Trends relative index is each brand divided
  // by the mean across brands, so the values are constrained to average one and
  // any component is forced to anti-correlate with the rest: every brand scored
  // between -0.98 and -1.00 against the basket, which is arithmetic, not demand.
  // Compositional series cannot be correlated this way.
  const read = (s, b) => s.sources?.fp_sell_through?.brands?.[b]?.turnoverPct ?? null;

  const raw = {};
  for (const b of all) raw[b] = snaps.map(s => read(s, b));

  // Remove the platform-wide rhythm before correlating. Fashionphile has busy and
  // quiet days that lift or depress every brand at once, and left in, that common
  // factor makes unrelated brands look like they share an audience. What matters
  // is whether a brand is strong on the days the core is strong, relative to how
  // the whole site behaved that day.
  const dayMean = snaps.map((_, i) => {
    const vals = all.map(b => raw[b][i]).filter(v => v != null);
    return vals.length >= 3 ? mean(vals) : null;
  });
  const series = {};
  for (const b of all) {
    series[b] = raw[b].map((v, i) => (v == null || dayMean[i] == null) ? null : v - dayMean[i]);
  }

  const basket = snaps.map((_, i) => {
    const vals = core.map(b => series[b][i]).filter(v => v != null);
    return vals.length === core.length ? mean(vals) : null;
  });

  const out = {};
  for (const b of all) {
    if (core.includes(b)) continue;
    const c = pearson(series[b], basket);
    if (c) out[b] = { turnover: c };
  }

  return {
    core,
    basis: 'co-movement of sell-through with the core basket after removing the platform-wide daily rhythm; not customer-level data',
    brands: Object.fromEntries(Object.entries(out).map(([b, v]) =>
      [b, { r: v.turnover.r, n: v.turnover.n, reliable: v.turnover.n >= RELIABLE_N }]))
  };
}
