// Console Phase 2 — Komodo TG-login gateway (localStorage bootstrap).
//
// Why this differs from the Dagu drill-in (svc-session.ts): Dagu authenticates
// via a cookie + an injected Authorization header, so a reverse proxy can carry
// the session. Komodo does NOT — its web app keeps the session JWT in
// localStorage (key `mogh-auth-tokens-v1`), never in a cookie (verified against
// the live bundle: zero document.cookie, no Set-Cookie on login). A proxy cannot
// write another origin's localStorage, so a cookie/proxy handoff is impossible.
//
// Instead we do a Mini-App bootstrap. Flow (after the cloudflared cutover routes
// <your-console-domain>/console/svc/komodo/.* to this :3848 process):
//
//   1. Console SPA (on <your-console-domain>) navigates the webview to
//      https://<your-console-domain>/console/svc/komodo/enter?initData=<raw>.
//      The ABSOLUTE <your-console-domain> origin is mandatory: localStorage is
//      per-origin and the Komodo SPA only reads it from its own origin.
//   2. /enter validates initData ONCE (same owner-locked HMAC gate as
//      everywhere), logs in to Komodo as the gateway user (komodoLogin), and
//      stashes the fresh JWT server-side under a random one-time ticket. It
//      returns a tiny bootstrap HTML carrying ONLY the ticket — never the JWT.
//   3. The bootstrap page (now on <your-console-domain> origin) POSTs the ticket to
//      /console/svc/komodo/redeem, which returns the JWT exactly once (the
//      ticket is consumed) and only in the response body — never in a URL/log.
//   4. The page writes { current, tokens:[{user_id, jwt}] } into
//      localStorage['mogh-auth-tokens-v1'] and location.replace('/') → the
//      Komodo SPA boots already authenticated.
//
// Threat model: /enter is owner-locked + freshness-checked (forging needs the
// bot token, which never leaves the server). The ticket is HMAC-signed, single
// use, and TTL-bounded (CONSOLE_KOMODO_TICKET_TTL, default 60s). The JWT itself
// touches the wire only as the redeem response body. publicGuard still confines
// everything to /console*.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { validateInitData } from './auth.js';
import { komodoLogin as defaultKomodoLogin } from './komodo.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
// One-time ticket lifetime. The bootstrap redeem happens within a single page
// load right after /enter, so this only needs to outlive a redirect + fetch.
const TICKET_TTL_SEC = Number(process.env.CONSOLE_KOMODO_TICKET_TTL ?? '60');

export const KOMODO_CONSOLE_PREFIX = '/console/svc/komodo';
// Komodo web app's localStorage session key (verified against bundle v2.2.0).
const STORAGE_KEY = 'mogh-auth-tokens-v1';

interface TicketEntry {
  jwt: string;
  userId: string;
  exp: number; // epoch seconds
}

// In-process one-time ticket store. Lives only in the bot process; a restart
// drops pending tickets (harmless — the user just re-taps Komodo). Tickets are
// short-lived and consumed on first redeem.
const tickets = new Map<string, TicketEntry>();

function sign(payload: string): string {
  return createHmac('sha256', BOT_TOKEN || 'unset').update(payload).digest('hex');
}

function pruneExpired(nowSec: number): void {
  for (const [id, e] of tickets) {
    if (e.exp < nowSec) tickets.delete(id);
  }
}

/**
 * Store {jwt,userId} under a random id and return an HMAC-signed ticket value
 * `<id>.<expEpoch>.<hmac>`. The JWT stays server-side; only the opaque ticket is
 * handed out.
 */
export function mintTicket(jwt: string, userId: string, now = Date.now()): string {
  const nowSec = Math.floor(now / 1000);
  pruneExpired(nowSec);
  const id = randomBytes(18).toString('hex');
  const exp = nowSec + TICKET_TTL_SEC;
  tickets.set(id, { jwt, userId, exp });
  const payload = `${id}.${exp}`;
  return `${payload}.${sign(payload)}`;
}

/**
 * Verify + consume a ticket. Returns {jwt,userId} on the first valid redeem,
 * null thereafter (one-time), on a bad/tampered signature, or once expired.
 */
