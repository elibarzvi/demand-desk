// Market digest, posted to its own Slack channel.
//
// A different job from scripts/notify.mjs. Alerts interrupt and must stay rare;
// this is routine reading you open when you want it, so it always has content and
// lives in a separate channel. Mixing them would destroy the alert channel's only
// useful property, that a message there means something.
//
// Daily by default with a fuller edition on Mondays. Leads with a written read of
// what the numbers mean rather than opening with a table, because the point of a
// digest is the conclusion, not the data dump underneath it.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, readAllSnapshots, latestSnapshot } from '../src/lib/util.mjs';
import { buildAnalytics } from '../src/lib/analytics.mjs';

const SITE = 'https://elibarzvi.github.io/demand-desk/';
const SENT_FILE = path.join(ROOT, 'data', 'state', 'digest-sent.json');

const money = n => '$' + Number(n).toLocaleString('en-US');
const signed = n => (n > 0 ? '+' : '') + n.toFixed(1) + '%';

// A bare model name is ambiguous: "Boy", "Kelly" and "LOVE" mean nothing without
// the house. The brand is prepended unless the name already carries it.
const label = (model, brand) => {
  if (!brand) return model;
  const norm = t => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return norm(model).includes(norm(brand)) ? model : `${brand} ${model}`;
};

function readSent() { try { return JSON.parse(fs.readFileSync(SENT_FILE, 'utf8')); } catch { return {}; } }
function writeSent(o) {
  try { fs.mkdirSync(path.dirname(SENT_FILE), { recursive: true }); fs.writeFileSync(SENT_FILE, JSON.stringify(o, null, 2) + '\n'); }
  catch (e) { console.log('[digest] could not persist send state:', e.message); }
}

// The written read. Each rule states a conclusion and the number behind it, so
// the line is worth something on its own without opening the dashboard.
function readOut(a, weekly) {
  const bs = Object.entries(a.brands);
  const out = [];

  const tight = bs.filter(([, v]) => v.daysOfSupply != null).sort((x, y) => x[1].daysOfSupply - y[1].daysOfSupply)[0];
  const slack = bs.filter(([, v]) => v.daysOfSupply != null).sort((x, y) => y[1].daysOfSupply - x[1].daysOfSupply)[0];
  if (tight && slack && tight[0] !== slack[0]) {
    out.push(`*${tight[0]}* is the tightest shelf at ${tight[1].daysOfSupply} days of supply, clearing ${tight[1].soldPerDay}/day. *${slack[0]}* is the slackest at ${slack[1].daysOfSupply} days.`);
  }

  // A large positive clearing gap means the expensive end is what moves, so the
  // cheap end of that brand is the stock that sits.
  const gap = bs.filter(([, v]) => v.clearingGapPct != null && v.sampleSold >= 25)
    .sort((x, y) => Math.abs(y[1].clearingGapPct) - Math.abs(x[1].clearingGapPct))[0];
  if (gap && Math.abs(gap[1].clearingGapPct) >= 5) {
    const [b, v] = gap;
    out.push(v.clearingGapPct > 0
      ? `*${b}* is clearing ${signed(v.clearingGapPct)} above its shelf midpoint (${money(v.soldMedianPrice)} sold vs ${money(v.liveMedianPrice)} listed): the expensive end moves, the cheap end sits.`
      : `*${b}* is clearing ${signed(v.clearingGapPct)} below its shelf midpoint (${money(v.soldMedianPrice)} sold vs ${money(v.liveMedianPrice)} listed): buyers are taking the cheaper end.`);
  }

  const accel = bs.filter(([, v]) => v.velocityPct != null && v.sampleSold >= 25)
    .sort((x, y) => y[1].velocityPct - x[1].velocityPct)[0];
  if (accel && accel[1].velocityPct >= 15) {
    out.push(`*${accel[0]}* is accelerating: ${signed(accel[1].velocityPct)} more units cleared in the back half of the window than the front.`);
  }

  const flood = bs.filter(([, v]) => v.netFlowPerDay != null).sort((x, y) => y[1].netFlowPerDay - x[1].netFlowPerDay)[0];
  if (flood && flood[1].netFlowPerDay > 1) {
    out.push(`*${flood[0]}* inventory is growing ${flood[1].netFlowPerDay}/day net: more arriving than clearing.`);
  }

  const ms = Object.entries(a.models).filter(([, v]) => v.sold >= 3 && v.daysOfSupply != null);
  const hot = ms.sort((x, y) => x[1].daysOfSupply - y[1].daysOfSupply)[0];
  if (hot) out.push(`Fastest model: *${label(hot[0], hot[1].brand)}* at ${hot[1].daysOfSupply} days of supply, ${hot[1].sold} sold, median ${hot[1].medianDaysToSell}d on site.`);

  return out;
}

