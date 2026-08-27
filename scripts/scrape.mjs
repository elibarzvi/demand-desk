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
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { ROOT, SNAP_DIR, today, ensureDir, writeFile, previousSnapshot } from '../src/lib/util.mjs';
import { SEGMENTS, captureSegment, MODELS, captureModel } from '../src/lib/fashionphile.mjs';
import { readLiveState, writeLiveState, diffLive } from '../src/lib/sellthrough.mjs';

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
// Each brand is captured as one comparable segment (handbags, or fine jewelry for
// Cartier) with exact price percentiles over the whole live inventory, plus every
// live SKU so departures can be diffed into real sell-through. See
// src/lib/fashionphile.mjs for why the old "lowest price" read was meaningless.
async function scrapeFashionphile() {
  const focus = [];
  const errors = [];
  for (const seg of SEGMENTS) {
    try {
      focus.push(await captureSegment(seg));
    } catch (e) {
      errors.push(`${seg.brand}: ${e.message || e}`);
    }
  }
  if (!focus.length) throw new Error('no Fashionphile data returned');

  // Per-model capture. Brand aggregates cannot answer "is the Birkin 25 moving",
  // which is the level an actual buying decision works at.
  const models = [];
  for (const m of MODELS) {
    try { models.push(await captureModel(m)); }
    catch (e) { errors.push(`${m.brand} ${m.model}: ${e.message || e}`); }
  }

  return {
    status: errors.length ? 'partial' : 'ok',
    name: 'Fashionphile', via: 'algolia',
    ...(errors.length ? { segmentErrors: errors } : {}),
    focus, models
  };
}

