// Posts genuinely notable changes to Slack as the "Demand Desk" app.
//
// Delivery deliberately lives here rather than in an agent that reads the data
// later: the pipeline has already decided what is unusual, so the notification is
// mechanical, fires the moment a capture lands, and reads as coming from the
// service rather than from a person's own account.
//
// Silence is a valid, meaningful outcome. This sends nothing on a normal day.
// Requires SLACK_WEBHOOK_URL; without it the script no-ops so local runs and
// forks stay quiet. It never fails the build: a broken notifier must not cost
// the day's capture.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { ROOT, latestSnapshot, previousSnapshot } from '../src/lib/util.mjs';

const DERIVED = path.join(ROOT, 'data', 'derived');
const SITE = 'https://elibarzvi.github.io/demand-desk/';

// Sources that sit still by design. Mirror is an editorial feed and search volume
// is a monthly figure refreshed weekly, so both would otherwise fire a
// high-severity staleness alert every single day and train the reader to ignore
// the channel. They still matter in one direction: if either starts moving again
// after a freeze, that is real news and is reported as a recovery below.
const CHRONIC = new Set(['mirror', 'search_volume']);

function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

// Yesterday's alerts come from git rather than a state file: derive runs before
// the commit step, so HEAD still holds the previous day's version.
function previousAlerts() {
  try {
    const out = execFileSync('git', ['show', 'HEAD:data/derived/alerts.json'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out);
  } catch { return null; }
}

const key = a => `${a.type}|${a.series}|${a.brand ?? ''}`;

// The workflow captures three times a day, and values sitting near a threshold
// cross back and forth between runs. Comparing only against the previous
// alerts.json let the same condition re-announce itself each time, which is how
// the alert channel got three messages for 2026-08-29 alone. A cooldown records
// what has actually been sent and stays quiet on it for a few days.
const COOLDOWN_DAYS = 3;
const SENT_FILE = path.join(ROOT, 'data', 'state', 'notified.json');

function readSent() {
  try { return JSON.parse(fs.readFileSync(SENT_FILE, 'utf8')); } catch { return {}; }
}
function writeSent(map) {
  try {
    fs.mkdirSync(path.dirname(SENT_FILE), { recursive: true });
    fs.writeFileSync(SENT_FILE, JSON.stringify(map, null, 2) + '\n');
  } catch (e) { console.log('[notify] could not persist cooldown state:', e.message); }
}
const daysApart = (a, b) => Math.abs(Math.round((new Date(b) - new Date(a)) / 86400000));

// A bare model name is ambiguous; prepend the brand unless it already carries it.
const modelLabel = (model, brand) => {
  if (!brand) return model;
  const norm = t => t.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return norm(model).includes(norm(brand)) ? model : `${brand} ${model}`;
};

function build() {
  const alerts = readJson(path.join(DERIVED, 'alerts.json'), { alerts: [] });
  const latest = latestSnapshot();
  if (!latest) return null;
  const prevSnap = previousSnapshot(latest.date);
  const prevKeys = new Set((previousAlerts()?.alerts || []).map(key));
  const sent = readSent();
  const sentNow = {};

  const lines = [];

  // 1. Alerts worth surfacing: a breakout has already cleared both significance
  //    and magnitude gates in derive.mjs, so anything left is real. Chronic
  //    staleness is dropped. Only conditions that are NEW today are sent, so an
  //    ongoing situation is not re-announced every morning.
  for (const a of alerts.alerts || []) {
    if (a.type === 'stale-source' && CHRONIC.has(a.series)) continue;
    if (a.type === 'weekly-move' && a.severity === 'low') continue;
    if (prevKeys.has(key(a))) continue;
    const sentOn = sent[key(a)];
    if (sentOn && daysApart(sentOn, latest.date) < COOLDOWN_DAYS) continue;
    if (a.severity === 'high' || a.type === 'breakout' || a.type === 'stale-source') {
      lines.push(a.message);
      sentNow[key(a)] = latest.date;
    }
  }

  // 2. Recoveries: a source that had frozen has started changing again.
  const fresh = latest.capture?.freshness || {};
  const prevFresh = prevSnap?.capture?.freshness || {};
  for (const [name, f] of Object.entries(fresh)) {
    const before = prevFresh[name];
    if (before && (before.unchangedDays ?? 0) >= 3 && (f.unchangedDays ?? 0) === 0) {
      lines.push(`RECOVERED: "${name}" is publishing new data again after ${before.unchangedDays} static days.`);
    }
  }

  // 3. Pipeline health. A silently broken capture looks identical to a calm
  //    market from the outside, which is the failure worth catching early.
  const fp = latest.sources?.fashionphile;
  if (fp && (fp.status === 'error' || fp.status === 'partial')) {
    lines.push(`Fashionphile capture is ${fp.status}${fp.segmentErrors ? `: ${fp.segmentErrors.join('; ')}` : ''}.`);
  }
  const prevErrs = new Set((prevSnap?.capture?.errors || []).map(e => e.source));
  for (const e of latest.capture?.errors || []) {
    if (!prevErrs.has(e.source)) lines.push(`New capture error from ${e.source}: ${e.error}`);
  }

  const st = latest.sources?.fp_sell_through;

  // 4. First real sell-through. Not an anomaly but a milestone: the day the SKU
  //    diff first has a prior day to compare against is the day this dataset
  //    starts existing, and it is worth saying once, from the app rather than
  //    from a person's own account.
  if (st?.status === 'ok' && prevSnap?.sources?.fp_sell_through?.status === 'baseline') {
    const brands = Object.entries(st.brands || {}).filter(([, v]) => (v.departures ?? 0) > 0);
    const totalSold = brands.reduce((a, [, v]) => a + v.departures, 0);
    const top = brands.sort((a, b) => (b[1].turnoverPct ?? 0) - (a[1].turnoverPct ?? 0)).slice(0, 3)
      .map(([b, v]) => `${b} ${v.departures} sold (${v.turnoverPct}%${v.medianDaysToSell != null ? `, median ${v.medianDaysToSell}d` : ''})`);
    lines.push(`FIRST SELL-THROUGH DATA: ${totalSold} items cleared across ${brands.length} brands. ${top.join('; ')}.`);

    const models = Object.entries(st.byModel || {}).sort((a, b) => b[1].sold - a[1].sold).slice(0, 4);
    if (models.length) lines.push(`Top models: ${models.map(([m, v]) => `${modelLabel(m, v.brand)} ${v.sold}${v.medianDaysToSell != null ? ` (${v.medianDaysToSell}d)` : ''}`).join(', ')}.`);
  }

  // 5. Sell-through sanity. These are impossible or implausible readings that
  //    indicate broken state rather than a busy sales day.
  if (st?.status === 'ok') {
    const brands = Object.entries(st.brands || {});
    if (brands.length && brands.every(([, v]) => (v.departures ?? 0) === 0)) {
      lines.push('Sell-through returned zero departures for every brand while reporting status ok. The SKU diff has probably broken.');
    }
    for (const [b, v] of brands) {
      if (v.turnoverPct != null && v.turnoverPct > 10) lines.push(`${b} turnover of ${v.turnoverPct}% in one day is implausible and suggests a data problem.`);
      if (v.departures != null && v.live != null && v.departures > v.live) lines.push(`${b} reports ${v.departures} departures against ${v.live} live listings, which is impossible.`);
    }
  }

  return lines.length ? { date: latest.date, lines, sent, sentNow } : null;
}

async function main() {
  const hook = process.env.SLACK_WEBHOOK_URL;
  // `--test` proves the Slack wiring end to end. Without it there is no way to
  // tell a correctly silent day from a broken webhook, since both look identical
  // from the outside: no message arrives either way.
  const isTest = process.argv.includes('--test');
  const payload = isTest
    ? { date: new Date().toISOString().slice(0, 10), lines: ['Delivery test. If you can read this, alerts are wired correctly and you will only hear from this app when something is actually unusual.'] }
    : build();

  if (!payload) { console.log('[notify] nothing notable today, staying silent'); return; }
  if (!hook) { console.log(`[notify] SLACK_WEBHOOK_URL not set, would have sent:\n  ${payload.lines.join('\n  ')}`); return; }

  const text = `*Demand Desk, ${payload.date}*\n`
    + payload.lines.map(l => `• ${l}`).join('\n')
    + `\n<${SITE}|Open the dashboard>`;

  const r = await fetch(hook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, unfurl_links: false })
  });
  // Only record the cooldown once Slack has actually accepted the message, so a
  // failed post is retried tomorrow rather than silently suppressed for days.
  if (r.ok && payload.sentNow) {
    const merged = { ...payload.sent, ...payload.sentNow };
    const cutoff = new Date(payload.date); cutoff.setDate(cutoff.getDate() - 30);
    for (const [k, d] of Object.entries(merged)) if (new Date(d) < cutoff) delete merged[k];
    writeSent(merged);
  }
  console.log(r.ok ? `[notify] sent ${payload.lines.length} item(s)` : `[notify] Slack rejected the post: HTTP ${r.status}`);
}

// Never let notification trouble fail the capture.
main().catch(e => console.log('[notify] skipped after error:', e.message));