function compose(a, weekly) {
  const L = [];
  L.push(weekly
    ? `*Demand Desk weekly* · ${a.window.from} to ${a.window.to} · ${a.totalSold.toLocaleString('en-US')} sales tracked`
    : `*Demand Desk daily* · ${a.window.to} · ${a.window.days}-day window`);

  const read = readOut(a, weekly);
  if (read.length) { L.push(''); read.forEach(r => L.push(`• ${r}`)); }

  L.push('');
  L.push('*Shelf life by brand* (days of supply, lower is tighter)');
  Object.entries(a.brands).filter(([, v]) => v.daysOfSupply != null)
    .sort((x, y) => x[1].daysOfSupply - y[1].daysOfSupply)
    .forEach(([b, v]) => L.push(`• ${b}: ${v.daysOfSupply}d · ${v.soldPerDay}/day · median ${v.medianDaysToSell}d to sell · ${money(v.liveMedianPrice)}`));

  // The weekly edition adds the model table; the daily stays short on purpose.
  if (weekly) {
    const ms = Object.entries(a.models).filter(([, v]) => v.sold > 0)
      .sort((x, y) => y[1].sold - x[1].sold).slice(0, 8);
    if (ms.length) {
      L.push('');
      L.push('*Models by units sold*');
      ms.forEach(([m, v]) => L.push(`• ${label(m, v.brand)}: ${v.sold} sold · ${v.daysOfSupply != null ? v.daysOfSupply + 'd supply · ' : ''}median ${v.medianDaysToSell}d · ${money(v.medianPrice)}`));
    }
  }

  L.push('');
  L.push(`<${SITE}|Open the dashboard>`);
  return L.join('\n');
}

async function main() {
  const force = process.argv.includes('--force') || process.argv.includes('--test');
  const latest = latestSnapshot();
  if (!latest) { console.log('[digest] no snapshots'); return; }

  // The capture runs several times a day. Without this guard the Monday edition
  // sent on every Monday run, which is how two identical digests arrived on
  // 2026-08-31.
  const sent = readSent();
  if (!force && sent.lastDate === latest.date) { console.log(`[digest] already sent for ${latest.date}, skipping`); return; }

  const a = buildAnalytics(readAllSnapshots());
  if (!a) { console.log('[digest] sell-through has no comparable days yet, skipping'); return; }

  const weekly = new Date(latest.date + 'T00:00:00Z').getUTCDay() === 1;
  const text = compose(a, weekly);

  const hook = process.env.SLACK_DIGEST_WEBHOOK_URL;
  if (!hook) { console.log('[digest] SLACK_DIGEST_WEBHOOK_URL not set, would have sent:\n' + text); return; }

  const r = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, unfurl_links: false }) });
  if (r.ok) writeSent({ lastDate: latest.date, weekly });
  console.log(r.ok ? `[digest] sent ${weekly ? 'weekly' : 'daily'} edition for ${latest.date}` : `[digest] Slack rejected the post: HTTP ${r.status}`);
}

main().catch(e => console.log('[digest] skipped after error:', e.message));
