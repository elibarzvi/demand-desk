/**
 * Demand Desk mail inspector, a second file in the same Apps Script project.
 *
 * Why this exists: The RealReal and Grailed both sit behind bot protection, so
 * Demand Desk cannot poll them the way it polls eBay and Fashionphile. Instead
 * the saved searches in docs/saved-searches.md make each site watch on our
 * behalf and mail the results. To turn that mail into listings we need a parser,
 * and a parser cannot be written against a hypothetical email.
 *
 * This file reads nothing into the repository and sends nothing anywhere. It
 * only looks at alert mail already in the inbox and logs enough of its shape,
 * subjects, link patterns, and a short text excerpt, to write the parser
 * against. Run inspectAlertMail by hand and paste the log back.
 *
 * SCOPE
 * This needs to read Gmail. Apps Script will otherwise request the broad
 * https://mail.google.com/ scope, which also grants send and delete. Narrow it
 * to read-only first: Project Settings, tick "Show appsscript.json manifest
 * file in editor", then open appsscript.json and add
 *
 *   "oauthScopes": [
 *     "https://www.googleapis.com/auth/script.external_request",
 *     "https://www.googleapis.com/auth/script.scriptapp",
 *     "https://www.googleapis.com/auth/gmail.readonly"
 *   ]
 *
 * Do that BEFORE running anything here. Apps Script remembers the first grant,
 * so narrowing afterwards means revoking the project under
 * myaccount.google.com/permissions and re-approving.
 */

// Where alert mail comes from, and what a listing link looks like on each site.
// newer_than keeps the search cheap and avoids trawling old promotional mail.
var MAIL_SOURCES = [
  { name: 'The RealReal', query: 'from:therealreal.com newer_than:30d', link: /therealreal\.com\/products\//i },
  { name: 'Grailed',      query: 'from:grailed.com newer_than:30d',     link: /grailed\.com\/listings\//i }
];

var MAX_THREADS = 15;   // per source, newest first
var MAX_LINKS = 8;      // sample links logged per message
var EXCERPT = 600;      // characters of plain text per message

/**
 * Survey what alert mail has actually arrived. Start here.
 * Logs one block per source: how many threads matched, then subject and date
 * for each, so we can tell a saved-search alert from a promotional blast.
 */
function inspectAlertMail() {
  MAIL_SOURCES.forEach(function (src) {
    Logger.log('================ ' + src.name + ' ================');
    Logger.log('query: ' + src.query);

    var threads;
    try { threads = GmailApp.search(src.query, 0, MAX_THREADS); }
    catch (e) { Logger.log('search failed: ' + e.message); return; }

    if (!threads.length) { Logger.log('no mail matched. Nothing has arrived yet.'); return; }
    Logger.log(threads.length + ' thread(s), newest first:');

    threads.forEach(function (t, i) {
      var m = t.getMessages()[t.getMessageCount() - 1];   // newest in thread
      Logger.log('  [' + i + '] ' + fmtDate(m.getDate()) + '  ' + m.getSubject());
      Logger.log('       from: ' + m.getFrom());
      Logger.log('       id:   ' + m.getId());
    });
  });
  Logger.log('');
  Logger.log('Next: pick an id above that looks like a saved-search alert and run');
  Logger.log('dumpMessage("that-id") to see how its listings are laid out.');
}

/**
 * Look inside one message. Pass an id from inspectAlertMail.
 * Logs the listing links and a plain-text excerpt, which is everything needed
 * to work out how to pull title, price and url out of this sender's template.
 */
function dumpMessage(id) {
  if (!id) { Logger.log('Pass a message id from inspectAlertMail, e.g. dumpMessage("18f...")'); return; }

  var m;
  try { m = GmailApp.getMessageById(id); }
  catch (e) { Logger.log('could not open that id: ' + e.message); return; }

  Logger.log('subject: ' + m.getSubject());
  Logger.log('from:    ' + m.getFrom());
  Logger.log('date:    ' + fmtDate(m.getDate()));

  var html = m.getBody() || '';
  Logger.log('html length: ' + html.length + ' chars');

  // Which source is this, so we know which link pattern counts as a listing.
  var src = null;
  MAIL_SOURCES.forEach(function (s) { if (m.getFrom().toLowerCase().indexOf(s.name.split(' ').pop().toLowerCase()) >= 0) src = s; });

  var hrefs = [];
  var re = /href\s*=\s*"([^"]+)"/gi, mm;
  while ((mm = re.exec(html)) !== null) hrefs.push(mm[1]);
  Logger.log('total links: ' + hrefs.length);

  var listing = src ? hrefs.filter(function (h) { return src.link.test(h); }) : [];
  Logger.log('listing links matching ' + (src ? src.link : 'n/a') + ': ' + listing.length);
  listing.slice(0, MAX_LINKS).forEach(function (h, i) {
    Logger.log('  [' + i + '] ' + h.slice(0, 220));
  });

  // Most alert mail wraps links through a click tracker, which hides the real
  // product url. If nothing matched, show a sample so we can see the wrapper.
  if (!listing.length && hrefs.length) {
    Logger.log('no direct listing links. Sample of what is there instead:');
    hrefs.slice(0, MAX_LINKS).forEach(function (h, i) { Logger.log('  [' + i + '] ' + h.slice(0, 220)); });
  }

  Logger.log('plain text excerpt:');
  Logger.log((m.getPlainBody() || '').replace(/\n{3,}/g, '\n\n').slice(0, EXCERPT));
}

function fmtDate(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
}
