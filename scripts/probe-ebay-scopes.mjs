// Which eBay APIs does this developer key actually unlock? Requests a token for
// each scope in turn: eBay refuses the grant outright for any API the app has
// not been approved for, so the token response itself is the answer.
const id = process.env.EBAY_CLIENT_ID, secret = process.env.EBAY_CLIENT_SECRET;
if (!id || !secret) { console.log('eBay credentials not set'); process.exit(0); }
const basic = Buffer.from(`${id}:${secret}`).toString('base64');

const SCOPES = {
  'Browse (active listings)': 'https://api.ebay.com/oauth/api_scope',
  'Marketplace Insights (SOLD listings)': 'https://api.ebay.com/oauth/api_scope/buy.marketplace.insights',
  'Item Feed (bulk listing feeds)': 'https://api.ebay.com/oauth/api_scope/buy.item.feed',
  'Deal (eBay deals)': 'https://api.ebay.com/oauth/api_scope/buy.deal'
};

for (const [name, scope] of Object.entries(SCOPES)) {
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent(scope)
  });
  const j = await r.json().catch(() => ({}));
  console.log(`${r.ok ? 'GRANTED' : 'REFUSED'}  ${name.padEnd(38)} ${r.ok ? '' : `(${j.error || r.status}: ${(j.error_description || '').slice(0, 70)})`}`);

  // If Insights is granted, prove it returns real sold data rather than stopping at the token.
  if (r.ok && scope.endsWith('marketplace.insights')) {
    const s = await fetch('https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search?q=' + encodeURIComponent("Chrome Hearts Levi's jeans") + '&limit=3',
      { headers: { 'Authorization': `Bearer ${j.access_token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } });
    const sj = await s.json().catch(() => ({}));
    console.log(`         sold search HTTP ${s.status}, ${sj.total ?? 0} results`);
    (sj.itemSales || []).forEach(x => console.log(`         $${x.lastSoldPrice?.value}  ${x.lastSoldDate?.slice(0, 10)}  ${(x.title || '').slice(0, 50)}`));
  }
}
