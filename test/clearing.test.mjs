// Fixtures for the clearing-time model behind the overdue list.
//
// The failure mode here is quiet and expensive: a threshold built from too few
// comparables, or from the wrong price band, produces a confident ranking of
// nonsense. These pin the guards rather than the happy path.
import assert from 'node:assert/strict';
import { buildClearingModel, bandFor, findOverdue, enrichOverdue, MIN_BAND_COMPS } from '../src/lib/clearing.mjs';

// Helper: n sold rows for one brand at a given price and clearing time.
const rows = (brand, price, days, n) =>
  Array.from({ length: n }, () => ({ brand, price, daysToSell: days }));

// --- model construction ----------------------------------------------------

// Five price tiers, well above the per-band minimum, with clearing time that
// FALLS as price rises, which is the real shape in this market.
const sold = [
  ...rows('Hermès', 1000, 90, 40),
  ...rows('Hermès', 3000, 70, 40),
  ...rows('Hermès', 6000, 60, 40),
  ...rows('Hermès', 12000, 50, 40),
  ...rows('Hermès', 25000, 30, 40),
];
const model = buildClearingModel(sold);
assert.ok(model.byBrand['Hermès'], 'brand with ample history should be modelled');
assert.equal(model.byBrand['Hermès'].bands.length, 5, 'should split into five bands');
assert.ok(model.byBrand['Hermès'].bands.every(b => b.usable), 'every band here clears the comp minimum');

// A cheap item and a grail must land in different bands, and the expensive band
// must carry the FASTER threshold. Comparing a Birkin against its brand's
// overall median would flag every grail as overdue merely for being expensive.
const cheap = bandFor(model, 'Hermès', 1000);
const grail = bandFor(model, 'Hermès', 25000);
assert.notEqual(cheap.lo, grail.lo, 'a $1k piece and a $25k piece are not comparables');
assert.ok(grail.p75Days < cheap.p75Days, 'top band should clear faster in this fixture');

// A brand without enough history must be absent, not modelled from noise.
const thin = buildClearingModel(rows('Obscure', 500, 40, MIN_BAND_COMPS * 5 - 1));
assert.equal(thin.byBrand['Obscure'], undefined, 'a thin brand must be skipped entirely');
assert.equal(bandFor(thin, 'Obscure', 500), null, 'and must yield no band');

// Impossible clearing times are data errors, not six-year listings.
const dirty = buildClearingModel([...sold, ...rows('Hermès', 25000, 5000, 50), ...rows('Hermès', 1000, -3, 50)]);
assert.ok(dirty.byBrand['Hermès'].bands.every(b => b.p75Days < 2000), 'absurd durations must be dropped');

// --- overdue detection -----------------------------------------------------

const today = '2026-10-07';
const live = {
  date: today,
  brands: {
    'Hermès': {
      'fresh':     { l: '2026-09-20', p: 25000 },            // 17d, well inside
      'overdue':   { l: '2025-10-07', p: 25000 },            // 365d, far past
      'borderline':{ l: '2026-08-20', p: 25000 },            // 48d vs 30 p75 -> 1.6x
      'nodate':    { p: 25000 },                             // unusable, must not throw
      'nothisbrand': { l: '2024-01-01', p: 0 },              // no price
    },
    'Obscure': { 'x': { l: '2020-01-01', p: 500 } },         // unmodelled brand
  }
};
const found = findOverdue(live, model, today);
const skus = found.map(f => f.sku);
assert.ok(skus.includes('overdue'), 'a 365-day-old grail must be flagged');
assert.ok(!skus.includes('fresh'), 'a 17-day-old listing must not be');
assert.ok(!skus.includes('nodate'), 'a listing with no date must be skipped, not guessed');
assert.ok(!skus.includes('x'), 'an unmodelled brand must never be scored');
// Pins OVERDUE_FACTOR itself: 48 days against a 30-day p75 is 1.6x, just over
// the 1.5x line. If the factor is ever retuned this is the test that notices.
assert.ok(skus.includes('borderline'), 'a listing at 1.6x the band p75 must be flagged');

assert.deepEqual(found.map(f => f.overdueRatio), [...found.map(f => f.overdueRatio)].sort((a, b) => b - a),
  'results must be sorted by how overdue they are');

// `listed` is Fashionphile's own date and predates our log; `firstSeen` is only
// when we started looking. Using firstSeen would reset the clock on every item
// that was already old when tracking began.
const bothDates = findOverdue({ date: today, brands: { 'Hermès': { s: { l: '2025-10-07', f: '2026-10-01', p: 25000 } } } }, model, today);
assert.equal(bothDates.length, 1, 'should use the listing date, not when we first saw it');
assert.ok(bothDates[0].ageDays > 300, `expected age from listed date, got ${bothDates[0].ageDays}`);

// --- enrichment ------------------------------------------------------------

// A SKU-shaped query can match another product's description. Taking that hit
// would attach the wrong title, URL and price to a real listing.
const wrongHit = async () => ({ ok: true, json: async () => ({ hits: [{ sku: '999', handle: 'other', title: 'Not It', price: 1 }] }) });
const [item] = await enrichOverdue([{ sku: '123', price: 100 }], { fetchImpl: wrongHit });
assert.equal(item.title, undefined, 'a mismatched SKU must not be attached');

const rightHit = async () => ({ ok: true, json: async () => ({ hits: [{ sku: '123', handle: 'a-bag-123', title: 'A Bag', price: 80 }] }) });
const [ok] = await enrichOverdue([{ sku: '123', price: 100 }], { fetchImpl: rightHit });
assert.equal(ok.url, 'https://www.fashionphile.com/products/a-bag-123');
assert.equal(ok.markdownPct, 20, 'a cut from 100 to 80 is 20%');

// Enrichment is best effort: the list must survive the network failing.
const boom = async () => { throw new Error('network down'); };
const [survived] = await enrichOverdue([{ sku: '123', price: 100, ageDays: 400 }], { fetchImpl: boom });
assert.equal(survived.ageDays, 400, 'a failed lookup must leave the row intact');

console.log('[test] clearing: model, bands, overdue detection and enrichment guards passed');
