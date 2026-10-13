// Fixtures for Slack message construction.
//
// Slack answers a malformed payload with HTTP 200 and simply renders nothing,
// so every failure here is silent: the job logs success, the channel stays
// empty, and nobody finds out until they go looking. These pin the limits that
// cause that, and the one behaviour that turns a silent failure into a loud one.
import assert from 'node:assert/strict';
import { header, section, context, divider, fields, table, message, post, money, signed } from '../src/lib/slack.mjs';

// --- limits ----------------------------------------------------------------

// Slack truncates a header past 150 characters and rejects a section past 3000.
const h = header('x'.repeat(400));
assert.ok(h.text.text.length <= 150, 'header must be clipped');
assert.equal(h.text.type, 'plain_text', 'headers do not accept mrkdwn');

const s = section('y'.repeat(5000));
assert.ok(s.text.text.length <= 2900, 'section must be clipped below the 3000 limit');

// Over 50 blocks is rejected outright, which would lose a whole digest.
const many = message('t', Array.from({ length: 200 }, () => divider()));
assert.ok(many.blocks.length <= 48, `expected <=48 blocks, got ${many.blocks.length}`);

// Slack caps a section at 10 fields and drops the rest.
assert.equal(fields(Array.from({ length: 30 }, (_, i) => [`k${i}`, i])).fields.length, 10);

// Falsy blocks come from optional sections; they must be dropped, not sent as
// nulls, which Slack rejects.
assert.equal(message('t', [header('a'), null, undefined, section('b')]).blocks.length, 2);

// Every message needs a plain `text`. Without it a phone shows an empty
// notification and screen readers get nothing.
const m = message('something happened', [header('Title')]);
assert.ok(m.text && m.text.length > 0, 'a message must carry fallback text');
assert.equal(m.unfurl_links, false, 'link previews would bury the content');

// --- tables ----------------------------------------------------------------

// Columns only line up in Slack's monospace font, which means a fenced block.
const t = table(
  [{ brand: 'Hermès', price: 23110, days: 326 }, { brand: 'The Row', price: 4365, days: 266 }],
  [{ key: 'brand', label: 'BRAND' }, { key: 'price', label: 'PRICE', align: 'right', fmt: money }, { key: 'days', label: 'DAYS', align: 'right' }]
);
assert.ok(t.text.text.startsWith('```') && t.text.text.endsWith('```'), 'tables must be fenced for monospace');
const lines = t.text.text.replace(/```/g, '').trim().split('\n');
assert.equal(lines.length, 3, 'header row plus one row per record');
// Every row padded to the same width is what alignment actually means.
assert.equal(new Set(lines.map(l => l.length)).size, 1, `rows must be equal width, got ${lines.map(l => l.length)}`);
// Right-aligned numbers end at the same column.
assert.ok(lines[1].includes('$23,110') && lines[2].includes('$4,365'));

assert.equal(table([], [{ key: 'a', label: 'A' }]), null, 'an empty table is no block at all, not an empty one');

// --- formatting ------------------------------------------------------------

assert.equal(money(23110.4), '$23,110');
assert.equal(money(null), '-');
assert.equal(signed(12), '+12%');
assert.equal(signed(-12), '-12%');

// --- delivery --------------------------------------------------------------

// This is the important one. Slack returns 200 with a body of "invalid_payload"
// for a malformed message, so checking only the status code reports success
// while nothing was posted.
let threw = false;
try {
  await post('https://hooks.example/x', message('t', [header('a')]),
    { fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'invalid_payload' }) });
} catch { threw = true; }
assert.ok(threw, 'a 200 carrying invalid_payload must be treated as a failure');

const ok = await post('https://hooks.example/x', message('t', [header('a')]),
  { fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'ok' }) });
assert.equal(ok, true, 'a genuine success must still succeed');

console.log('[test] slack: block limits, table alignment and silent-failure detection passed');
