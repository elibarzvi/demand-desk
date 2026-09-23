/**
 * Demand Desk scheduler, run from Google Apps Script.
 *
 * Why this exists: GitHub's own cron is best-effort. Measured over 96 hours to
 * 2026-09-22, an hourly schedule on this repository actually fired every 3.3
 * hours on average, with a worst gap of 7h49m, roughly 7.5 runs a day instead of
 * 24. That leaves blind spots most of a working day long, and grails sell in
 * hours, so the watch needs a scheduler that keeps its word. Apps Script triggers
 * are reliable, free, and run inside Google rather than on your machine, so
 * nothing here depends on your computer being awake.
 *
 * It also has a second job later: reading The RealReal and Grailed alert emails.
 * Doing that here rather than in GitHub Actions means your mail credential never
 * leaves Google. GitHub only ever receives listings, and the token stored here can
 * do nothing except talk to this one repository.
 *
 * SETUP
 *  1. script.google.com, New project, paste this file in.
 *  2. Project Settings, Script Properties, add:
 *       GITHUB_TOKEN   a fine-grained personal access token limited to the
 *                      demand-desk repository, with Contents: read and write.
 *                      github.com/settings/personal-access-tokens/new
 *  3. Run installTriggers once and approve the permissions prompt.
 *  4. Check Executions after an hour to confirm it is firing.
 *
 * Verified live on 2026-09-22. Three consecutive dispatches landed at 21:56:56,
 * 22:56:56 and 23:56:56 UTC, so the hourly cadence anchors to the install time
 * and holds to the second. Note that the first automatic fire is one full hour
 * after installTriggers rather than at some random minute inside that hour.
 *
 * Never paste the token into this file. Script Properties keeps it out of the
 * code, out of version control, and out of any copy of this script you share.
 */

var REPO = 'elibarzvi/demand-desk';
var DISPATCH_EVENT = 'watch-now';

/** Run once, by hand, to install the schedule. Safe to run again; it replaces. */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('runWatch').timeBased().everyHours(1).create();
  Logger.log('Hourly trigger installed. Check Executions to confirm it fires.');
}

/** Ask GitHub to run the grail watch now. */
function runWatch() {
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) throw new Error('GITHUB_TOKEN is not set in Script Properties');

  var res = UrlFetchApp.fetch('https://api.github.com/repos/' + REPO + '/dispatches', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' },
    payload: JSON.stringify({ event_type: DISPATCH_EVENT }),
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  // GitHub answers 204 with no body when the dispatch is accepted.
  if (code === 204) { Logger.log('watch dispatched'); return; }
  throw new Error('dispatch failed: HTTP ' + code + ' ' + res.getContentText().slice(0, 200));
}

/** Check the wiring without waiting an hour. Run this by hand after setup. */
function testNow() {
  runWatch();
  Logger.log('If that logged "watch dispatched", check the repository Actions tab for a Grail watch run.');
}