export function redeemTicket(value: string, now = Date.now()): { jwt: string; userId: string } | null {
  if (!BOT_TOKEN) return null;
  const parts = value.split('.');
  if (parts.length !== 3) return null;
  const [id, expStr, mac] = parts;
  const payload = `${id}.${expStr}`;
  const a = Buffer.from(mac, 'hex');
  const b = Buffer.from(sign(payload), 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const exp = Number(expStr);
  const nowSec = Math.floor(now / 1000);
  if (!Number.isFinite(exp) || nowSec > exp) return null;
  const entry = tickets.get(id);
  if (!entry) return null; // unknown or already consumed
  tickets.delete(id); // one-time: consume regardless of outcome below
  if (nowSec > entry.exp) return null;
  return { jwt: entry.jwt, userId: entry.userId };
}

/**
 * Build the localStorage value the Komodo SPA expects:
 *   { current: <userId>, tokens: [ { user_id: <userId>, jwt: <jwt> } ] }
 * Pure + exported so the exact shape is unit-tested.
 */
export function buildAuthTokensObject(userId: string, jwt: string): {
  current: string;
  tokens: { user_id: string; jwt: string }[];
} {
  return { current: userId, tokens: [{ user_id: userId, jwt }] };
}

// Escape a string for safe embedding inside an inline <script>. The ticket is
// only [0-9a-f.], but we go through JSON.stringify + neutralise the few byte
// sequences that can break out of a script context, as defence-in-depth.
function scriptSafe(value: string): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * The one-time bootstrap page. Served from the <your-console-domain> origin, it
 * redeems the ticket for the JWT, seeds localStorage and lands on the Komodo
 * dashboard. The JWT never appears here — only the ticket does.
 */
export function buildBootstrapHtml(ticket: string): string {
  const t = scriptSafe(ticket);
  const redeemPath = scriptSafe(`${KOMODO_CONSOLE_PREFIX}/redeem`);
  const key = scriptSafe(STORAGE_KEY);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Signing in…</title>
<style>body{font:16px -apple-system,system-ui,sans-serif;color:#8a949e;background:#17212b;margin:0;display:flex;height:100vh;align-items:center;justify-content:center;text-align:center;padding:1rem}</style>
</head>
<body>
<div id="msg">Signing in to Komodo…</div>
<script>
(async () => {
  try {
    const res = await fetch(${redeemPath}, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket: ${t} }),
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('redeem ' + res.status);
    const { jwt, userId } = await res.json();
    if (!jwt || !userId) throw new Error('bad payload');
    const obj = { current: userId, tokens: [{ user_id: userId, jwt: jwt }] };
    localStorage.setItem(${key}, JSON.stringify(obj));
    location.replace('/');
  } catch (e) {
    document.getElementById('msg').textContent = 'Komodo login failed — reopen from Telegram.';
  }
})();
</script>
</body>
</html>`;
}

/**
 * GET /console/svc/komodo/enter?initData=<raw>. Validates owner initData, logs
 * into Komodo, mints a one-time ticket and returns the bootstrap HTML. `login`
 * is injectable for tests; defaults to the real komodoLogin.
 *   - missing/stale initData → 401
 *   - valid signature, wrong user → 403
 *   - upstream Komodo login failure → 502
 */
export function makeKomodoEnterHandler(
  login: () => Promise<{ jwt: string; userId: string }> = defaultKomodoLogin,
) {
  return async (req: Request, res: Response): Promise<void> => {
    const raw = typeof req.query.initData === 'string' ? req.query.initData : '';
    const result = validateInitData(raw);
    if (!result.ok || result.userId == null) {
      const code = result.reason === 'not_owner' ? 403 : 401;
      res
        .status(code)
        .type('text/plain')
        .send(
          code === 403
            ? 'Access denied — single-user Console.'
            : 'Session invalid — reopen Console from Telegram.',
        );
      return;
    }
    let creds: { jwt: string; userId: string };
    try {
      creds = await login();
    } catch (err) {
      console.error(`[console][komodo] gateway login failed: ${(err as Error).message}`);
      res.status(502).type('text/plain').send('Komodo login failed upstream — try again.');
      return;
    }
    const ticket = mintTicket(creds.jwt, creds.userId);
    res.set('Cache-Control', 'no-store');
    res.status(200).type('text/html').send(buildBootstrapHtml(ticket));
  };
}

/**
 * POST /console/svc/komodo/redeem  { ticket }. Returns { jwt, userId } once.
 * Auth is the ticket itself (HMAC-signed, owner-bound at mint, single use), so
 * no initData is needed — the bootstrap page has none.
 *   - no ticket → 400
 *   - invalid/expired/used ticket → 401
 */
export function makeKomodoRedeemHandler() {
  return (req: Request, res: Response): void => {
    const ticket = typeof req.body?.ticket === 'string' ? req.body.ticket : '';
    if (!ticket) {
      res.status(400).json({ error: 'no_ticket' });
      return;
    }
    const out = redeemTicket(ticket);
    if (!out) {
      res.status(401).json({ error: 'invalid_or_used_ticket' });
      return;
    }
    res.set('Cache-Control', 'no-store');
    res.json({ jwt: out.jwt, userId: out.userId });
  };
}
