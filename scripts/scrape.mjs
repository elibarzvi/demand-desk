// Daily capture. Renders the public Mirror feeds + StockX, folds in the periodic
// index reports, and writes one append-only snapshot per day to data/snapshots/.
//
// Design goals:
//  - Never crash the daily log. If a source fails (layout change, bot-block,
//    network), carry the previous day's values forward, marked "carried", and
//    record the error in capture.errors — the daily record stays complete.
//  - Public pages only, once per day. Note: Mirror's Terms discourage automated
//    extraction; this is a low-volume personal market tracker of public data.
//    Review that yourself before running on a schedule.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { ROOT, SNAP_DIR, today, ensureDir, writeFile, previousSnapshot } from '../src/lib/util.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const KNOWN_BRANDS = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'brands.json'), 'utf8')));

function cleanLines(text) {
  return text.split('\n').map(l => l.trim()).filter(Boolean);
}

// "Requested by Madison +10 others" -> requesters = 11 (named + others).
function parseHunt(text) {
  const lines = cleanLines(text);
  const out = [];
  const re = /^Requested by .+?\s\+(\d+)\s+others?$/i;
  for (let i = 2; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const brand = lines[i - 2], item = lines[i - 1];
    if (!KNOWN_BRANDS.has(brand)) continue;
    out.push({ brand, item, requesters: Number(m[1]) + 1 });
  }
  return dedupe(out, x => x.brand + '|' + x.item);
}

// Inventory: priced items ("Approx. $1,677") + brand-level listing counts (supply mix).
function parseInventory(text) {
  const lines = cleanLines(text);
  const priced = [];
  const counts = {};
  const priceRe = /^Approx\.\s*\$([\d,]+)/i;
  const purRe = /^Price Upon Request$/i;
  for (let i = 2; i < lines.length; i++) {
    const priceM = lines[i].match(priceRe);
    const isPur = purRe.test(lines[i]);
    if (!priceM && !isPur) continue;
    const brand = lines[i - 2], item = lines[i - 1];
    if (!KNOWN_BRANDS.has(brand)) continue;
    counts[brand] = (counts[brand] || 0) + 1;
    if (priceM) priced.push({ brand, item, price: Number(priceM[1].replace(/,/g, '')) });
  }
  return {
    priced: dedupe(priced, x => x.brand + '|' + x.item + '|' + x.price),
    counts: Object.entries(counts).map(([brand, count]) => ({ brand, count })).sort((a, b) => b.count - a.count)
  };
}

function dedupe(arr, keyFn) {
  const seen = new Set();
  return arr.filter(x => { const k = keyFn(x); if (seen.has(k)) return false; seen.add(k); return true; });
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise(resolve => {
      let last = 0, stable = 0;
      const t = setInterval(() => {
        window.scrollBy(0, document.body.scrollHeight);
        const h = document.body.scrollHeight;
        if (h === last) { if (++stable > 4) { clearInterval(t); resolve(); } }
        else { stable = 0; last = h; }
      }, 400);
    });
  });
}

async function scrapeMirror(browser) {
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  try {
    await page.goto('https://mirrorconcierge.com/', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2500);
    const hunt = parseHunt(await page.innerText('body'));

    await page.goto('https://mirrorconcierge.com/discover', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);
    await autoScroll(page);
    const inv = parseInventory(await page.innerText('body'));

    if (hunt.length === 0 && inv.priced.length === 0) throw new Error('no items parsed (layout may have changed)');
    return { status: 'ok', site: 'https://mirrorconcierge.com', hunt, inventoryPriced: inv.priced, inventoryCounts: inv.counts };
  } finally {
    await ctx.close();
  }
}

async function scrapeStockxGoyard(browser) {
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  try {
    await page.goto('https://stockx.com/search?s=goyard', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3500);
    const body = await page.innerText('body');
    if (/Access Denied|captcha|unusual traffic|are you a human/i.test(body)) throw new Error('bot-blocked');
    // Cards render as: name line, then "Lowest Ask $X". Pair them up.
    const lines = cleanLines(body);
    const items = [];
    const re = /^\$([\d,]+)/;
    for (let i = 1; i < lines.length; i++) {
      const m = lines[i].match(re);
      if (m && /Goyard/i.test(lines[i - 1])) {
        items.push({ item: lines[i - 1].replace(/Goyard/i, '').trim(), price: Number(m[1].replace(/,/g, '')) });
      }
    }
    if (!items.length) throw new Error('no StockX items parsed');
    return { status: 'ok', query: 'goyard', items };
  } finally {
    await ctx.close();
  }
}

async function main() {
  const date = today();
  const prev = previousSnapshot(date + '~'); // '~' > any date char, so this includes an existing same-day file
  const errors = [];
  const indices = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'indices.json'), 'utf8'));
  delete indices._comment;

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  let mirror, stockx;
  try {
    try { mirror = await scrapeMirror(browser); }
    catch (e) {
      errors.push({ source: 'mirror', error: String(e.message || e) });
      mirror = prev?.sources?.mirror ? { ...prev.sources.mirror, status: 'carried' } : { status: 'error', hunt: [], inventoryPriced: [], inventoryCounts: [] };
    }
    try { stockx = await scrapeStockxGoyard(browser); }
    catch (e) {
      errors.push({ source: 'stockx_goyard', error: String(e.message || e) });
      stockx = prev?.sources?.stockx_goyard ? { ...prev.sources.stockx_goyard, status: 'carried' } : { status: 'error', items: [] };
    }
  } finally {
    await browser.close();
  }

  const snapshot = {
    date,
    capturedAt: new Date().toISOString(),
    capture: { method: 'scrape', errors },
    sources: {
      mirror,
      stockx_goyard: stockx,
      indices: { status: 'reference', ...indices }
    }
  };

  ensureDir(SNAP_DIR);
  writeFile(path.join(SNAP_DIR, `${date}.json`), JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`[scrape] wrote ${date}.json — mirror:${mirror.status} hunt:${mirror.hunt?.length ?? 0} inv:${mirror.inventoryPriced?.length ?? 0} stockx:${stockx.status}` + (errors.length ? ` (errors: ${errors.map(e => e.source).join(', ')})` : ''));
}

main().catch(e => { console.error(e); process.exit(1); });
