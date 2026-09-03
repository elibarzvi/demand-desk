# Demand Desk

A self-updating luxury demand tracker. Every day it captures what luxury buyers
are requesting and what's being supplied (and at what price), keeps an
append-only snapshot for that day forever, rolls the whole history into
exportable CSV sheets, and redeploys a dashboard, all on free GitHub
infrastructure with no server to run.

## What it tracks

| Source | Signal | Cadence |
|---|---|---|
| **Fashionphile** | Full price distribution (p10/median/p90) per brand segment, live listing counts, condition mix, and per-SKU sell-through | Daily |
| **Mirror** (mirrorconcierge.com) | Buyer request feed + sourcer inventory, via its public JSON API. Editorial, not live: see the note below | Daily capture, rare change |
| **StockX** | Lowest ask per brand + Goyard detail. Result counts are capped by StockX at 1000 and are recorded as capped rather than published as counts | Daily (best-effort) |
| **eBay** | Active fixed-price listing count + floor price per brand (official Browse API) | Daily |
| **DataForSEO, search volume** | Google monthly search volume per brand (demand size) | Weekly (it is a monthly average) |
| **DataForSEO, Google Trends** | Daily search interest per brand, anchored to a shared keyword so brands are comparable across batches | Daily |
| **The RealReal** | Most-searched brands + resale value climbers | Report-based reference |
| **Vestiaire Collective** | Value ranking + fastest-growing/selling (Cloudflare-blocked to servers) | Report-based reference |
| **myGemma Luxury Resale Index** | Most-searched brands & handbags | Carried; refresh on new edition |
| **The Lyst Index** | Fashion-wide brand heat | Carried; refresh quarterly |
| **Rebag Clair Report** | Resale value retention | Carried; refresh annually |

The three index reports publish quarterly/annually, so they're stored in
[`src/data/indices.json`](src/data/indices.json) and carried into every daily
snapshot as reference values (each with its own `asOf` date). Update that one
file when a new edition drops.

## How it works

```
scripts/scrape.mjs     →  data/snapshots/YYYY-MM-DD.json  (append-only daily log, kept in git forever)
                       →  data/state/fp-live.json.gz      (live SKU set, rewritten daily, powers sell-through)
scripts/export-csv.mjs →  data/exports/*.csv              (tidy time-series, any date range pivots in Excel)
scripts/derive.mjs     →  data/derived/{metrics,alerts}.json  (baselines, z-scores, streaks, alerts, signals)
scripts/notify.mjs     →  Slack alerts channel, only when something is notable
scripts/digest.mjs     →  Slack digest channel, weekly market summary
scripts/build-site.mjs →  site/data/*                     (latest + history + derived + exports)
site/index.html        →  the hosted dashboard
```

- **Day 0 is today**: [`data/snapshots/2026-08-04.json`](data/snapshots/2026-08-04.json)
  is the first real capture. Every day after is added by the scheduled job.
- **Nothing is ever overwritten.** One file per day; the git history is the
  permanent archive.
- **The log never breaks.** If a source fails (layout change, bot-block), the
  scraper carries the previous day's values forward, marks them `carried`, and
  records the error in `capture.errors`.

## Exports

After any run, `data/exports/` holds tidy CSVs you can open in Excel/Sheets and
filter to any range (a day, a week, all-time):

- `fashionphile.csv`: `date, brand, segment, listings_all, listings_segment, p10_price, median_price, p90_price, mean_price, legacy_low_price`
- `fp-sell-through.csv`: `date, brand, live, arrivals, departures, turnover_pct, median_days_to_sell, median_departure_price`
- `fp-sold.csv`: one row per item that sold, with `sku, price, listed, days_to_sell`
- `fashionphile-condition.csv`: `date, brand, condition, count`
- `signals.csv`: `brand, scarcity, demand_z, supply_z, turnover_pct, median_price, median_days_to_sell`
- `alerts.csv`: `date, type, severity, series, brand, value, z, message`
- `mirror-hunt.csv`: `date, brand, item, requesters`
- `mirror-inventory-priced.csv`: `date, brand, item, price`
- `mirror-supply-mix.csv`: `date, brand, listing_count`
- `stockx-goyard.csv`: `date, item, low, high`
- `indices-search-rank.csv`: `date, source, type, rank, entity`
- `rebag-retention.csv`: `date, brand, retention_pct, report_year, appreciates`
- `daily/YYYY-MM-DD/{hunt,inventory}.csv`: per-day sheets

The same files are downloadable from the dashboard's Exports section.

## Reading the numbers

A few things are worth knowing before you act on a figure.

**Median price, not lowest price.** The price columns describe the whole live
inventory of one segment (handbags, or fine jewelry for Cartier), computed from
Algolia's complete price facet rather than a sample. Earlier snapshots recorded a
single `legacy_low_price`, which was the cheapest object the brand sells: Chanel
read `$95` because of a nylon cosmetic pouch. That column is kept for continuity
and should not be read as a market price.

**Sell-through is a departure count.** Each listing is one physical item, so a SKU
that leaves the live index has sold or been withdrawn. `days_to_sell` is measured
from the item's own listing date, which predates this log, so it is meaningful
from the first comparison rather than only after months of history.

**Scarcity is a z-score difference.** `demand_z - supply_z`, each scored against
that series' own 28-day history. Positive means demand is growing faster than the
inventory arriving to meet it. It replaced a ratio of monthly search volume to
eBay listings, which produced a byte-identical ranking on all 24 days it ran,
because both of its inputs were effectively constant.

