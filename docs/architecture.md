# How Demand Desk works

Two independent loops, running on different clocks for different reasons, over a
shared pile of daily snapshots. Nothing depends on a machine at home being awake.

## The two loops

**The watch** hunts individual listings. It runs every hour, because grails sell
in hours and a listing found the next morning is a listing someone else bought.
It reads marketplaces, decides whether anything crossed a rule, posts to Slack,
and writes a small state file. It never touches the statistics.

**The capture** builds market statistics. It runs three times a day and is
idempotent, so extra runs re-derive the day rather than appending to it. It
pulls every source, diffs inventory to infer what sold, computes the series,
raises alerts, sends the digest, and commits a permanent snapshot.

The split exists because the two jobs have opposite shapes. The watch must be
fast, narrow and frequent. The capture is slow, broad and cumulative, and its
value comes from having 51 days of history rather than from being current to the
minute.

## What drives the clocks

GitHub's cron is best effort. Measured over 96 hours it fired an hourly schedule
every 3.3 hours on average, worst gap 7h49m, about 7.5 runs a day instead of 24.

So the hourly cadence is driven from outside, by a Google Apps Script timer that
calls GitHub's dispatches API with `event_type: watch-now`. Verified on
2026-09-22: dispatches landed at 21:56:56, 22:56:56 and 23:56:56 UTC, holding to
the second. The repository cron stays configured as a floor in case the external
caller stops. See `docs/apps-script/demand-desk.gs`.

## Sources

| Source | What it gives | How |
| --- | --- | --- |
| Fashionphile | Price distribution, inventory, and the SKU set | Public Algolia index, price facet read as a histogram so percentiles are exact over the whole population rather than a sample |
| Fashionphile diff | Sell-through, days to sell, departure prices | Yesterday's live SKUs minus today's. Resale is one-of-one, so a SKU that vanishes has left the market |
| eBay | Active listing counts, and every watch candidate | Browse API. Marketplace Insights, which carries sold prices, was requested and refused |
| StockX | Lowest ask | Browser-rendered, so it runs under Playwright |
| Google Trends | Relative search interest | DataForSEO |
| Google Ads | Monthly search volume | DataForSEO, refreshed weekly because each call is paid and the figure is a monthly average |
| Mirror | Live buyer requests with counts | `mirrorconcierge.com` public API. The only demand-side signal here; everything else measures supply, price or curiosity |

The Fashionphile diff is the closest thing to a transaction feed obtainable
without private data, and it is why the tool can say how long something takes to
sell rather than only what it costs.

## What gets computed

Ten series, each tracked per brand: listings, tracked-segment listings, median
price, 90th percentile price, sell-through, days to sell, eBay listings, Trends
interest, search volume, StockX low.

Baselines are median and MAD rather than mean and standard deviation. On
2026-08-10 a corrupted capture returned 41 Chanel listings instead of 7,326 with
`status: ok` and no error, which inflated the standard deviation by up to 8x and
silently suppressed real breakouts for weeks afterward. A median baseline barely
notices one bad day. A capture that collapses more than 50% now also fails
outright rather than being recorded.

Alerts are deliberately hard to trigger, because noise is what makes a dashboard
stop being read. A move needs z >= 2, at least 4% of change, and a level worth
reading at all. When most brands in one series move together it is collapsed
into a single line naming it as probably an artifact, since ten brands do not
independently decide the same thing on the same day.

Sell-through is stated per 24h. The gap between captures swings between 14h and
28h with cron drift, and a 14h window landing in overnight US hours once made
sell-through look like it had collapsed 75% across ten brands at once.

## Where output goes

- **Slack**, three channels by purpose: watch events, statistical alerts, and the
  daily digest with a fuller Monday edition. Every line carries a cooldown key,
  so a condition that persists is not re-sent daily.
- **The site**, at `elibarzvi.github.io/demand-desk`. A dashboard, plus a
  listings browser that reads the watch state directly from raw.githubusercontent
  so it shows current holdings without a rebuild.
- **The repository**, which is the permanent record: one snapshot per day, CSV
  exports per series, and a ZIP of the whole dataset.

## What is wired, and what is not

Wired end to end: Fashionphile, eBay, StockX, Trends, search volume, Mirror, the
hourly watch, Slack, the site, the external scheduler.

Not yet closed: The RealReal and Grailed. Both sit behind bot protection
(PerimeterX and Cloudflare), so they cannot be polled. Instead saved searches on
each site watch on our behalf and email the results, and a reader will parse that
mail inside Apps Script so the mail credential never leaves Google. The searches
exist and delivery has been checked; the parser waits on a real alert email to be
written against. See `docs/saved-searches.md` and `docs/email-alerts.md`.

Also absent by design so far: target prices. The watch can say a listing exists
and matches, not that it is cheap. That is the largest remaining gap between this
being a notifier and being a buying tool.
