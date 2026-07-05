// Console HTTP wiring: a public guard + the /console SPA + /console/api/* behind
// the initData owner gate. Mounts onto the bot's existing Express app — no new
// process, no new port.
//
// SECURITY: the same Express :3848 also serves the MCP transport (/sse,
// /messages), /emergency, and /health. Once console.vasily.dev points at :3848,
// those must NOT be reachable from the public hostname. `publicGuard` enforces
// that: any request arriving via the cloudflared tunnel (Host = a non-loopback
// hostname, or carrying CF headers) may only touch /console*; everything else
// 404s. Local clients (Claude Code over http://localhost:3848, Host=localhost)
// are unaffected. NB: behind cloudflared the TCP peer is 127.0.0.1, so we gate
// on the Host header / CF markers, not on req.socket.remoteAddress.
import { resolve } from 'node:path';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { requireOwner } from './auth.js';
import { buildStatus } from './status.js';

// CommonJS output — __dirname is the runtime dir of this module.
// src/console/routes.ts -> dist/console/routes.js; the static frontend lives at
// <telegram-mcp>/console-web (two levels up from dist/console).
const CONSOLE_WEB = resolve(__dirname, '../../console-web');

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export function isTunnelRequest(req: Request): boolean {
  const host = (req.headers.host ?? '').split(':')[0].toLowerCase();
  const viaCf = Boolean(req.headers['cf-connecting-ip'] || req.headers['cf-ray']);
  return viaCf || (host !== '' && !LOOPBACK_HOSTS.has(host));
}

/**
 * Mounted FIRST on the app. Requests from the public tunnel may only reach
 * /console*; all other paths (/sse, /messages, /emergency, /health) 404 for
 * them. Local requests pass through untouched.
 */
export function publicGuard(req: Request, res: Response, next: NextFunction): void {
  if (isTunnelRequest(req) && !req.path.startsWith('/console')) {
    res.status(404).end();
    return;
  }
  next();
}

export function mountConsole(app: Express): void {
  // API (owner-gated). Defined before static so /console/api/* is never shadowed.
  app.get('/console/api/status', requireOwner, async (_req: Request, res: Response) => {
    try {
      const payload = await buildStatus();
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: 'status_failed', detail: (err as Error).message });
    }
  });

  // SPA shell at /console and /console/ — served explicitly (200, no 301
  // redirect to a trailing slash, which would otherwise confuse the webview).
  // The shell is harmless without valid initData (every data call 401s), so it
  // is intentionally public.
  const sendShell = (_req: Request, res: Response) => res.sendFile(resolve(CONSOLE_WEB, 'index.html'));
  app.get('/console', sendShell);
  app.get('/console/', sendShell);
  // Any future static assets (index disabled so it never issues the redirect).
  app.use('/console', express.static(CONSOLE_WEB, { index: false, fallthrough: true }));

  console.log(`[console] mounted: GET /console (static ${CONSOLE_WEB}) + /console/api/status (owner-gated)`);
}