**Google Trends is a relative index, not a raw score.** Trends normalizes 0-100
within a single request, which breaks comparability twice over. Across brands, two
batches are two different scales, fixed by carrying a shared anchor keyword in
every batch. Across days, Google renormalizes the whole 30-day window to max=100
on every request, so when the window slides and its peak changes, every brand
rescales at once: on 2026-08-30 all five batch-one brands appeared to surge
together, and Louis Vuitton's raw value swung 78 percent over eight days while its
level relative to the other brands swung 25 percent. Each brand is therefore stored
divided by the mean across all tracked brands that day, which cancels the shared
factor. Raw values captured before this fix are not a valid time series and are
excluded rather than spliced onto a different scale.

**One condition, one alert.** A single Trends move was once reported three times
over as a breakout, a streak and a weekly move. Only the most informative alert per
series and brand survives. Notifications also carry a three-day cooldown, because
the capture runs three times daily and a value sitting near a threshold would
otherwise re-announce itself on every run.

**Some numbers are recorded but not alerted on.** StockX result counts stop at
1000, so a `1000` means "at least 1000" and is stored as `results_capped`. StockX
lowest ask and monthly search volume are charted but excluded from alerting: the
first is a junk floor, the second only moves when a monthly bucket rolls over.

**Baselines are robust, and captures are sanity-checked.** On 2026-08-10 the
Fashionphile index was mid-rebuild and returned 41 Chanel listings instead of
7326, with every field well formed and the capture recorded as ok. That one point
inflated the standard deviation of every affected series by three to eight times,
and because a z-score divides by that spread, it silently suppressed real
breakouts for weeks. Two changes follow from it. Baselines now use the median and
MAD rather than the mean and standard deviation, which barely move under the same
corruption (Chanel's median shifted by 3 listings out of 7300). And a capture
whose total collapses by more than half against the previous day is rejected
outright, which carries the previous values forward and leaves the SKU state
untouched so sell-through is not handed a phantom set of departures.

**There is no weekly cycle in supply.** Pooling daily changes by weekday appeared
to show a large Monday drop and Tuesday rebound. That was entirely the corrupted
2026-08-10 capture. With it excluded, normal day-to-day movement is roughly 3
percent in either direction and no weekday stands out.

**Alerts require size as well as significance.** A breakout needs both a z-score
of 2 or more against the series' own baseline AND a move of at least 4 percent.
The z-score alone was not enough: eBay listing counts are stable to within about
1 percent, so a 2.3 percent drift in Cartier cleared two standard deviations and
was reported as a breakout despite meaning nothing. Bounded 0-100 index series
carry a level floor too, because Goyard's Trends interest sits near 21, where one
integer point is 4.8 percent and a routine 4-point wobble looked like a 19 percent
collapse.

**Slack notifications come from the pipeline, not from a person.** `scripts/notify.mjs`
posts to a Slack app called Demand Desk via an incoming webhook, using the
`SLACK_WEBHOOK_URL` secret. It runs after `derive` and before the commit, so it can
diff today's alerts against the version still at HEAD and report only what is new
rather than re-announcing an ongoing situation every morning. It stays silent on a
normal day, ignores the chronic `mirror` and `search_volume` staleness while still
reporting either one recovering, and additionally flags pipeline failures: a
Fashionphile error, a new capture error, or a sell-through reading that is
impossible (departures above the live count) or implausible (turnover above 10
percent in a day). Without the secret it no-ops, so local runs and forks never
post, and it is deliberately excluded from `npm run all` for the same reason. A
failure to notify never fails the capture.

**Two Slack channels, on purpose.** Alerts (`notify.mjs`) interrupt you and stay
rare; the digest (`digest.mjs`) is routine reading you open when you want it. They
post to different channels through different webhooks, `SLACK_WEBHOOK_URL` and
`SLACK_DIGEST_WEBHOOK_URL`. Routine traffic in the alert channel would train you to
skim it, and the one message that mattered would get skimmed with everything else.

**Model-level tracking.** Brand aggregates cannot say whether the Birkin 25 is
moving, so 20 named models are tracked individually for live count, price
percentiles and units sold. Matching is stricter than it looks: a plain search for
"Chanel 19" returns 4780 items including sunglasses, because Algolia matches
description text. Models are matched as an exact quoted phrase, restricted to the
title, inside bag categories only, with small leather goods sharing a model name
filtered out in code so a card holder does not drag down a Birkin median. The
digest reports what actually sold, not what was inquired about: Mirror's request
feed is the only "inquiries" source and it is editorial, so unit sales, days to
sell and price movement are used instead.

**Mirror is an editorial feed.** Its request list changed twice in the first 24
days and its API is healthy, so the feed itself is curated rather than live. The
dashboard labels it with how long it has been static instead of presenting it as
daily demand. The staleness detector flags any source that stops changing for
three days, which is what surfaced this.


## Run it locally

```bash
npm install
npx playwright install chromium
npm run all      # scrape today + export CSVs + derive metrics + build site
npm run serve    # preview at http://localhost:8080
```

`npm run all` will overwrite today's snapshot with a fresh capture; older days
are untouched.

## Deploy (GitHub Pages + Actions)

```bash
gh repo create demand-desk --private --source . --remote origin --push
```

Then in the repo: **Settings → Pages → Build and deployment → Source: GitHub
Actions**. The [daily workflow](.github/workflows/daily.yml) runs at 08:17 UTC,
commits that day's snapshot, regenerates the CSVs, and redeploys the site. Run
it immediately once from the **Actions** tab (**Daily capture → Run workflow**)
to confirm the pipeline end to end.

## A note on sources

Demand Desk reads only public pages, once a day. Mirror's Terms discourage
automated extraction; this is a low-volume personal market tracker, but review
that yourself before scheduling. The index reports (myGemma, Lyst, Rebag) are
public and stored as attributed reference data. Figures are point-in-time reads
for buying research, not investment advice.
