// Statistics for turning a daily log into something you can act on.
//
// With 24+ days of history the useful question stops being "what is the number
// today" and becomes "is today unusual for this series". Everything here answers
// that: a rolling baseline, a z-score against it, direction streaks, and a
// day-of-week factor so a predictable Monday restock is not misread as a trend.

export const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

export function stdev(a) {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
}

export function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const pct = (from, to) => (from == null || to == null || from === 0) ? null : +(((to - from) / Math.abs(from)) * 100).toFixed(2);

// Longest run of consecutive same-direction moves ending at the last point.
// Returns a signed count: +3 means three consecutive rises. Flat days end a run,
// because "unchanged" is not momentum.
export function streak(values) {
  const v = values.filter(x => x != null);
  if (v.length < 2) return 0;
  let dir = 0, n = 0;
  for (let i = v.length - 1; i > 0; i--) {
    const d = Math.sign(v[i] - v[i - 1]);
    if (d === 0) break;
    if (dir === 0) { dir = d; n = 1; }
    else if (d === dir) n++;
    else break;
  }
  return dir * n;
}

// Multiplicative day-of-week factor: how this weekday typically compares to the
// series average. Needs at least MIN_DOW observations of that weekday or it
// returns null rather than a factor built on one or two data points.
const MIN_DOW = 3;
export function dowFactor(points, weekday) {
  const all = points.map(p => p.value).filter(v => v != null);
  const base = mean(all);
  if (!base) return null;
  const sameDay = points.filter(p => new Date(p.date + 'T00:00:00Z').getUTCDay() === weekday && p.value != null).map(p => p.value);
  if (sameDay.length < MIN_DOW) return null;
  return +(mean(sameDay) / base).toFixed(3);
}

// Full metric bundle for one series. `points` is [{date, value}] ascending.
// `window` bounds the baseline; z-scores need MIN_BASELINE points or stay null,
// so a series does not get flagged as anomalous on three days of history.
const MIN_BASELINE = 7;
export function describe(points, window = 28) {
  const clean = points.filter(p => p.value != null);
  if (!clean.length) return null;

  const values = clean.map(p => p.value);
  const last = values[values.length - 1];
  const lastDate = clean[clean.length - 1].date;

  // Baseline excludes today, so today is scored against its own history rather
  // than against a window it is already inside.
  const prior = values.slice(-1 - window, -1);
  const bMean = prior.length >= MIN_BASELINE ? mean(prior) : null;
  const bSd = prior.length >= MIN_BASELINE ? stdev(prior) : null;
  const z = (bMean != null && bSd) ? +((last - bMean) / bSd).toFixed(2) : null;

  const at = back => values.length > back ? values[values.length - 1 - back] : null;

  return {
    last,
    lastDate,
    n: values.length,
    prev: at(1),
    dodPct: pct(at(1), last),
    wowPct: pct(at(7), last),
    changePct: pct(values[0], last),
    min: Math.min(...values),
    max: Math.max(...values),
    baselineMean: bMean != null ? +bMean.toFixed(2) : null,
    baselineSd: bSd != null ? +bSd.toFixed(2) : null,
    z,
    streak: streak(values),
    dowFactor: dowFactor(clean, new Date(lastDate + 'T00:00:00Z').getUTCDay())
  };
}
