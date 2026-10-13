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
import { header, section, divider, context, table, message, post, money as fmtMoney } from '../src/lib/slack.mjs';

// The repo variable SITE_URL points Slack links at the site's current home (the byraph hub's
// Netlify copy once it moves); unset, it stays on GitHub Pages.
const SITE = process.env.SITE_URL || 'https://elibarzvi.github.io/demand-desk/';
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

// The order is the argument. What you can act on today goes first, because a
// digest that opens with a brand table trains you to skim past the part that
// would have made you money. The market read follows, then the tables.
function overdueBlocks() {
  let d;
  try { d = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'derived', 'overdue.json'), 'utf8')); }
  catch { return { lead: null, table: null, headline: null }; }

  const items = (d.items || []).filter(i => i.price >= 5000);
  if (!items.length) return { lead: null, table: null, headline: null };

  // A seller who has already cut is one who has started conceding, so those sort
  // first among equally overdue listings.
  const top = [...items].sort((a, b) =>
    ((b.markdownPct ?? 0) > 0) - ((a.markdownPct ?? 0) > 0) || b.overdueRatio - a.overdueRatio
  ).slice(0, 6);
  const cut = items.filter(i => (i.markdownPct ?? 0) > 0).length;

  const lead = `*${items.length} offer candidates* above $5,000 · past ${d.factor}x normal clearing time`
    + (cut ? ` · ${cut} already cut` : '');
  const tbl = table(top, [
      { key: 'brand', label: 'BRAND' },
      { key: 'currentPrice', label: 'PRICE', align: 'right', fmt: (v, r) => fmtMoney(v ?? r.price) },
      { key: 'markdownPct', label: 'CUT', align: 'right', fmt: v => (v > 0 ? `-${Math.round(v)}%` : '-') },
      { key: 'ageDays', label: 'DAYS', align: 'right' },
      { key: 'overdueRatio', label: 'VS NORM', align: 'right', fmt: v => `${v}x` },
      { key: 'title', label: 'ITEM', fmt: v => (v || '').slice(0, 38) }
    ]);
  const t = top[0];
  return { lead, table: tbl, headline: `${items.length} offer candidates · top: ${t.brand} ${fmtMoney(t.currentPrice ?? t.price)} at ${t.ageDays}d` };
}

// Renders a payload the way Slack roughly will, for dry runs and eyeballing.
function preview(payload) {
  return payload.blocks.map(b => {
    if (b.type === 'header') return '\n' + b.text.text.toUpperCase();
    if (b.type === 'divider') return '─'.repeat(72);
    if (b.type === 'context') return b.elements.map(e => e.text).join(' ');
    if (b.fields) return b.fields.map(f => f.text).join('\n');
    return b.text.text.replace(/```/g, '');
  }).join('\n');
}

function compose(a, weekly) {
  // Trimmed to the same principle as the alerts: Slack draws the app name and a
  // timestamp above this already, so a header block and a date line were saying
  // it a third time. What survives is the two tables and the written read, which
  // are the only parts that would be missed. Dividers went with the headers,
  // since a table against prose is already a visible edge.
  const od = overdueBlocks();
  const read = readOut(a, weekly);

  const shelf = Object.entries(a.brands).filter(([, v]) => v.daysOfSupply != null)
    .sort((x, y) => x[1].daysOfSupply - y[1].daysOfSupply)
    .map(([brand, v]) => ({ brand, ...v }));

  const lead = weekly
    ? `*Weekly* · ${a.window.from} to ${a.window.to} · ${a.totalSold.toLocaleString('en-US')} sales tracked`
    : `*Daily* · ${a.window.to} · ${a.window.days}-day window`;

  const blocks = [
    section(od.lead ? `${lead}\n${od.lead}` : lead),
    od.table,
    ...(read.length ? [section(read.map(r => `• ${r}`).join('\n'))] : []),
    table(shelf, [
      { key: 'brand', label: 'BRAND' },
      { key: 'daysOfSupply', label: 'SUPPLY', align: 'right', fmt: v => `${v}d` },
      { key: 'soldPerDay', label: '/DAY', align: 'right' },
      { key: 'medianDaysToSell', label: 'TO SELL', align: 'right', fmt: v => `${v}d` },
      { key: 'liveMedianPrice', label: 'MEDIAN', align: 'right', fmt: fmtMoney }
    ], '*Shelf life* · days of supply, lower is tighter')
  ];

  if (weekly) {
    const ms = Object.entries(a.models).filter(([, v]) => v.sold > 0)
      .sort((x, y) => y[1].sold - x[1].sold).slice(0, 8)
      .map(([model, v]) => ({ model: label(model, v.brand), ...v }));
    if (ms.length) {
      blocks.push(table(ms, [
          { key: 'model', label: 'MODEL' },
          { key: 'sold', label: 'SOLD', align: 'right' },
          { key: 'daysOfSupply', label: 'SUPPLY', align: 'right', fmt: v => v != null ? `${v}d` : '-' },
          { key: 'medianDaysToSell', label: 'TO SELL', align: 'right', fmt: v => `${v}d` },
          { key: 'medianPrice', label: 'MEDIAN', align: 'right', fmt: fmtMoney }
        ], '*Models by units sold*'));
    }
  }

  blocks.push(context(`<${SITE}|Open the dashboard>`));

  const preview = od.headline || (read[0] ? read[0].replace(/\*/g, '') : lead.replace(/\*/g, ''));
  return message(preview, blocks);
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
  const payload = compose(a, weekly);

  const hook = process.env.SLACK_DIGEST_WEBHOOK_URL;
  if (!hook) { console.log('[digest] SLACK_DIGEST_WEBHOOK_URL not set, would have sent:\n' + preview(payload)); return; }

  try {
    await post(hook, payload);
    writeSent({ lastDate: latest.date, weekly });
    console.log(`[digest] sent ${weekly ? 'weekly' : 'daily'} edition for ${latest.date} (${payload.blocks.length} blocks)`);
  } catch (e) {
    // Deliberately not recorded as sent, so the next run retries rather than
    // treating a rejected post as delivered.
    console.log(`[digest] Slack rejected the post: ${e.message}`);
  }
}

main().catch(e => console.log('[digest] skipped after error:', e.message));
