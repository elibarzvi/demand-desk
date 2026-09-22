# Saved searches on The RealReal and Grailed

Neither site has a usable public API, and both sit behind bot protection
(PerimeterX on The RealReal, Cloudflare on Grailed), so Demand Desk cannot poll
them the way it polls eBay and Fashionphile. The workaround is to let each site
do the watching itself and email the results. These saved searches are the
sensors; the alert emails they produce are the feed that the Apps Script mail
reader will parse into `data/state/watch-items.json`.

Saved 2026-09-22 in Eli's own logged-in accounts. Names are prefixed `DD` so they
are distinguishable from anything he saves by hand.

## The RealReal (My TRR, Saved Searches, `/my_trr/feeds`)

| Feed | Query | ID |
| --- | --- | --- |
| DD Chrome Hearts Jeans | `chrome hearts jeans` | 12405709 |
| DD Chrome Hearts Cross Patch | `chrome hearts cross patch` | 12405716 |
| DD Chrome Hearts Levis | `chrome hearts levis` | 12405719 |
| DD Hermes Birkin 25 | `hermes birkin 25` | 12405722 |
| DD Hermes Kelly 25 | `hermes kelly 25` | 12405727 |
| DD The Row Margaux | `the row margaux` | 12405730 |

Two things to know about these.

The RealReal's keyword search ORs its terms rather than ANDing them, so the
`chrome hearts levis` feed also returns plain Levi's at $37. No price floor is
set on any feed, deliberately: the floor lives in `src/data/watchlist.json`
(`minPrice: 5000`) so it can be tuned in one place, and so an underpriced grail
listed at $4,500 is still seen rather than filtered away at the source.

A bare `hermes kelly` redirects to the curated landing page
`/sales/hermes-kelly-bag`, which has no Save Search control. `hermes kelly 25`
returns a real results page, which is why the feed is model-specific.

## Grailed (`/mygrails/searches`)

| Followed search | Query | Price filter |
| --- | --- | --- |
| DD Chrome Hearts Jeans 5k+ | `chrome hearts jeans` | $5,000 and over |
| DD Chrome Hearts Levis 5k+ | `chrome hearts levis` | $5,000 and over |
| DD Chrome Hearts Cross Patch 5k+ | `chrome hearts cross patch` | $5,000 and over |
| DD Chrome Hearts Carhartt 5k+ | `chrome hearts carhartt` | $5,000 and over |
| DD The Row Margaux | `the row margaux` | none |

All five are set to Email and Push, frequency Daily. Daily is the fastest
Grailed offers; the only other choice is Weekly. That is slow for a market where
grails sell in hours, so Grailed is the slow lane and the hourly eBay watch in
`scripts/watch.mjs` stays the fast one.

Grailed's price filter is a URL parameter, `&price=5000%3A1000000`, so these
searches can be rebuilt without clicking through the filter panel.

The Row Margaux carries no price floor because Grailed holds only 20 Margaux
listings in total, spanning $1,395 to $12,500. A $5,000 floor would have
discarded most of them.

## Email delivery

These searches only matter if their mail arrives. See `docs/email-alerts.md`.

## Turning the mail into listings

`docs/apps-script/inspect-mail.gs` reads the alert mail in place and logs its
shape, so the parser can be written against a real template rather than a guess.
It is read-only and sends nothing. Run `inspectAlertMail` first to see what has
arrived, then `dumpMessage` on one alert to see how its listings are laid out.
