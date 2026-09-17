// Grail watcher: searches eBay item by item and reports listings that match a
// curated rule set, rather than the aggregate statistics the rest of the pipeline
// produces.
//
// Alerts only on listings not seen before, because a watch that re-reports the
// same standing listing every few hours is a watch nobody reads. Seen listings are
// remembered in data/state/watch-seen.json.
//
//   npm run watch            report only, nothing sent
//   npm run watch -- --send  post new matches to Slack
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/lib/util.mjs';
import { WATCHES, applyWatch } from '../src/lib/watchlist.mjs';

const SEEN_FILE = path.join(ROOT, 'data', 'state', 'watch-seen.json');
const SITE = 'https://elibarzvi.github.io/demand-desk/';
const KEEP_DAYS = 60;

const money = n => '$' + Number(n).toLocaleString('en-US');
const readSeen = () => { try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')); } catch { return {}; } };
function writeSeen(o) {
  fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify(o, null, 2) + '\n');
}

async function token() {
  const id = process.env.EBAY_CLIENT_ID, secret = process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) throw new Error('eBay credentials not set');
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope')
  });
  if (!r.ok) throw new Error(`eBay OAuth HTTP ${r.status}`);
  return (await r.json()).access_token;
}

async function search(tok, q, minPrice) {
  const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search'
    + '?q=' + encodeURIComponent(q)
    + '&limit=100&sort=-price'
    + '&filter=' + encodeURIComponent(`buyingOptions:{FIXED_PRICE},price:[${minPrice || 1}..],priceCurrency:USD`)
    + '&fieldgroups=EXTENDED';
  const r = await fetch(url, { headers: { 'Authorization': `Bearer ${tok}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).itemSummaries || [];
}

async function main() {
  const send = process.argv.includes('--send');
  const active = WATCHES.filter(w => w.enabled !== false);
  if (!active.length) { console.log('[watch] no enabled watches'); return; }

  const tok = await token();
  const seen = readSeen();
  const today = new Date().toISOString().slice(0, 10);
  const fresh = [];

  for (const w of active) {
    const items = [];
    for (const q of w.queries || []) {
      try { items.push(...await search(tok, q, w.minPrice)); }
      catch (e) { console.log(`[watch] query "${q}" failed: ${e.message}`); }
    }
    const { matches, flagged } = applyWatch(items, w);
    console.log(`[watch] ${w.id}: scanned ${items.length} listings, ${matches.length} match, ${flagged.length} flagged`);

    for (const m of matches) {
      const key = `${w.id}|${m.itemId}`;
      if (seen[key]) continue;
      seen[key] = today;
      fresh.push(m);
    }
    for (const f of flagged) console.log(`   flagged [${f.verdict}] ${money(f.price)} ${f.title.slice(0, 60)}`);
    for (const m of matches) console.log(`   ${seen[`${w.id}|${m.itemId}`] === today ? 'NEW ' : '    '}${money(m.price)} ${m.title.slice(0, 60)}`);
  }

  // Forget listings we have not seen in a while so the file cannot grow forever.
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  for (const [k, d] of Object.entries(seen)) if (d < cutoff) delete seen[k];

  if (!fresh.length) { console.log('[watch] nothing new'); writeSeen(seen); return; }

  const text = `*Demand Desk grail watch* · ${fresh.length} new listing${fresh.length > 1 ? 's' : ''}\n`
    + fresh.map(m => `• ${money(m.price)} <${m.url}|${m.title.slice(0, 80)}>\n   ${m.condition || 'condition unstated'} · seller ${m.seller} ${m.sellerPct != null ? `(${m.sellerPct}%)` : ''}`).join('\n')
    + `\n<${SITE}|Open the dashboard>`;

  const hook = process.env.SLACK_WEBHOOK_URL;
  if (!send) { console.log(`\n[watch] dry run, would have sent:\n${text}`); return; }
  if (!hook) { console.log('[watch] SLACK_WEBHOOK_URL not set, nothing sent'); return; }

  const r = await fetch(hook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, unfurl_links: false }) });
  // Only remember what was actually delivered, so a failed post retries tomorrow.
  if (r.ok) writeSeen(seen);
  console.log(r.ok ? `[watch] sent ${fresh.length} new listing(s)` : `[watch] Slack rejected the post: HTTP ${r.status}`);
}

main().catch(e => console.log('[watch] skipped after error:', e.message));
