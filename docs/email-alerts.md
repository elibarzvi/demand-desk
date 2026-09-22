# Alert email delivery

The saved searches in `docs/saved-searches.md` are only as good as the mail they
produce. Checked 2026-09-22 after Eli unsubscribed from both sites' promotional
mail.

## Grailed: healthy

`/users/notifications` shows Price Drops and Followed Searches both enabled for
Email and Push, along with everything else on the page. The promo unsubscribe did
not touch these toggles.

One caveat that the settings page cannot answer: clicking "unsubscribe" in an
email footer often adds the address to a suppression list held by the mail
provider, which sits underneath these per-category toggles and does not show up
here. If Followed Search mail never arrives despite these being on, that is the
likely cause, and the fix is to ask Grailed support to clear the suppression
rather than to keep toggling this page.

## The RealReal: was broken by the unsubscribe, now fixed

`/account/preferences/email_preferences` offers exactly four delivery cadences,
and after the unsubscribe none of them is selected:

- Daily, 7am and 4pm PT sales, consignment offers and special updates
- Once a day
- Once a week
- When Personalized, only messages about my Obsessions and consignments

All five "I am interested in" category boxes are also cleared. The only thing
still switched on is "I would like to receive consignment offers and
newsletters: Yes", which is the promotional track, not the alerting one.

With no cadence selected there is no schedule on which The RealReal can send
anything, so saved-search and Obsession mail has nowhere to go.

"When Personalized" is the narrowest setting that still sends mail, and its own
description limits it to Obsessions and consignments. Note that the page never
mentions Saved Searches by name, so whether feed mail rides on this setting is
not something the page states. It has to be confirmed by switching it on and
watching for a feed email.

### The fix, applied 2026-09-22

"When Personalized" is now selected and "consignment offers and newsletters" is
set to No, so the account sends Obsession and consignment mail and nothing else.
The five category interest boxes were left cleared on purpose, since they steer
promotional mail rather than alerts.

If saved-search mail still does not arrive, try in this order. First tick the
interest categories that cover the watchlist, Women and Jewelry, in case The
RealReal gates all sending on having at least one. Second, suspect a suppression
list held by their mail provider, which sits underneath this page and is only
clearable by their support team.