// ---- eBay: official Browse API via client-credentials OAuth. Keys come from env
// (GitHub Actions secrets EBAY_CLIENT_ID / EBAY_CLIENT_SECRET), so it stays disabled
// on local runs unless those are exported. Active fixed-price listing count + floor
// price per brand — a large, legitimate demand/supply signal. ----
const EBAY_BRANDS = ['Hermès', 'Chanel', 'Louis Vuitton', 'Goyard', 'Dior', 'Fendi', 'Cartier', 'Rolex', 'The Row'];
async function ebayToken() {
  const id = process.env.EBAY_CLIENT_ID, secret = process.env.EBAY_CLIENT_SECRET;
  if (!id || !secret) throw new Error('eBay credentials not set');
  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  const r = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials&scope=' + encodeURIComponent('https://api.ebay.com/oauth/api_scope')
  });
  if (!r.ok) throw new Error(`eBay OAuth HTTP ${r.status}`);
  const j = await r.json();
  if (!j.access_token) throw new Error('eBay OAuth returned no token');
  return j.access_token;
}
async function scrapeEbay() {
  const token = await ebayToken();
  const focus = [];
  for (const brand of EBAY_BRANDS) {
    try {
      const url = 'https://api.ebay.com/buy/browse/v1/item_summary/search'
        + '?q=' + encodeURIComponent(brand)
        + '&limit=1&sort=price'
        + '&filter=' + encodeURIComponent('buyingOptions:{FIXED_PRICE},price:[100..],priceCurrency:USD'); // $100 floor cuts junk (stickers, cases)
      const r = await fetch(url, { headers: { 'Authorization': `Bearer ${token}`, 'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const pv = j.itemSummaries?.[0]?.price?.value;
      focus.push({ brand, total: j.total ?? null, low: pv != null ? Math.round(Number(pv)) : null });
    } catch (e) {
      focus.push({ brand, total: null, low: null, error: String(e.message || e) });
    }
  }
  if (!focus.some(f => f.total != null)) throw new Error('no eBay data returned');
  return { status: 'ok', via: 'browse-api', focus };
}

// ---- Search volume: Google monthly searches per brand keyword, via DataForSEO
// (paid keyword API). Credentials from env (DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD).
// One cheap request/day for all keywords — the real search-demand number that layers
// onto every brand row (eBay included). ----
const SEARCH_KEYWORDS = [
  { brand: 'Hermès', keyword: 'hermes bag' },
  { brand: 'Chanel', keyword: 'chanel bag' },
  { brand: 'Louis Vuitton', keyword: 'louis vuitton bag' },
  { brand: 'Goyard', keyword: 'goyard bag' },
  { brand: 'Dior', keyword: 'dior bag' },
  { brand: 'Fendi', keyword: 'fendi bag' },
  { brand: 'Cartier', keyword: 'cartier' },
  { brand: 'Rolex', keyword: 'rolex' },
  { brand: 'The Row', keyword: 'the row bag' }
];
async function scrapeSearchVolume() {
  const login = process.env.DATAFORSEO_LOGIN, pass = process.env.DATAFORSEO_PASSWORD;
  if (!login || !pass) throw new Error('DataForSEO credentials not set');
  const basic = Buffer.from(`${login}:${pass}`).toString('base64');
  const r = await fetch('https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ keywords: SEARCH_KEYWORDS.map(k => k.keyword), location_code: 2840, language_code: 'en' }]) // 2840 = United States
  });
  if (!r.ok) throw new Error(`DataForSEO HTTP ${r.status}`);
  const j = await r.json();
  const results = j.tasks?.[0]?.result || [];
  const byKw = {};
  results.forEach(x => { byKw[(x.keyword || '').toLowerCase()] = x.search_volume; });
  const focus = SEARCH_KEYWORDS.map(k => ({ brand: k.brand, keyword: k.keyword, volume: byKw[k.keyword.toLowerCase()] ?? null }));
  if (!focus.some(f => f.volume != null)) throw new Error('no search volume returned');
  return { status: 'ok', via: 'dataforseo', focus };
}

// ---- Google Trends (DataForSEO): DAILY search interest (0-100 index) per brand over
// the last 30 days — the demand *direction/momentum* signal (vs monthly volume = size).
// Max 5 keywords/request, so 9 brands = 2 batched calls. Same DataForSEO creds. ----
// Google Trends normalizes its 0-100 index WITHIN a single request, so two
// independent batches are two different scales and cannot be compared. The old
// code did exactly that: batch 1 peaked on Chanel=100 and batch 2 on Dior=100,
// which rendered Dior as Chanel's equal despite a third of its search volume.
//
// The fix is the standard one: carry a shared anchor keyword in every batch and
// rescale each batch so the anchor lines up. Chanel is the anchor because it is
// large and stable, and it is a tracked brand anyway so it costs no extra slot.
const TREND_ANCHOR = { brand: 'Chanel', keyword: 'chanel' };
const TREND_BATCHES = [
  [{ brand: 'Louis Vuitton', keyword: 'louis vuitton' }, { brand: 'Rolex', keyword: 'rolex' },
   { brand: 'Cartier', keyword: 'cartier' }, { brand: 'Goyard', keyword: 'goyard' }],
  [{ brand: 'Dior', keyword: 'dior' }, { brand: 'Hermès', keyword: 'hermes' },
   { brand: 'Fendi', keyword: 'fendi' }, { brand: 'The Row', keyword: 'the row bag' }]
];
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

async function scrapeGoogleTrends() {
  const login = process.env.DATAFORSEO_LOGIN, pass = process.env.DATAFORSEO_PASSWORD;
  if (!login || !pass) throw new Error('DataForSEO credentials not set');
  const basic = Buffer.from(`${login}:${pass}`).toString('base64');

  const raw = [];
  for (const batch of TREND_BATCHES) {
    const keywords = [TREND_ANCHOR, ...batch];          // anchor always occupies slot 0
    const body = [{ keywords: keywords.map(b => b.keyword), location_code: 2840, time_range: 'past_30_days', type: 'web' }];
    const r = await fetch('https://api.dataforseo.com/v3/keywords_data/google_trends/explore/live', {
      method: 'POST', headers: { 'Authorization': `Basic ${basic}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(`Google Trends HTTP ${r.status}`);
    const j = await r.json();
    const result = j.tasks?.[0]?.result?.[0];
    const graph = (result?.items || []).find(it => it.type === 'google_trends_graph') || (result?.items || [])[0];
    const data = graph?.data || [];
    const series = keywords.map((b, k) => ({
      brand: b.brand, keyword: b.keyword,
      series: data.map(d => ({ date: d.date_from, value: Array.isArray(d.values) ? d.values[k] : null })).filter(p => p.value != null)
    }));
    raw.push(series);
  }

  // Rescale every batch onto the first batch's anchor level.
  const anchorLevel = batchIndex => mean((raw[batchIndex][0].series || []).map(p => p.value).filter(v => v != null));
  const base = anchorLevel(0);
  const focus = [];
  raw.forEach((series, bi) => {
    const level = anchorLevel(bi);
    const scale = (base && level) ? base / level : 1;
    series.forEach((s, si) => {
      if (si === 0 && bi > 0) return;                   // anchor is only emitted once
      focus.push({
        brand: s.brand, keyword: s.keyword, scale: +scale.toFixed(4),
        series: s.series.map(p => ({ date: p.date, value: +(p.value * scale).toFixed(1) }))
      });
    });
  });

  if (!focus.some(f => f.series.length)) throw new Error('no Google Trends data returned');
  return { status: 'ok', via: 'dataforseo-google-trends', anchor: TREND_ANCHOR.keyword, focus };
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
  const focus = [];
  let goyard = [];
  for (let bi = 0; bi < STOCKX_BRANDS.length; bi++) {
    const brand = STOCKX_BRANDS[bi];
    // Fresh, isolated session per brand — StockX soft-blocks repeat searches within a
    // session, so new cookies/storage each time gives each brand its own clean shot.
    const ctx = await browser.newContext({ userAgent: UA });
    const page = await ctx.newPage();
    try {
      if (bi > 0) await new Promise(r => setTimeout(r, 3000));
      const q = deaccent(brand);
      await page.goto('https://stockx.com/search?s=' + encodeURIComponent(q), { waitUntil: 'domcontentloaded', timeout: 45000 });
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
      // StockX stops counting at 1000, so "1000" means "1000 or more" and is not a
      // supply measure. Seven of eight brands returned exactly 1000 every day for
      // 24 days. Record the cap explicitly instead of publishing it as a count.
      const capped = results != null && results >= 1000;
      focus.push({ brand, low, results: capped ? null : results, resultsCapped: capped, listed: branded.length });
      if (brand === 'Goyard') goyard = branded.slice(0, 12);
    } catch (e) {
      focus.push({ brand, low: null, results: null, listed: 0, error: String(e.message || e) });
    } finally {
      await ctx.close();
    }
  }
  if (!focus.some(f => f.low != null)) throw new Error('no StockX data parsed (bot-block or layout)');
  return { status: 'ok', focus, goyard };
}

// ---- Freshness ----
// Mirror's request feed sat byte-identical for 22 straight days while the
// dashboard presented it as live demand. Nothing in the pipeline noticed, because
// nothing was looking. Fingerprint each source's payload every run and carry a
// consecutive-unchanged counter, so a frozen source announces itself on day 2
// instead of being discovered by hand a month later.
function fingerprint(source) {
  if (!source) return null;
  const { status, capturedAt, fetchedOn, carriedFrom, error, errors, segmentErrors, scale, ...rest } = source;
  return crypto.createHash('sha1').update(JSON.stringify(rest)).digest('hex').slice(0, 12);
}

function freshness(sources, prev, date) {
  const prevF = prev?.capture?.freshness || {};
  const out = {};
  for (const [name, src] of Object.entries(sources)) {
    const fp = fingerprint(src);
    const before = prevF[name];
    const same = before && before.fingerprint === fp;
    out[name] = {
      fingerprint: fp,
      unchangedDays: same ? (before.unchangedDays ?? 0) + 1 : 0,
      lastChanged: same ? (before.lastChanged || null) : date
    };
  }
  return out;
}

async function main() {
  const date = today();
  const prev = previousSnapshot(date + '~');        // includes today, so a re-run can carry from its own earlier pass
  const prevDay = previousSnapshot(date);            // strictly earlier day, for day-over-day comparisons
  const errors = [];
  const indices = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'indices.json'), 'utf8'));
  delete indices._comment;

  // StockX needs a browser; Mirror + Fashionphile are plain fetch. The launch sits
  // inside the try because a browser that fails to start (missing binary, sandbox
  // refusal, disk pressure in CI) would otherwise throw past every handler and
  // lose the entire day's capture, including the sources that were perfectly fine.
  let stockx, browser = null;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    stockx = await scrapeStockx(browser);
  } catch (e) {
    errors.push({ source: 'stockx', error: String(e.message || e) });
    stockx = { status: 'error', focus: [], goyard: [] };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  let mirror;
  try { mirror = await scrapeMirror(); }
  catch (e) {
    errors.push({ source: 'mirror', error: String(e.message || e) });
    mirror = prev?.sources?.mirror ? { ...prev.sources.mirror, status: 'carried' } : { status: 'error', hunt: [], inventoryPriced: [], inventoryCounts: [] };
  }

  let fashionphile, sellThrough = { status: 'unavailable', brands: {} };
  try {
    fashionphile = await scrapeFashionphile();
    // Diff today's live SKUs against yesterday's state to derive sell-through.
    // The SKU lists themselves are huge, so they go to the rolling state file and
    // only the departure events (the actual signal) land in the snapshot.
    const prevState = readLiveState(date);
    const modelBySku = new Map();
    for (const m of fashionphile.models || []) {
      for (const sku of m.skus || []) modelBySku.set(sku, m.model);
    }
    const { brands, byModel, nextState, baseline } = diffLive(prevState, fashionphile.focus, date, modelBySku);
    writeLiveState(nextState);
    sellThrough = { status: baseline ? 'baseline' : 'ok', via: 'sku-diff', brands, byModel };
    // SKU lists are far too large to append daily; they live in the state file.
    fashionphile.focus = fashionphile.focus.map(({ skus, ...rest }) => rest);
    fashionphile.models = (fashionphile.models || []).map(({ skus, ...rest }) => rest);
  } catch (e) {
    errors.push({ source: 'fashionphile', error: String(e.message || e) });
    fashionphile = { status: 'error', name: 'Fashionphile', focus: [] };
  }

  let ebay;
  try { ebay = await scrapeEbay(); }
  catch (e) {
    if (process.env.EBAY_CLIENT_ID) errors.push({ source: 'ebay', error: String(e.message || e) });
    ebay = { status: process.env.EBAY_CLIENT_ID ? 'error' : 'unconfigured', focus: [] };
  }

  // Google Ads search volume is a MONTHLY average. Across the first 24 days of
  // this log it returned a single unchanging value for 8 of 9 brands, so fetching
  // it daily bought nothing and cost a paid call each time. Refresh it weekly (or
  // whenever the carried value is missing) and carry it forward in between.
  let searchVolume;
  const prevVol = prev?.sources?.search_volume;
  const volIsFresh = prevVol && (prevVol.focus || []).some(f => f.volume != null);
  const isRefreshDay = new Date(date + 'T00:00:00Z').getUTCDay() === 1;   // Monday
  if (!volIsFresh || isRefreshDay) {
    try { searchVolume = await scrapeSearchVolume(); }
    catch (e) {
      if (process.env.DATAFORSEO_LOGIN) errors.push({ source: 'search_volume', error: String(e.message || e) });
      searchVolume = volIsFresh
        ? { ...prevVol, status: 'carried', carriedFrom: prevVol.fetchedOn || prev.date }
        : { status: process.env.DATAFORSEO_LOGIN ? 'error' : 'unconfigured', focus: [] };
    }
  } else {
    searchVolume = { ...prevVol, status: 'carried', carriedFrom: prevVol.fetchedOn || prev.date };
  }
  if (searchVolume.status === 'ok') searchVolume.fetchedOn = date;

  let googleTrends;
  try { googleTrends = await scrapeGoogleTrends(); }
  catch (e) {
    if (process.env.DATAFORSEO_LOGIN) errors.push({ source: 'google_trends', error: String(e.message || e) });
    googleTrends = { status: process.env.DATAFORSEO_LOGIN ? 'error' : 'unconfigured', focus: [] };
  }

  // The RealReal and Vestiaire are edge-blocked to servers, so they're report-based
  // reference sources carried from src/data/indices.json.
  const { therealreal: trrReport, vestiaire: vcReport, ...periodicIndices } = indices;

  const sources = {
      mirror,
      stockx_goyard: { status: stockx.status, items: stockx.goyard || [] },
      stockx_brands: { status: stockx.status, focus: stockx.focus || [] },
      fashionphile,
      fp_sell_through: sellThrough,
      ebay,
      search_volume: searchVolume,
      google_trends: googleTrends,
      therealreal: { status: 'reference', ...trrReport },
      vestiaire: { status: 'reference', ...vcReport },
      indices: { status: 'reference', ...periodicIndices }
  };

  const snapshot = {
    date,
    capturedAt: new Date().toISOString(),
    capture: { method: 'scrape', errors, freshness: freshness(sources, prevDay, date) },
    sources
  };

  ensureDir(SNAP_DIR);
  writeFile(path.join(SNAP_DIR, `${date}.json`), JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`[scrape] wrote ${date}.json — mirror:${mirror.status} hunt:${mirror.hunt?.length ?? 0} inv:${mirror.inventoryPriced?.length ?? 0} stockx:${stockx.status} brands:${(stockx.focus || []).filter(f => f.low != null).length}/${STOCKX_BRANDS.length} fashionphile:${fashionphile.status}(${fashionphile.focus?.length ?? 0}) ebay:${ebay.status}(${(ebay.focus || []).filter(f => f.total != null).length}) searchvol:${searchVolume.status}(${(searchVolume.focus || []).filter(f => f.volume != null).length}) trends:${googleTrends.status}(${(googleTrends.focus || []).filter(f => f.series?.length).length})` + (errors.length ? ` (errors: ${errors.map(e => e.source).join(', ')})` : ''));
}

main().catch(e => { console.error(e); process.exit(1); });
