// Daily capture. Pulls the live sources (Mirror API, Fashionphile Algolia, StockX),
// folds in the periodic index reports, and writes one append-only snapshot per day.
//
// Design goals:
//  - Never crash the daily log. If a source fails, record it in capture.errors and
//    fall back (carry-forward or empty) so the daily record stays complete.
//  - Public endpoints only, once per day. Mirror's Terms discourage automated
//    extraction; this is a low-volume personal market tracker of public data.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, SNAP_DIR, today, ensureDir, writeFile, previousSnapshot } from '../src/lib/util.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const deaccent = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const cleanLines = t => t.split('\n').map(l => l.trim()).filter(Boolean);

// ---- Mirror: public JSON API (Google Cloud Run) ----
// The site's own backend. /api/hunt = live requests (with exact requestCount),
// /api/products = sourcer inventory. Cleaner + more accurate than scraping the SPA.
const MIRROR_API = 'https://mirror-api-109630828579.us-central1.run.app';
async function scrapeMirror() {
  const [hunt, products] = await Promise.all([
    fetch(MIRROR_API + '/api/hunt').then(r => { if (!r.ok) throw new Error('hunt HTTP ' + r.status); return r.json(); }),
    fetch(MIRROR_API + '/api/products').then(r => { if (!r.ok) throw new Error('products HTTP ' + r.status); return r.json(); })
  ]);
  const huntOut = (hunt || []).map(h => ({
    brand: h.brand, item: h.title, requesters: h.requestCount ?? 0,
    color: h.color || null, category: (h.categoryTags || [])[0] || null
  })).sort((a, b) => b.requesters - a.requesters);
  const inventoryPriced = (products || []).filter(p => p.price != null).map(p => ({
    brand: p.brand, item: p.title, price: p.price, category: (p.categoryTags || [])[0] || null
  }));
  const counts = {};
  (products || []).forEach(p => { counts[p.brand] = (counts[p.brand] || 0) + 1; });
  const inventoryCounts = Object.entries(counts).map(([brand, count]) => ({ brand, count })).sort((a, b) => b.count - a.count);
  if (huntOut.length === 0 && inventoryPriced.length === 0) throw new Error('Mirror API returned no data');
  return { status: 'ok', via: 'api', site: 'https://mirrorconcierge.com', hunt: huntOut, inventoryPriced, inventoryCounts };
}

// ---- Fashionphile: public Algolia search index (search-only key, safe to commit) ----
const FP = { appId: 'NSJAZ0QG7K', key: 'e545a3cf82cf7dbc5ff39f49c214863e', index: 'shopify_products_price_asc' };
const FP_VENDOR = {
  'Hermès': 'Hermes', 'Chanel': 'Chanel', 'Louis Vuitton': 'Louis Vuitton', 'Goyard': 'Goyard',
  'Dior': 'Christian Dior', 'Fendi': 'Fendi', 'The Row': 'The Row', 'Cartier': 'Cartier'
};
async function scrapeFashionphile() {
  const focus = [];
  for (const [brand, vendor] of Object.entries(FP_VENDOR)) {
    const params = `query=&hitsPerPage=1`
      + `&facetFilters=${encodeURIComponent(JSON.stringify([[`vendor:${vendor}`]]))}`
      + `&filters=${encodeURIComponent('inventory_available=1')}`;
    const r = await fetch(`https://${FP.appId}-dsn.algolia.net/1/indexes/${FP.index}/query`, {
      method: 'POST',
      headers: { 'X-Algolia-Application-Id': FP.appId, 'X-Algolia-API-Key': FP.key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ params })
    });
    if (!r.ok) throw new Error(`Algolia HTTP ${r.status}`);
    const j = await r.json();
    focus.push({ brand, low: (j.hits && j.hits[0] || {}).price ?? null, count: j.nbHits ?? null });
  }
  if (!focus.some(f => f.low != null)) throw new Error('no Fashionphile data returned');
  return { status: 'ok', name: 'Fashionphile', via: 'algolia', focus };
}

