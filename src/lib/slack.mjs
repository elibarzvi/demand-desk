// Slack message construction.
//
// Everything here used to post `{ text }`, a single string of bullet points.
// Slack renders that as one undifferentiated column: a sharp observation about
// Chanel accelerating sat at exactly the same visual weight as the tenth row of
// a brand table, so the eye had nowhere to land and the whole thing read as
// noise. Block Kit gives headers, dividers and context their own weight, which
// is the entire difference between a wall and something scannable.
//
// Two rules the rest of the code depends on:
//
// Tables go in a code block. Slack renders those in a monospace font, which is
// the only way columns line up; the same rows as bullets do not align and a
// ten-brand table becomes unreadable.
//
// Every message still carries a plain `text`. Slack uses it for the notification
// preview and for screen readers, and a blocks-only payload shows up on a phone
// as an empty notification.

const HEADER_MAX = 150;    // Slack truncates headers past this
const SECTION_MAX = 2900;  // hard limit is 3000; leave room for the fences
const BLOCK_MAX = 48;      // hard limit is 50; leave room for a trailing context

export const header = text => ({ type: 'header', text: { type: 'plain_text', text: clip(text, HEADER_MAX), emoji: true } });
export const divider = () => ({ type: 'divider' });
export const section = text => ({ type: 'section', text: { type: 'mrkdwn', text: clip(text, SECTION_MAX) } });
export const context = text => ({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(text, SECTION_MAX) }] });

function clip(s, n) {
  const t = String(s ?? '');
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

// Up to ten short label/value pairs in two columns. Good for a handful of
// headline numbers, bad for anything long: Slack wraps fields unpredictably at
// narrow widths, so anything tabular belongs in `table` instead.
export function fields(pairs) {
  return {
    type: 'section',
    fields: pairs.slice(0, 10).map(([k, v]) => ({ type: 'mrkdwn', text: `*${k}*\n${v}` }))
  };
}

// A monospace table. `cols` is [{key, label, align, fmt}]. Columns are padded to
// their widest cell so they line up in Slack's code font.
export function table(rows, cols) {
  if (!rows.length) return null;
  const cells = rows.map(r => cols.map(c => String(c.fmt ? c.fmt(r[c.key], r) : (r[c.key] ?? ''))));
  const widths = cols.map((c, i) => Math.max(c.label.length, ...cells.map(r => r[i].length)));
  const pad = (s, i) => cols[i].align === 'right' ? s.padStart(widths[i]) : s.padEnd(widths[i]);
  const lines = [
    cols.map((c, i) => pad(c.label, i)).join('  '),
    ...cells.map(r => r.map(pad).join('  '))
  ];
  return section('```\n' + lines.join('\n').trimEnd() + '\n```');
}

export const money = n => n == null ? '-' : '$' + Math.round(Number(n)).toLocaleString('en-US');
export const signed = n => n == null ? '-' : (Number(n) > 0 ? '+' : '') + n + '%';

// Assemble a payload. `text` is the notification preview, not a duplicate of the
// body: it is what shows on a locked phone, so it should say what happened.
export function message(text, blocks) {
  const kept = blocks.filter(Boolean).slice(0, BLOCK_MAX);
  return { text: clip(text, 3000), blocks: kept, unfurl_links: false };
}

// Slack accepts a bad payload with a 200 and renders nothing, so a failed send
// is silent unless the response body is actually read.
export async function post(hook, payload, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl(hook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await r.text().catch(() => '');
  if (!r.ok || body.trim() !== 'ok') {
    throw new Error(`Slack HTTP ${r.status} ${body.slice(0, 200)}`);
  }
  return true;
}
