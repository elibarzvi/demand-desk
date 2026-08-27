// Weekly market digest, posted to its own Slack channel.
//
// This is deliberately a different job from scripts/notify.mjs. Alerts interrupt
// you and must stay rare, or they stop being read. A digest is routine reading you
// choose to open, so it goes to a separate channel and always has content. Mixing
// the two would destroy the alert channel's only useful property: that a message
// arriving there means something.
//
// Reports at model level (Birkin 25, not just Hermès), because that is the level a
// buying decision is actually made at. Requires SLACK_DIGEST_WEBHOOK_URL.
import { readAllSnapshots } from '../src/lib/util.mjs';
import { median } from '../src/lib/stats.mjs';

const SITE = 'https://elibarzvi.github.io/demand-desk/';
const WINDOW = 7;

const pct = (from, to) => (from == null || to == null || from === 0) ? null : ((to - from) / Math.abs(from)) * 100;
const money = n => '$' + Number(n).toLocaleString('en-US');
const signed = n => (n > 0 ? '+' : '') + n.toFixed(1) + '%';

function build(snaps) {
  const latest = snaps[snaps.length - 1];
  // The comparison point is the snapshot closest to a week back, not simply the
  // one seven files ago: a missed capture day would otherwise silently shorten
  // the window and overstate every change.
  const target = new Date(latest.date + 'T00:00:00Z');
  target.setUTCDate(target.getUTCDate() - WINDOW);
  const targetStr = target.toISOString().slice(0, 10);
  const older = [...snaps].reverse().find(s => s.date <= targetStr) || snaps[0];
  const spanDays = Math.round((new Date(latest.date) - new Date(older.date)) / 86400000);

  const modelsNow = new Map((latest.sources?.fashionphile?.models || []).map(m => [m.model, m]));
  const modelsThen = new Map((older.sources?.fashionphile?.models || []).map(m => [m.model, m]));

  // Units sold per model across the window, summed from each day's departures.
  const sold = {}, daysToSell = {};
  for (const s of snaps) {
    if (s.date <= older.date || s.date > latest.date) continue;
    for (const [model, v] of Object.entries(s.sources?.fp_sell_through?.byModel || {})) {
      sold[model] = (sold[model] || 0) + (v.sold || 0);
      if (v.medianDaysToSell != null) (daysToSell[model] ||= []).push(v.medianDaysToSell);
    }
  }

  const rows = [];
  for (const [model, now] of modelsNow) {
    const then = modelsThen.get(model);
    rows.push({
      model, brand: now.brand,
      live: now.live,
      liveDelta: then ? now.live - then.live : null,
      median: now.price?.median ?? null,
      medianPct: then ? pct(then.price?.median, now.price?.median) : null,
      sold: sold[model] || 0,
      daysToSell: median(daysToSell[model] || [])
    });
  }
  return { latest, older, spanDays, rows, hasSales: Object.keys(sold).length > 0 };
}

function compose(d) {
  const L = [];
  L.push(`*Demand Desk weekly, ${d.older.date} to ${d.latest.date}* (${d.spanDays} days)`);

  if (d.hasSales) {
    const top = d.rows.filter(r => r.sold > 0).sort((a, b) => b.sold - a.sold).slice(0, 5);
    if (top.length) {
      L.push('\n*Selling fastest*');
      for (const r of top) {
        L.push(`• ${r.model}: ${r.sold} sold${r.daysToSell != null ? `, median ${r.daysToSell}d on site` : ''}, now ${money(r.median)}`);
      }
    }
  } else {
    L.push('\n_Units sold appear once per-model sell-through has a full week of history._');
  }

  const priced = d.rows.filter(r => r.medianPct != null && Math.abs(r.medianPct) >= 1)
    .sort((a, b) => Math.abs(b.medianPct) - Math.abs(a.medianPct)).slice(0, 5);
  if (priced.length) {
    L.push('\n*Biggest price moves*');
    for (const r of priced) L.push(`• ${r.model}: ${money(r.median)}, ${signed(r.medianPct)}`);
  }

  const supply = d.rows.filter(r => r.liveDelta != null && r.liveDelta !== 0)
    .sort((a, b) => Math.abs(b.liveDelta) - Math.abs(a.liveDelta)).slice(0, 5);
  if (supply.length) {
    L.push('\n*Supply shifts* (listings on hand)');
    for (const r of supply) L.push(`• ${r.model}: ${r.live} live, ${r.liveDelta > 0 ? '+' : ''}${r.liveDelta}`);
  }

  L.push(`\n<${SITE}|Open the dashboard>`);
  return L.join('\n');
}

async function main() {
  const force = process.argv.includes('--force') || process.argv.includes('--test');
  // Mondays only, so a daily workflow can call this unconditionally.
  if (!force && new Date().getUTCDay() !== 1) { console.log('[digest] not Monday, skipping'); return; }

  const snaps = readAllSnapshots();
  if (snaps.length < 2) { console.log('[digest] need at least two snapshots'); return; }

  const d = build(snaps);
  if (!d.rows.length) { console.log('[digest] no model data yet, skipping'); return; }
  const text = compose(d);

  const hook = process.env.SLACK_DIGEST_WEBHOOK_URL;
  if (!hook) { console.log('[digest] SLACK_DIGEST_WEBHOOK_URL not set, would have sent:\n' + text); return; }

  const r = await fetch(hook, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, unfurl_links: false })
  });
  console.log(r.ok ? `[digest] sent (${d.rows.length} models)` : `[digest] Slack rejected the post: HTTP ${r.status}`);
}

main().catch(e => console.log('[digest] skipped after error:', e.message));
