# Demand Desk

A self-updating luxury demand tracker. Every day it captures what luxury buyers
are requesting and what's being supplied (and at what price), keeps an
append-only snapshot for that day forever, rolls the whole history into
exportable CSV sheets, and redeploys a dashboard, all on free GitHub
infrastructure with no server to run.

## What it tracks

| Source | Signal | Cadence |
|---|---|---|
| **Mirror** (mirrorconcierge.com) | Live request feed ("The Hunt") + sourcer inventory, via its public JSON API | Daily |
| **StockX** | Lowest ask + result count per brand (multi-brand) + Goyard detail | Daily (best-effort) |
| **Fashionphile** | Lowest buyable price + live listing count per focus brand (Algolia search API) | Daily |
| **eBay** | Active fixed-price listing count + floor price per brand (official Browse API) | Daily |
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
scripts/scrape.mjs   →  data/snapshots/YYYY-MM-DD.json   (append-only daily log, kept in git forever)
scripts/export-csv.mjs →  data/exports/*.csv              (tidy time-series, any date range pivots in Excel)
scripts/build-site.mjs →  site/data/*                     (latest + history + exports for the dashboard)
site/index.html      →  the hosted dashboard
```

- **Day 0 is today** — [`data/snapshots/2026-08-04.json`](data/snapshots/2026-08-04.json)
  is the first real capture. Every day after is added by the scheduled job.
- **Nothing is ever overwritten.** One file per day; the git history is the
  permanent archive.
- **The log never breaks.** If a source fails (layout change, bot-block), the
  scraper carries the previous day's values forward, marks them `carried`, and
  records the error in `capture.errors`.

## Exports

After any run, `data/exports/` holds tidy CSVs you can open in Excel/Sheets and
filter to any range (a day, a week, all-time):

- `mirror-hunt.csv` — `date, brand, item, requesters`
- `mirror-inventory-priced.csv` — `date, brand, item, price`
- `mirror-supply-mix.csv` — `date, brand, listing_count`
- `stockx-goyard.csv` — `date, item, low, high`
- `indices-search-rank.csv` — `date, source, type, rank, entity`
- `rebag-retention.csv` — `date, brand, retention_pct, report_year, appreciates`
- `daily/YYYY-MM-DD/{hunt,inventory}.csv` — per-day sheets

The same files are downloadable from the dashboard's Exports section.

## Run it locally

```bash
npm install
npx playwright install chromium
npm run all      # scrape today + export CSVs + build site
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
