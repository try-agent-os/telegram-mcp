// Console Phase 2 — short-lived signed session cookie for proxied service UIs.
//
// Why a cookie (not the Authorization: tma header Phase 1 uses): drilling INTO an
// embedded admin UI is a FULL-PAGE navigation (the webview points its location at
// /console/svc/dagu) plus dozens of asset/API/SSE sub-requests the browser issues
// itself. None of those can carry a custom Authorization header. So we do a
// one-time handoff: the SPA navigates to /console/svc/dagu/enter?initData=<raw>,
// we validate the initData ONCE (same owner-locked HMAC gate as everywhere else),
// then mint a short-lived HMAC-signed cookie. Every subsequent proxied request is
// gated by that cookie. The cookie is signed with the bot token (server secret),
// httpOnly, SameSite=Lax, and expires fast — it is a session bridge, not a
// long-lived credential.
//
// Threat model: forging the cookie requires the bot token (never leaves the
// server). The initData handoff is owner-locked and freshness-checked. A leaked
// cookie is owner-only and TTL-bounded. publicGuard still confines everything to
// /console*.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { validateInitData } from './auth.js';

// Minimal cookie parse/serialize for our single, server-controlled cookie. The
// value is a signed token of [0-9a-f.] only, so no escaping concerns; avoids a
// dependency on the untyped transitive `cookie` package.
function parseCookieHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function serializeCookieHeader(name: string, value: string, maxAgeSec: number, path: string): string {
  return [
    `${name}=${value}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Path=${path}`,
    `Max-Age=${maxAgeSec}`,
  ].join('; ');
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const OWNER_ID = Number(process.env.CONSOLE_OWNER_ID ?? '0');
// Service session lifetime. A drill-in session that stays open shouldn't expire
// mid-use; the owner lock is the real boundary. 1h matches the initData window.
const SVC_TTL_SEC = Number(process.env.CONSOLE_SVC_TTL ?? '3600');
export const SVC_COOKIE = 'console_svc';

function sign(payload: string): string {
  return createHmac('sha256', BOT_TOKEN || 'unset').update(payload).digest('hex');
}

/** Mint a signed cookie value: `<userId>.<expEpoch>.<hmac>`. */
export function mintSvcCookie(userId: number, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + SVC_TTL_SEC;
  const payload = `${userId}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

/** Validate a cookie value. Returns userId on success. */
export function verifySvcCookie(value: string, now = Date.now()): number | null {
  if (!BOT_TOKEN) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [userIdStr, expStr, mac] = parts;
  const payload = `${userIdStr}.${expStr}`;
  const expected = sign(payload);
  const a = Buffer.from(mac, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || Math.floor(now / 1000) > exp) return null;
  const userId = Number(userIdStr);
  if (!Number.isFinite(userId) || userId !== OWNER_ID) return null;
  return userId;
}

/**
 * Resolve an optional `to` deep-link param into a safe absolute path UNDER the
 * service base, defeating open-redirects. `to` is meant as a Dagu sub-route like
 * "/workers"; we only ever produce `<base><to>`, never an off-site or
 * off-service URL.
 *
 * Rejected (→ falls back to base): anything that isn't a plain rooted path. We
 * require `to` to start with a single '/', forbid a second leading slash
 * ("//evil.com" protocol-relative), forbid backslashes, control chars, any
 * "scheme:" prefix, and any ".." segment. Whitespace/percent-decoding tricks are
 * neutralised by decoding first and re-checking, then re-encoding nothing (we
 * pass the literal decoded path, which Express/Location handles).
 */
function safeDeepLink(base: string, to: unknown): string {
  if (typeof to !== 'string' || to.length === 0) return base;
  let dec = to;
  try {
    dec = decodeURIComponent(to);
  } catch {
    return base; // malformed percent-encoding → reject
  }
  // Must be a single-rooted, same-host path: "/something".
  if (!dec.startsWith('/')) return base;
  if (dec.startsWith('//') || dec.startsWith('/\\')) return base; // protocol-relative
  if (/[\\\x00-\x1f\x7f]/.test(dec)) return base; // backslash / control chars
  if (/^[a-z][a-z0-9+.-]*:/i.test(dec)) return base; // any "scheme:" sneaking in
  if (dec.split('/').some((seg) => seg === '..')) return base; // path traversal
  // Normalise: base is .../dagu (no trailing slash), dec begins with '/'.
  const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base;
  // If the caller already passed the full prefixed path, don't double-prefix.
  if (dec === trimmedBase || dec.startsWith(trimmedBase + '/')) return dec;
  return `${trimmedBase}${dec}`;
}

/**
 * Handler for /console/svc/<name>/enter?initData=<raw>[&to=/sub]. Validates the
 * initData (owner-locked, fresh), sets the signed cookie scoped to the service
 * path, then 302s into the embedded UI carrying the cookie. An optional `to`
 * deep-links to a service sub-route (e.g. /workers) — sanitised against
 * open-redirects so it can only ever land UNDER the service base.
 * `cookiePath` is the path the cookie is scoped to (e.g. /console/svc/dagu).
 * `redirectTo` is the default destination when no (or an unsafe) `to` is given.
 */
export function makeEnterHandler(cookiePath: string, redirectTo: string) {
  return (req: Request, res: Response): void => {
    const raw = typeof req.query.initData === 'string' ? req.query.initData : '';
    const result = validateInitData(raw);
    if (!result.ok || result.userId == null) {
      const code = result.reason === 'not_owner' ? 403 : 401;
      res.status(code).type('text/plain').send(
        code === 403 ? 'Access denied — single-user Console.' : 'Session invalid — reopen Console from Telegram.',
      );
      return;
    }
    const dest = safeDeepLink(redirectTo, req.query.to);
    const cookie = serializeCookieHeader(SVC_COOKIE, mintSvcCookie(result.userId), SVC_TTL_SEC, cookiePath);
    res.setHeader('Set-Cookie', cookie);
    res.redirect(302, dest);
  };
}

/**
 * Express middleware gating the proxied service routes: require a valid signed
 * service cookie. Mounted in front of the proxy. A request without a valid cookie
 * (e.g. a public tunnel hit, or an expired session) is 401'd before it ever
 * reaches the upstream service — the admin UI is never served unauthenticated.
 */
export function requireSvcCookie(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.cookie ?? '';
  const jar = parseCookieHeader(header);
  const value = jar[SVC_COOKIE];
  if (value && verifySvcCookie(value)) {
    next();
    return;
  }
  res.status(401).type('text/plain').send('Open this from the Console Mini App.');
}
