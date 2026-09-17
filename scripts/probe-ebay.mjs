// One-off eBay probe, run from CI because the Browse API credentials live in
// GitHub secrets rather than locally. Answers a specific question: can the API
// see grail-tier pieces, the kind that do not appear on Fashionphile at all?
//
// Usage: npm run probe:ebay -- "Chrome Hearts Levi's" 2000
import { EBAY_BRANDS } from '../src/lib/tracking.mjs';

async function token() {
  const id = process.env.EBAY_CLIENT_ID, secret = process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) throw new Error('eBay credentials not set');
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope')
  });
  if (!r.ok) throw new Error(`OAuth HTTP ${r.status}`);
  return (await r.json()).access_token;
}

async function search(tok, q, floor, limit = 10) {
  const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search'
    + '?q=' + encodeURIComponent(q)
    + `&limit=${limit}&sort=-price`
    + '&filter=' + encodeURIComponent(`buyingOptions:{FIXED_PRICE},price:[${floor}..],priceCurrency:USD`);
  const r = await fetch(url, { headers: { 'Authorization': `Bearer ${tok}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const QUERIES = [
  ["Chrome Hearts Levi's jeans", 1000],
  ["Chrome Hearts cross patch denim", 1000],
  ["Chrome Hearts jeans", 2000],
  ["Chrome Hearts", 5000],
  ["Hermes Birkin", 20000],
  ["The Row Margaux", 2000]
];

const tok = await token();
for (const [q, floor] of QUERIES) {
  try {
    const j = await search(tok, q, floor);
    console.log(`\n"${q}" over $${floor}: ${j.total ?? 0} results`);
    for (const it of (j.itemSummaries || []).slice(0, 4)) {
      const p = it.price?.value ? `$${Math.round(Number(it.price.value)).toLocaleString('en-US')}` : '?';
      console.log(`   ${p.padStart(9)}  ${(it.title || '').slice(0, 62)}`);
      console.log(`             cond=${it.condition || '-'}  seller=${it.seller?.username || '-'}`);
    }
  } catch (e) {
    console.log(`\n"${q}": FAILED ${e.message}`);
  }
}
