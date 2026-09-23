// Rule fixtures for the Chrome Hearts watch.
//
// The rules are the whole product here: a term list that is too tight misses a
// $25,000 find, and one that is too loose trains the reader to ignore Slack.
// Both failures are silent, so the cases below pin the boundary using real
// titles, the grail ones taken from Eli's own catalogue and the rejects from
// the standard tier that sits beside them.
//
// Run with: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { matchItem } from '../src/lib/watchlist.mjs';
import { ROOT } from '../src/lib/util.mjs';

const wl = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/watchlist.json'), 'utf8'));
const watches = wl.watches ?? wl;
const ch = watches.find(w => w.id === 'chrome-hearts-denim');
assert.ok(ch, 'chrome-hearts-denim watch is missing');

// [title, price, shouldMatch]
const CASES = [
  // Grail tier: a collaboration name, a city or event exclusive, or denim
  // construction, priced where this tier actually trades.
  ['Chrome Hearts Matty Boy Sex Records Camo Desert Bomber Jacket', 9500, true],
  ['Chrome Hearts Levi 505 Art Basel Miami Exclusive Blue Patch Jeans', 20000, true],
  ['Chrome Hearts Cheetah Cross Patch Double Knee Carpenter Pants', 17000, true],
  ['Chrome Hearts Black Cross Patch Fleur Knee Jeans', 12000, true],
  ['Chrome Hearts Dark Wash Levi 517 Red Patch Stencil', 13000, true],
  ['Chrome Hearts x Gallery Dept Levis 501 Flare Denim', 25500, true],
  ['Chrome Hearts Camo Leather Patch Spine Vest', 6500, true],

  // Standard tier. Hoodies and tees are explicitly out of scope, and the price
  // floor rather than a term is what keeps them out, so these also guard the
  // floor against being lowered to chase recall.
  ['Chrome Hearts Miami Exclusive Horseshoe Hoodie', 1400, false],
  ['Chrome Hearts Black On Black Horseshoe Logo Hoodie', 900, false],
  ['Chrome Hearts Horseshoe Logo T Shirt', 650, false],
  ['Chrome Hearts Matty Boy Cargo Sick Hearts Sweat Shorts', 900, false],

  // Wrong kind entirely. Jewelry and eyewear clear the floor easily, which is
  // why kind is judged before price.
  ['Chrome Hearts Sterling Silver Cross Pendant Necklace', 8500, false],
  ['Chrome Hearts Sunglasses Gittin Any', 6000, false],

  // Not the real thing, and not the real brand.
  ['Chrome Hearts INSPIRED cross patch jeans replica', 5500, false],
  ['Levi 501 cross patch jeans (no brand)', 9000, false],
];

let failures = 0;
for (const [title, price, want] of CASES) {
  const r = matchItem({ title, price, id: 'test', sellerPct: 99, sellerScore: 500 }, ch);
  const got = r !== null && r.verdict === 'match';
  if (got !== want) {
    failures++;
    console.error(`FAIL want=${want} got=${got}  $${price}  ${title}`);
  }
}

// A credible seller is required before a five-figure ask means anything.
const weak = matchItem({ title: 'Chrome Hearts Cross Patch Fleur Knee Jeans', price: 25900, id: 't', sellerPct: 0, sellerScore: 0 }, ch);
assert.equal(weak?.verdict, 'weak-seller', 'a zero-rating seller should be held back, not matched');

// An ask above the cap is reported rather than matched, so it can be reviewed.
const over = matchItem({ title: 'Chrome Hearts Levi 501 Cross Patch Jeans', price: 121010, id: 't', sellerPct: 99, sellerScore: 300 }, ch);
assert.equal(over?.verdict, 'over-cap', 'an ask above maxPrice should be flagged over-cap');

assert.equal(failures, 0, `${failures} rule fixture(s) failed`);
console.log(`[test] watchlist: ${CASES.length} fixtures + 2 verdict checks passed`);
