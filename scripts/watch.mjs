// Grail watcher. Hunts individual listings across marketplaces and reports three
// events: a new eligible listing, a price drop to a new low, and a listing that
// left the market (confirmed sold on Fashionphile, "no longer listed" on eBay).
//
//   npm run watch            report only, nothing sent, state not saved
//   npm run watch -- --send  post to Slack and remember what was sent
//
// Posts to SLACK_WATCH_WEBHOOK_URL if set, otherwise the alerts channel, so
// buying signals can live in their own channel without being required to.
import { WATCHES, applyWatch } from '../src/lib/watchlist.mjs';
import { SOURCES } from '../src/lib/watch-sources.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/lib/util.mjs';
import { readStore, writeStore, reconcile, settle, prune } from '../src/lib/watch-store.mjs';

// Listings the rules held back, with the reason. A current snapshot rather than a
// tracked history: they never alert, but seeing them is how the rules get tuned.
// The first live run held back 19 eBay listings, including a $52,000 pair from a
// seller with three ratings, and none of that was visible anywhere.
const HELD_FILE = path.join(ROOT, 'data', 'state', 'watch-held.json');
function writeHeld(held) {
  fs.mkdirSync(path.dirname(HELD_FILE), { recursive: true });
  fs.writeFileSync(HELD_FILE, JSON.stringify({ _meta: { updatedAt: new Date().toISOString() }, items: held }, null, 2) + '\n');
}
const reasonOf = f => f.verdict === 'over-cap'
  ? 'asks above the credibility cap'
  : (f.concerns || []).join(', ') || f.verdict;

const SITE = 'https://elibarzvi.github.io/demand-desk/';
const money = n => n == null ? '?' : '$' + Math.round(Number(n)).toLocaleString('en-US');
const MAX_CHECKS = 40;   // bound the per-run lookups for listings that went missing

function line(e) {
  const link = e.url ? `<${e.url}|${(e.title || '').slice(0, 78)}>` : (e.title || '').slice(0, 78);
  const target = e.underTarget ? '  *UNDER TARGET*' : '';
  switch (e.type) {
    case 'new':  return `NEW  ${money(e.price)}  ${link}${target}${e.listed ? `\n      listed ${e.listed} · ${e.source}` : ` · ${e.source}`}`;
    case 'drop': return `PRICE DROP  ${money(e.from)} → ${money(e.to)} (-${e.dropPct}%)  ${link}${target}`;
    case 'sold': return `SOLD  ${money(e.price)}  ${link}${e.daysOnMarket != null ? `  · ${e.daysOnMarket}d on market` : ''}`;
    case 'gone': return `NO LONGER LISTED  ${money(e.price)}  ${link}  · sold or withdrawn, eBay does not say which`;
  }
}

async function main() {
  const send = process.argv.includes('--send');
  const date = new Date().toISOString().slice(0, 10);
  const store = readStore();
  const out = [];
  const held = [];

  for (const w of WATCHES.filter(w => w.enabled !== false)) {
    const src = SOURCES[w.source];
    if (!src) { console.log(`[watch] ${w.id}: unknown source "${w.source}"`); continue; }

    let items = [];
    try { items = await src.search(w); }
    catch (e) { console.log(`[watch] ${w.id}: search failed, skipping this run: ${e.message}`); continue; }

    const { matches, flagged } = applyWatch(items, w);
    for (const f of flagged) {
      held.push({ watch: w.id, source: f.source, id: f.id, title: f.title, url: f.url, image: f.image ?? null,
        price: f.price, condition: f.condition ?? null, listed: f.listed ?? null,
        seller: f.seller ?? null, sellerPct: f.sellerPct ?? null, sellerScore: f.sellerScore ?? null,
        verdict: f.verdict, reason: reasonOf(f) });
    }
    const { events, missing, seeding } = reconcile(store, w, matches, date);

    // Confirm listings that disappeared before saying anything about them.
    for (const k of missing.slice(0, MAX_CHECKS)) {
      let verdict = { state: 'unknown' };
      try { verdict = await src.confirm(store[k]); } catch { /* stays unknown */ }
      const ev = settle(store, w, k, verdict, date);
      if (ev) events.push(ev);
    }

    console.log(`[watch] ${w.id}: ${items.length} scanned, ${matches.length} eligible, ${flagged.length} held back`
      + (seeding ? `, first run so ${matches.length} standing listings recorded silently` : '')
      + `, ${events.length} event(s)`);
    for (const e of events) console.log('   ' + line(e).replace(/<([^|]+)\|([^>]+)>/g, '$2'));

    if (seeding && matches.length) {
      const top = [...matches].sort((a, b) => b.price - a.price).slice(0, 3);
      events.unshift({ type: 'seed', count: matches.length, top });
    }
    if (events.length) out.push({ w, events });
  }

  prune(store, date);

  if (!out.length) {
    console.log('[watch] nothing to report');
    if (send) { writeStore(store); writeHeld(held); }
    return;
  }

  const blocks = out.map(({ w, events }) => {
    const rows = [];
    for (const e of events) {
      if (e.type === 'seed') {
        rows.push(`Now watching ${e.count} standing listings. From here on you hear about new ones, price drops and sales. Highest now: `
          + e.top.map(t => `${money(t.price)} <${t.url}|${t.title.slice(0, 50)}>`).join(', '));
      } else rows.push(line(e));
    }
    const cap = w.maxAlertsPerRun ?? 12;
    const held = rows.length > cap ? rows.length - cap : 0;
    return `*${w.label}*\n` + rows.slice(0, cap).map(r => `• ${r}`).join('\n') + (held ? `\n• plus ${held} more in the run log` : '');
  });
  const text = `*Demand Desk watch* · ${date}\n\n` + blocks.join('\n\n') + `\n\n<${SITE}|Open the dashboard>`;

  if (!send) { console.log(`\n[watch] dry run, would have sent:\n${text}`); return; }

  const hook = process.env.SLACK_WATCH_WEBHOOK_URL || process.env.SLACK_WEBHOOK_URL;
  if (!hook) { console.log('[watch] no Slack webhook set, nothing sent'); return; }
  const r = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, unfurl_links: false }) });
  // Persist only after delivery, so a failed post is retried rather than lost.
  if (r.ok) { writeStore(store); writeHeld(held); }
  console.log(r.ok ? `[watch] sent ${out.reduce((a, o) => a + o.events.length, 0)} event(s)` : `[watch] Slack rejected the post: HTTP ${r.status}`);
}

main().catch(e => { console.log('[watch] failed:', e.message); process.exitCode = 1; });
