// Per-marketplace adapters for the grail watcher. Each returns listings in one
// shape and answers one question about a listing that went missing: sold, gone,
// still live somewhere the search did not reach, or unknown.
//
// The answers differ in strength, and the alerts say so. Fashionphile keeps sold
// items in its index with inventory_available false, so a sale is confirmed.
// eBay's Browse API cannot distinguish a sale from a seller withdrawing a
// listing; genuine sold data sits behind the Marketplace Insights API, which
// needs eBay's approval. An eBay listing that disappears is therefore reported
// as no longer listed, never as sold.

// ---- eBay ------------------------------------------------------------------
let ebayToken = null;
async function ebayAuth() {
  if (ebayToken) return ebayToken;
  const id = process.env.EBAY_CLIENT_ID, secret = process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) throw new Error('eBay credentials not set');
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope')
  });
  if (!r.ok) throw new Error(`eBay OAuth HTTP ${r.status}`);
  return (ebayToken = (await r.json()).access_token);
}
const ebayHeaders = tok => ({ 'Authorization': `Bearer ${tok}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' });

const ebay = {
  async search(watch) {
    const tok = await ebayAuth();
    const out = [];
    for (const q of watch.queries || []) {
      const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search'
        + '?q=' + encodeURIComponent(q) + '&limit=100&sort=-price'
        + '&filter=' + encodeURIComponent(`buyingOptions:{FIXED_PRICE},price:[${watch.minPrice || 1}..],priceCurrency:USD`);
      const r = await fetch(url, { headers: ebayHeaders(tok) });
      if (!r.ok) { console.log(`[watch] eBay "${q}" HTTP ${r.status}`); continue; }
      for (const it of (await r.json()).itemSummaries || []) {
        out.push({
          source: 'ebay', id: it.itemId, title: it.title || '',
          price: it.price?.value != null ? Number(it.price.value) : null,
          url: it.itemWebUrl || null, condition: it.condition || null,
          listed: (it.itemCreationDate || '').slice(0, 10) || null,
          seller: it.seller?.username ?? null,
          sellerPct: it.seller?.feedbackPercentage != null ? Number(it.seller.feedbackPercentage) : null,
          sellerScore: it.seller?.feedbackScore != null ? Number(it.seller.feedbackScore) : null
        });
      }
    }
    return out;
  },

  async confirm(rec) {
    const tok = await ebayAuth();
    const r = await fetch(`https://api.ebay.com/buy/browse/v1/item/${encodeURIComponent(rec.id)}`, { headers: ebayHeaders(tok) });
    if (r.status === 404 || r.status === 410) return { state: 'gone' };
    if (!r.ok) return { state: 'unknown' };
    const j = await r.json();
    const avail = (j.estimatedAvailabilities || []).map(a => a.estimatedAvailabilityStatus);
    const live = !avail.length || avail.some(s => s === 'IN_STOCK' || s === 'LIMITED_STOCK');
    return live ? { state: 'still-live', price: j.price?.value != null ? Number(j.price.value) : null } : { state: 'gone' };
  }
};

// ---- Fashionphile ----------------------------------------------------------
const FP = { app: 'NSJAZ0QG7K', key: 'e545a3cf82cf7dbc5ff39f49c214863e', index: 'shopify_products_price_asc' };
const fpHeaders = { 'X-Algolia-Application-Id': FP.app, 'X-Algolia-API-Key': FP.key, 'Content-Type': 'application/json' };
const BAGS = ['Handbags', 'Shoulder Bags', 'Crossbody', 'Totes', 'Clutch & Evening'].map(v => `meta.custom.filters_bags:${v}`);

const fashionphile = {
  async search(watch) {
    const ff = [[`vendor:${watch.vendor}`], watch.segments || BAGS];
    const filters = [`inventory_available=1`, watch.minPrice ? `price>=${watch.minPrice}` : null].filter(Boolean).join(' AND ');
    const params = `query=${encodeURIComponent('"' + watch.phrase + '"')}&advancedSyntax=true`
      + `&restrictSearchableAttributes=${encodeURIComponent(JSON.stringify(['title']))}`
      + `&hitsPerPage=1000&facetFilters=${encodeURIComponent(JSON.stringify(ff))}`
      + `&filters=${encodeURIComponent(filters)}`
      + `&attributesToRetrieve=${encodeURIComponent(JSON.stringify(['objectID', 'title', 'price', 'handle', 'published_at', 'meta.custom.condition']))}`;
    const r = await fetch(`https://${FP.app}-dsn.algolia.net/1/indexes/${FP.index}/query`, { method: 'POST', headers: fpHeaders, body: JSON.stringify({ params }) });
    if (!r.ok) throw new Error(`Fashionphile HTTP ${r.status}`);
    // Fashionphile titles omit the house ("Togo Birkin 25 Capucine"), which is fine
    // on their site but ambiguous in an alert, so the brand is prepended.
    return ((await r.json()).hits || []).map(h => ({
      source: 'fashionphile', id: String(h.objectID),
      title: `${watch.brand} ${h.title || ''}`.trim(),
      price: h.price ?? null,
      url: h.handle ? `https://www.fashionphile.com/products/${h.handle}` : null,
      condition: h.meta?.custom?.condition || null,
      listed: (h.published_at || '').slice(0, 10) || null,
      seller: 'Fashionphile', sellerPct: null, sellerScore: null
    }));
  },

  async confirm(rec) {
    const r = await fetch(`https://${FP.app}-dsn.algolia.net/1/indexes/${FP.index}/${encodeURIComponent(rec.id)}?attributesToRetrieve=inventory_available,price`, { headers: fpHeaders });
    if (r.status === 404) return { state: 'gone' };
    if (!r.ok) return { state: 'unknown' };
    const j = await r.json();
    return j.inventory_available ? { state: 'still-live', price: j.price ?? null } : { state: 'sold' };
  }
};

export const SOURCES = { ebay, fashionphile };
