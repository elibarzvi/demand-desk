// Single sign-on for byraph's internal tools. Plain JS + Web Crypto, so it runs in Netlify edge
// functions (Deno) and functions (Node) alike. The SAME file lives in every tool
// (byraph-hub, comp-tool, ...); keep the copies identical.
//
// One login happens on the hub. To open a tool, the hub signs a short-lived pass (60 s) for that
// tool; the tool checks the signature with the shared SSO_SECRET and sets its own session cookie.
// Tokens: base64url(JSON payload) + "." + base64url(HMAC-SHA256(SSO_SECRET, payload)).

const enc = new TextEncoder();

const toB64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));

const keyFor = (secret) => crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export const HANDOFF_SECONDS = 60;
export const TOOL_SESSION_SECONDS = 12 * 3600; // a tool re-checks with the hub at least twice a day
export const HUB_SESSION_SECONDS = 7 * 24 * 3600;
export const TOOL_COOKIE = 'byraph_session';
export const HUB_COOKIE = 'byraph_hub';

export async function sign(payload, secret) {
  const body = toB64u(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await keyFor(secret), enc.encode(body));
  return `${body}.${toB64u(sig)}`;
}

// The payload if the token is genuine, unexpired, of this type and for this audience; else null.
export async function verify(token, secret, { aud, typ }) {
  if (!token || !secret || typeof token !== 'string') return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await keyFor(secret), fromB64u(sig), enc.encode(body));
    if (!ok) return null;
    const p = JSON.parse(new TextDecoder().decode(fromB64u(body)));
    if (p.aud !== aud || p.typ !== typ || !(p.exp > Date.now() / 1000) || typeof p.u !== 'string') return null;
    return p;
  } catch {
    return null;
  }
}

export const now = () => Math.floor(Date.now() / 1000);

export function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export const setCookie = (name, value, maxAge) => `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
export const clearCookie = (name) => `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

// Only send people back to a path on this site (no open redirects).
export const safePath = (p) => (typeof p === 'string' && p.startsWith('/') && !p.startsWith('//') ? p : '/');
