// Netlify copy of the Demand Desk, behind the byraph internal hub's login (internal.byraph.com).
//   /sso?t=<pass>&next=/path   the hub's sign-on pass -> our own 12-hour session cookie
//   /sso/logout?next=<hub url> drop our session, hand back to the hub (log out everywhere)
// Anyone else goes to the hub. No SSO_SECRET -> nothing is served. (GitHub Pages keeps the old
// public copy until it is switched off.)

import { verify, sign, now, readCookie, setCookie, clearCookie, safePath, TOOL_COOKIE, TOOL_SESSION_SECONDS } from '../shared/sso.mjs';

const TOOL_ID = 'demand';
const noStore = { 'Cache-Control': 'no-store' };

/* ---- link previews ----
   Everything here is behind the hub login, so anything fetching this URL to build a preview (a
   message, a Slack post) is turned away to the hub and shows the HUB's name and icon. That is why
   a calendar.byraph.com link previewed as "byraph internal" with the hub's magnifier: the preview
   was of the login page it was redirected to, not of this site at all.

   This hands those fetchers the tool's own title and picture, and nothing else. No content, no
   session, and no way in: it is a dead page carrying meta tags. /share.png is served to anyone
   for the same reason, and it is a generic card with no data on it.

   Matched on the user agent so that a person signed out still gets the same instant redirect they
   get today. A crawler not on this list simply sees what it sees now, which is the old behaviour,
   so a miss costs a nicer preview and nothing else. */
const CRAWLERS = /facebookexternalhit|Facebot|Twitterbot|Slackbot|LinkedInBot|WhatsApp|Discordbot|TelegramBot|Applebot|SkypeUriPreview|Embedly|redditbot|Mastodon|Pinterest|vkShare|Iframely|Google-InspectionTool/i;

const previewPage = (url, title, description) => {
  const image = `${url.origin}/share.png`;
  const tag = (k, v) => `<meta property="${k}" content="${v.replace(/"/g, '&quot;')}">`;
  const name = (k, v) => `<meta name="${k}" content="${v.replace(/"/g, '&quot;')}">`;
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${title}</title>
${tag('og:type', 'website')}${tag('og:site_name', 'byraph internal')}
${tag('og:title', title)}${tag('og:description', description)}
${tag('og:image', image)}${tag('og:image:width', '1200')}${tag('og:image:height', '1200')}
${tag('og:url', url.origin + '/')}
${name('twitter:card', 'summary_large_image')}${name('twitter:title', title)}
${name('twitter:description', description)}${name('twitter:image', image)}
${name('robots', 'noindex, nofollow')}
</head><body></body></html>`, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
};

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
  // The share picture, to anyone: a crawler has no cookie, and it carries no data.
  if (url.pathname === '/share.png') return context.next();

  // A link preview being built: the tool's own name and picture, instead of the hub's.
  if (CRAWLERS.test(request.headers.get('user-agent') || '')) {
    return previewPage(url, 'Demand Desk', 'Deal finder and market alerts. byraph internal, sign in to open it.');
  }

  if (url.pathname.startsWith('/data/')) return new Response('Login required', { status: 401, headers: noStore });
  return new Response(null, { status: 302, headers: { Location: `${hub}/go/${TOOL_ID}?next=${encodeURIComponent(url.pathname + url.search)}`, ...noStore } });
};

export const config = { path: '/*' };
