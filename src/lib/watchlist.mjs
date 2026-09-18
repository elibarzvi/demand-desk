// Item-level matching for the grail watches.
//
// Deliberately a readable rule set rather than a model. With a few dozen examples
// there is nothing to learn statistically, and a rule you can read is a rule you
// can correct when it misfires. The probe that motivated this showed why price
// alone cannot work: "Chrome Hearts" above $5000 returns 3478 listings, led by an
// $83,005 diamond necklace and $80,466 gold bracelets. Separating grails from the
// standard catalogue is a vocabulary problem, not a threshold problem.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './util.mjs';

export const WATCHES = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src', 'data', 'watchlist.json'), 'utf8')
).watches;

// Word-boundary matching, so "ring" does not fire on "earring" and "cap" does not
// fire on "capsule". Terms containing spaces are matched as phrases.
function hasTerm(haystack, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack);
}

// Returns null when the listing does not qualify, otherwise the reason it did.
// Reporting why something matched matters as much as matching: a rule set is only
// maintainable if a wrong hit tells you which term to fix.
export function matchItem(item, watch) {
  // Items arrive already normalised by src/lib/watch-sources.mjs: a flat numeric
  // price, an id, and seller figures as numbers. The first version read eBay's raw
  // shape (price.value, itemId), so once sources were normalised every price read
  // as null and a live run matched 0 of 51 Birkin 25s.
  const title = String(item.title || '');
  const hay = ' ' + title.toLowerCase() + ' ';
  const price = item.price != null ? Number(item.price) : null;

  if (price == null) return null;
  if (watch.minPrice != null && price < watch.minPrice) return null;

  // Decide what KIND of thing this is before judging its price. Checking the cap
  // first surfaced an $83,005 diamond necklace as a near-miss worth reviewing,
  // when it should never have been a candidate: it is jewelry, not denim.
  for (const t of watch.require?.all || []) if (!hasTerm(hay, t)) return null;

  const anyTerms = watch.require?.any || [];
  const hit = anyTerms.length ? anyTerms.filter(t => hasTerm(hay, t)) : [];
  if (anyTerms.length && !hit.length) return null;

  const blocked = (watch.exclude || []).filter(t => hasTerm(hay, t));
  if (blocked.length) return null;

  // Only now does price credibility apply, and only to something already of the
  // right kind. A genuine grail at an absurd ask is worth seeing; a necklace is not.
  if (watch.maxPrice != null && price > watch.maxPrice) {
    return { ...base(item, price, watch), verdict: 'over-cap', why: `matched on ${hit.join(', ')} but asks above the $${watch.maxPrice.toLocaleString('en-US')} credibility cap` };
  }

  // Credibility. eBay lists asking prices from anyone, so a five-figure ask from a
  // brand new account is noise rather than a find.
  const pct = item.sellerPct ?? null;
  const score = item.sellerScore ?? null;
  const weak = [];
  if (watch.minSellerFeedbackPct != null && pct != null && pct < watch.minSellerFeedbackPct) weak.push(`seller feedback ${pct}%`);
  if (watch.minSellerFeedbackScore != null && score != null && score < watch.minSellerFeedbackScore) weak.push(`only ${score} seller ratings`);

  return { ...base(item, price, watch), verdict: weak.length ? 'weak-seller' : 'match', why: `matched on ${hit.join(', ')}`, concerns: weak };
}

// Carry the whole normalised listing through, so the lifecycle store receives
// source, id, url and listing date without re-deriving them.
function base(item, price, watch) {
  return { ...item, watch: watch.id, price };
}

// Run a whole feed through one watch, keeping only real matches and separating the
// near-misses so a rule can be tuned against what it rejected.
export function applyWatch(items, watch) {
  const matches = [], flagged = [];
  const seen = new Set();
  for (const it of items) {
    const r = matchItem(it, watch);
    if (!r) continue;
    const k = `${r.source}:${r.id}`;
    if (seen.has(k)) continue;                        // same listing across queries
    seen.add(k);
    (r.verdict === 'match' ? matches : flagged).push(r);
  }
  matches.sort((a, b) => b.price - a.price);
  flagged.sort((a, b) => b.price - a.price);
  return { matches, flagged };
}
