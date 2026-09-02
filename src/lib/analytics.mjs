// Second-order analytics: the questions the raw series cannot answer on their own.
//
// A daily turnover percentage tells you what cleared yesterday. It does not tell
// you how long the shelf lasts at that rate, whether the market is paying above or
// below the asking midpoint, or whether velocity is improving. Those are the
// numbers a buying decision actually turns on, and they are all derivable from
// data already captured.
import { median, mean } from './stats.mjs';

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
