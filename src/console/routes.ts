// Console HTTP wiring: a public guard + the /console SPA + /console/api/* behind
// the initData owner gate. Mounts onto the bot's existing Express app — no new
// process, no new port.
//
// SECURITY: the same Express :3848 also serves the MCP transport (/sse,
// /messages), /emergency, and /health. Once the Console public URL points at :3848,
// those must NOT be reachable from the public hostname. `publicGuard` enforces
// that: any request arriving via the cloudflared tunnel (Host = a non-loopback
// hostname, or carrying CF headers) may only touch /console*; everything else
// 404s. Local clients (Claude Code over http://localhost:3848, Host=localhost)
// are unaffected. NB: behind cloudflared the TCP peer is 127.0.0.1, so we gate
// on the Host header / CF markers, not on req.socket.remoteAddress.
import { resolve } from 'node:path';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { requireOwner } from './auth.js';
import { buildStatus, mapDaguStatus } from './status.js';
import { listAgents } from './peers.js';
import {
  daguConfigured,
  fetchDagList,
  fetchDagDetail,
  fetchDagRuns,
  fetchWorkers,
  type DagRun,
} from './dagu.js';
import { createDaguProxy, daguProxyConfigured, DAGU_CONSOLE_PREFIX } from './proxy.js';
import { makeEnterHandler, requireSvcCookie } from './svc-session.js';
import { komodoGatewayConfigured } from './komodo.js';
import {
  makeKomodoEnterHandler,
  makeKomodoRedeemHandler,
  KOMODO_CONSOLE_PREFIX,
} from './komodo-session.js';
import { updateConsoleUrl } from './menu-button.js';

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
  // POST /console/internal/tunnel-url — LOOPBACK-ONLY callback used by an
  // optional quick-tunnel sidecar (e.g. a cloudflared watch script) to hand
  // the freshly-issued *.trycloudflare.com URL to the bot so it can (re)register
  // the chat menu button WITHOUT a restart (the quick-tunnel URL changes on every
  // cloudflared restart). The path is under /console, so publicGuard lets it
  // pass — we MUST reject tunnel-origin requests here explicitly so the public
  // can never rewrite the menu button.
  app.post('/console/internal/tunnel-url', (req: Request, res: Response) => {
    if (isTunnelRequest(req)) {
      res.status(404).end();
      return;
    }
    const body = req.body as { url?: unknown } | undefined;
    const url = typeof body?.url === 'string' ? body.url.trim() : '';
    if (!updateConsoleUrl(url)) {
      res.status(400).json({ error: 'invalid_url', detail: 'expected a public https URL' });
      return;
    }
    console.log(`[console] tunnel URL updated via loopback callback -> ${url}`);
    res.json({ ok: true, url });
  });

  // API (owner-gated). Defined before static so /console/api/* is never shadowed.
  // Cache-Control: no-store so Telegram's webview never serves a stale response.
  app.get('/console/api/status', requireOwner, async (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    try {
      const payload = await buildStatus();
      res.json(payload);
    } catch (err) {
      res.status(500).json({ error: 'status_failed', detail: (err as Error).message });
    }
  });

  // GET /console/api/agents → live Claude Code agent sessions (claude-peers).
  app.get('/console/api/agents', requireOwner, async (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    try {
      const agents = await listAgents();
      res.json({ agents, generatedAt: new Date().toISOString() });
    } catch (err) {
      res.status(500).json({ error: 'agents_failed', detail: (err as Error).message });
    }
  });

  // --- Dagu native sub-views (read-only) -----------------------------------
  // Owner-gated JSON the Console SPA renders as native tgui lists, so workflows
  // and workers display in-app without drilling into the embedded Dagu SPA.

  // GET /console/api/dagu/dags → normalized DAG list.
  app.get('/console/api/dagu/dags', requireOwner, async (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!daguConfigured()) {
        res.status(500).json({ error: 'dagu_unconfigured', detail: 'DAGU_AUTH_BASIC_* not set' });
        return;
      }
      const data = await fetchDagList();
      const dags = (data.dags ?? []).map((d) => ({
        name: d.dag?.name ?? d.fileName ?? 'unknown',
        fileName: d.fileName ?? null,
        status: mapDaguStatus(d.latestDAGRun?.statusLabel),
        statusLabel: d.latestDAGRun?.statusLabel ?? null,
        finishedAt: d.latestDAGRun?.finishedAt ?? null,
        suspended: Boolean(d.suspended),
      }));
      res.json({ dags });
    } catch (err) {
      res.status(500).json({ error: 'dagu_dags_failed', detail: (err as Error).message });
    }
  });

  // GET /console/api/dagu/dags/:name → detail: recent runs + latest run steps.
  app.get('/console/api/dagu/dags/:name', requireOwner, async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!daguConfigured()) {
        res.status(500).json({ error: 'dagu_unconfigured', detail: 'DAGU_AUTH_BASIC_* not set' });
        return;
      }
      const name = String(req.params.name);
      // Detail (incl latest run) + run history fan out in parallel; either may
      // be empty/unavailable without failing the whole response.
      const [detail, runsRes] = await Promise.all([
        fetchDagDetail(name).catch(() => null),
        fetchDagRuns(name).catch(() => ({ dagRuns: [] as DagRun[] })),
      ]);
      if (!detail && (!runsRes.dagRuns || runsRes.dagRuns.length === 0)) {
        res.status(404).json({ error: 'dagu_dag_not_found', detail: name });
        return;
      }
      const latest = detail?.latestDAGRun;
      const runs = (runsRes.dagRuns ?? []).slice(0, 20).map((r) => ({
        id: r.dagRunId ?? null,
        status: mapDaguStatus(r.statusLabel),
        statusLabel: r.statusLabel ?? null,
        startedAt: r.startedAt ?? null,
        finishedAt: r.finishedAt ?? null,
      }));
      const steps = (latest?.nodes ?? []).map((n) => ({
        name: n.step?.name ?? 'step',
        status: mapDaguStatus(n.statusLabel),
        statusLabel: n.statusLabel ?? null,
        startedAt: n.startedAt ?? null,
        finishedAt: n.finishedAt ?? null,
      }));
      res.json({
        name: detail?.dag?.name ?? name,
        description: detail?.dag?.description ?? null,
        suspended: Boolean(detail?.suspended),
        latestRun: latest
          ? {
              id: latest.dagRunId ?? null,
              status: mapDaguStatus(latest.statusLabel),
              statusLabel: latest.statusLabel ?? null,
              startedAt: latest.startedAt ?? null,
              finishedAt: latest.finishedAt ?? null,
            }
          : null,
        steps,
        runs,
      });
    } catch (err) {
      res.status(500).json({ error: 'dagu_dag_failed', detail: (err as Error).message });
    }
  });

  // GET /console/api/dagu/workers → normalized worker list.
  app.get('/console/api/dagu/workers', requireOwner, async (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!daguConfigured()) {
        res.status(500).json({ error: 'dagu_unconfigured', detail: 'DAGU_AUTH_BASIC_* not set' });
        return;
      }
      const data = await fetchWorkers();
      const workers = (data.workers ?? []).map((w) => ({
        id: w.id ?? 'unknown',
        host: w.labels?.host ?? null,
        os: w.labels?.os ?? null,
        healthStatus: w.healthStatus ?? 'unknown',
        busyPollers: w.busyPollers ?? 0,
        totalPollers: w.totalPollers ?? 0,
        lastHeartbeatAt: w.lastHeartbeatAt ?? null,
        runningCount: Array.isArray(w.runningTasks) ? w.runningTasks.length : 0,
      }));
      res.json({ workers });
    } catch (err) {
      res.status(500).json({ error: 'dagu_workers_failed', detail: (err as Error).message });
    }
  });

  // SPA shell at /console and /console/ — served explicitly (200, no 301
  // redirect to a trailing slash, which would otherwise confuse the webview).
  // The shell is harmless without valid initData (every data call 401s), so it
  // is intentionally public.
  const sendShell = (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(resolve(CONSOLE_WEB, 'index.html'));
  };
  app.get('/console', sendShell);
  app.get('/console/', sendShell);

  // --- Phase 2: drill-in reverse proxy to the Dagu admin UI ----------------
  // Flow: the SPA navigates the webview to /console/svc/dagu/enter?initData=<raw>;
  // we validate the owner initData ONCE and mint a short-lived signed cookie
  // scoped to /console/svc/dagu, then 302 into the Dagu UI. Every subsequent
  // proxied request (SPA assets, /api/v1, SSE) is gated by that cookie and gets a
  // server-side Authorization: Basic header injected — so Dagu loads already
  // authenticated, with no second login, and is unreachable without the cookie.
  //
  // These routes MUST be registered before the /console static handler below so
  // express.static does not shadow the proxied sub-paths. They sit under
  // /console, so publicGuard (which only allows /console* through the tunnel)
  // permits them; the cookie gate is the real auth boundary for the proxy.
  if (daguProxyConfigured()) {
    // /enter is NOT cookie-gated (it mints the cookie); it validates initData.
    app.get(`${DAGU_CONSOLE_PREFIX}/enter`, makeEnterHandler(DAGU_CONSOLE_PREFIX, DAGU_CONSOLE_PREFIX));
    // Everything else under the prefix → cookie gate → reverse proxy (auth injected).
    app.use(DAGU_CONSOLE_PREFIX, requireSvcCookie, createDaguProxy());
    console.log(`[console] Dagu drill-in proxy mounted at ${DAGU_CONSOLE_PREFIX} (cookie-gated, basic-auth injected)`);
  } else {
    console.warn('[console] Dagu drill-in proxy NOT mounted (DAGU_AUTH_BASIC_* unset)');
  }

  // --- Phase 2: Komodo TG-login gateway (localStorage bootstrap) ------------
  // Unlike Dagu (cookie + proxy), Komodo keeps its session JWT in localStorage,
  // so we can't proxy it. Instead /enter validates owner initData, logs into
  // Komodo, and returns a one-time bootstrap page that seeds localStorage via
  // /redeem. Both routes sit under /console so publicGuard lets them through the
  // tunnel; the owner gate + one-time HMAC ticket are the real auth boundary.
  // They MUST be registered before the /console static handler below.
  // NB: for the localStorage write to land on the right origin, the SPA points
  // these at https://<your-console-domain>/... — wiring up that origin to :3848 is the
  // pending cloudflared ingress change (see the gateway design doc).
  if (komodoGatewayConfigured()) {
    app.get(`${KOMODO_CONSOLE_PREFIX}/enter`, makeKomodoEnterHandler());
    app.post(`${KOMODO_CONSOLE_PREFIX}/redeem`, makeKomodoRedeemHandler());
    console.log(`[console] Komodo TG-login gateway mounted at ${KOMODO_CONSOLE_PREFIX} (enter+redeem, owner-gated, one-time ticket)`);
  } else {
    console.warn('[console] Komodo TG-login gateway NOT mounted (KOMODO_GATEWAY_USER/PASS unset)');
  }

  // Console SPA static assets last (index disabled so it never issues a redirect).
  app.use('/console', express.static(CONSOLE_WEB, { index: false, fallthrough: true }));

  console.log(`[console] mounted: GET /console (static ${CONSOLE_WEB}) + /console/api/{status,agents,dagu/{dags,dags/:name,workers}} (owner-gated)`);
}
