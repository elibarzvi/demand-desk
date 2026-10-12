// Netlify copy of the Demand Desk, behind the byraph internal hub's login (internal.byraph.com).
//   /sso?t=<pass>&next=/path   the hub's sign-on pass -> our own 12-hour session cookie
//   /sso/logout?next=<hub url> drop our session, hand back to the hub (log out everywhere)
// Anyone else goes to the hub. No SSO_SECRET -> nothing is served. (GitHub Pages keeps the old
// public copy until it is switched off.)

import { verify, sign, now, readCookie, setCookie, clearCookie, safePath, TOOL_COOKIE, TOOL_SESSION_SECONDS } from '../shared/sso.mjs';

const TOOL_ID = 'demand';
const noStore = { 'Cache-Control': 'no-store' };

export default async (request, context) => {
  const url = new URL(request.url);
  const secret = Netlify.env.get('SSO_SECRET') || '';
  const hub = (Netlify.env.get('HUB_URL') || 'https://internal.byraph.com').replace(/\/$/, '');
  if (secret.length < 32) return new Response('Site locked: SSO_SECRET is not set.', { status: 503 });

  if (url.pathname === '/sso') {
    const pass = await verify(url.searchParams.get('t'), secret, { aud: TOOL_ID, typ: 'handoff' });
    if (!pass) return new Response(`<!doctype html><meta charset="utf-8"><title>Sign-on failed</title><body style="font:15px system-ui;margin:15vh auto;max-width:420px"><h2>Sign-on pass not accepted</h2><p>It expired, or this tool and the hub are set up with different secrets.</p><p><a href="${hub}/go/${TOOL_ID}">Try again</a> · <a href="${hub}/">Back to the hub</a></p>`, { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8', ...noStore } });
    const session = await sign({ typ: 'session', u: pass.u, aud: TOOL_ID, exp: now() + TOOL_SESSION_SECONDS }, secret);
    return new Response(null, { status: 302, headers: { Location: safePath(url.searchParams.get('next')), 'Set-Cookie': setCookie(TOOL_COOKIE, session, TOOL_SESSION_SECONDS), ...noStore } });
  }
  if (url.pathname === '/sso/logout') {
    const next = url.searchParams.get('next') || '';
    return new Response(null, { status: 302, headers: { Location: next.startsWith(hub + '/') ? next : `${hub}/login?out=1`, 'Set-Cookie': clearCookie(TOOL_COOKIE), ...noStore } });
  }

  if (await verify(readCookie(request, TOOL_COOKIE), secret, { aud: TOOL_ID, typ: 'session' })) return context.next();
  if (url.pathname.startsWith('/data/')) return new Response('Login required', { status: 401, headers: noStore });
  return new Response(null, { status: 302, headers: { Location: `${hub}/go/${TOOL_ID}?next=${encodeURIComponent(url.pathname + url.search)}`, ...noStore } });
};

export const config = { path: '/*' };
