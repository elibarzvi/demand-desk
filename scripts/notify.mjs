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

function build() {
  const alerts = readJson(path.join(DERIVED, 'alerts.json'), { alerts: [] });
  const latest = latestSnapshot();
  if (!latest) return null;
  const prevSnap = previousSnapshot(latest.date);
  const prevKeys = new Set((previousAlerts()?.alerts || []).map(key));

  const lines = [];

  // 1. Alerts worth surfacing: a breakout has already cleared both significance
  //    and magnitude gates in derive.mjs, so anything left is real. Chronic
  //    staleness is dropped. Only conditions that are NEW today are sent, so an
  //    ongoing situation is not re-announced every morning.
  for (const a of alerts.alerts || []) {
    if (a.type === 'stale-source' && CHRONIC.has(a.series)) continue;
    if (a.type === 'weekly-move' && a.severity === 'low') continue;
    if (prevKeys.has(key(a))) continue;
    if (a.severity === 'high' || a.type === 'breakout' || a.type === 'stale-source') lines.push(a.message);
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

  // 4. Sell-through sanity. These are impossible or implausible readings that
  //    indicate broken state rather than a busy sales day.
  const st = latest.sources?.fp_sell_through;
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

  return lines.length ? { date: latest.date, lines } : null;
}

async function main() {
  const hook = process.env.SLACK_WEBHOOK_URL;
  const payload = build();

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
  console.log(r.ok ? `[notify] sent ${payload.lines.length} item(s)` : `[notify] Slack rejected the post: HTTP ${r.status}`);
}

// Never let notification trouble fail the capture.
main().catch(e => console.log('[notify] skipped after error:', e.message));