// ---- StockX: rendered search results (bot-protected GraphQL behind the scenes, so
// this stays best-effort). Results render as name -> "Lowest Ask" -> $price; sponsored
// ads lack "Lowest Ask" so they filter out naturally. Also grabs the "Browse N results".
const STOCKX_BRANDS = ['Goyard', 'Hermès', 'Chanel', 'Louis Vuitton', 'Dior', 'Rolex', 'Cartier', 'Fendi'];
function parseStockx(text) {
  const lines = cleanLines(text);
  const items = [];
  for (let i = 1; i < lines.length - 1; i++) {
    if (/^Lowest Ask$/i.test(lines[i]) && /^\$[\d,]+/.test(lines[i + 1])) {
      items.push({ item: lines[i - 1], price: Number(lines[i + 1].replace(/[^\d]/g, '')) });
    }
  }
  const rm = text.match(/Browse\s+([\d,]+)\s+results/i);
  return { items, results: rm ? Number(rm[1].replace(/,/g, '')) : null };
}
async function scrapeStockx(browser) {
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  try {
    const focus = [];
    let goyard = [];
    for (let bi = 0; bi < STOCKX_BRANDS.length; bi++) {
      const brand = STOCKX_BRANDS[bi];
      try {
        if (bi > 0) await page.waitForTimeout(4000); // space out requests to avoid throttling
        const q = deaccent(brand);
        await page.goto('https://stockx.com/search?s=' + encodeURIComponent(q), { waitUntil: 'domcontentloaded', timeout: 45000 });
        // wait until results (or a block page) actually render, up to 15s
        await page.waitForFunction(
          () => /Lowest Ask|Browse [\d,]+ results|Pardon Our Interruption|captcha|Access Denied/i.test(document.body.innerText),
          { timeout: 15000 }
        ).catch(() => {});
        await page.waitForTimeout(1200);
        const body = await page.innerText('body');
        if (/Access Denied|captcha|unusual traffic|are you a human|Pardon Our Interruption/i.test(body)) throw new Error('bot-blocked');
        const { items, results } = parseStockx(body);
        const key = deaccent(q).split(' ')[0].toLowerCase();
        const branded = items.filter(x => deaccent(x.item).toLowerCase().includes(key));
        const low = branded.length ? Math.min(...branded.map(x => x.price)) : null;
        focus.push({ brand, low, results, listed: branded.length });
        if (brand === 'Goyard') goyard = branded.slice(0, 12);
      } catch (e) {
        focus.push({ brand, low: null, results: null, listed: 0, error: String(e.message || e) });
      }
    }
    if (!focus.some(f => f.low != null)) throw new Error('no StockX data parsed (bot-block or layout)');
    return { status: 'ok', focus, goyard };
  } finally {
    await ctx.close();
  }
}

async function main() {
  const date = today();
  const prev = previousSnapshot(date + '~');
  const errors = [];
  const indices = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'indices.json'), 'utf8'));
  delete indices._comment;

  // StockX needs a browser; Mirror + Fashionphile are plain fetch.
  let stockx;
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  try { stockx = await scrapeStockx(browser); }
  catch (e) { errors.push({ source: 'stockx', error: String(e.message || e) }); stockx = { status: 'error', focus: [], goyard: [] }; }
  finally { await browser.close(); }

  let mirror;
  try { mirror = await scrapeMirror(); }
  catch (e) {
    errors.push({ source: 'mirror', error: String(e.message || e) });
    mirror = prev?.sources?.mirror ? { ...prev.sources.mirror, status: 'carried' } : { status: 'error', hunt: [], inventoryPriced: [], inventoryCounts: [] };
  }

  let fashionphile;
  try { fashionphile = await scrapeFashionphile(); }
  catch (e) { errors.push({ source: 'fashionphile', error: String(e.message || e) }); fashionphile = { status: 'error', name: 'Fashionphile', focus: [] }; }

  // The RealReal and Vestiaire are edge-blocked to servers, so they're report-based
  // reference sources carried from src/data/indices.json.
  const { therealreal: trrReport, vestiaire: vcReport, ...periodicIndices } = indices;

  const snapshot = {
    date,
    capturedAt: new Date().toISOString(),
    capture: { method: 'scrape', errors },
    sources: {
      mirror,
      stockx_goyard: { status: stockx.status, items: stockx.goyard || [] },
      stockx_brands: { status: stockx.status, focus: stockx.focus || [] },
      fashionphile,
      therealreal: { status: 'reference', ...trrReport },
      vestiaire: { status: 'reference', ...vcReport },
      indices: { status: 'reference', ...periodicIndices }
    }
  };

  ensureDir(SNAP_DIR);
  writeFile(path.join(SNAP_DIR, `${date}.json`), JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`[scrape] wrote ${date}.json — mirror:${mirror.status} hunt:${mirror.hunt?.length ?? 0} inv:${mirror.inventoryPriced?.length ?? 0} stockx:${stockx.status} brands:${(stockx.focus || []).filter(f => f.low != null).length}/${STOCKX_BRANDS.length} fashionphile:${fashionphile.status}(${fashionphile.focus?.length ?? 0})` + (errors.length ? ` (errors: ${errors.map(e => e.source).join(', ')})` : ''));
}

main().catch(e => { console.error(e); process.exit(1); });
